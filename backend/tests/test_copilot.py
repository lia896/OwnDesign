"""Design copilot API tests. OpenAI is replaced by a fake client: no network call, no cost."""

import json
from types import SimpleNamespace

import pytest

from app.main import app
from app.routes.consultant import DAILY_MESSAGE_CAP, get_openai
from tests.conftest import needs_supabase
from tests.test_copilot_engine import ROOM

pytestmark = needs_supabase

MOVE_SOFA = {"type": "move_object", "object_id": "sofa", "x": 260, "y": 320, "rotation": None, "w": None, "d": None}


def model_reply(actions=(MOVE_SOFA,)):
    return json.dumps(
        {
            "summary": "The path to the window is tight.",
            "observations": [{"id": "o1", "type": "issue", "severity": "medium", "title": "Tight path", "description": "60 cm only.", "object_ids": ["sofa"]}],
            "recommendations": [{"id": "r1", "title": "Shift the sofa", "description": "40 cm left.", "actions": list(actions)}],
        }
    )


class FakeOpenAI:
    def __init__(self):
        self.calls = []
        self.fail = False
        self.reply = model_reply()
        self.responses = SimpleNamespace(create=self._create)

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        if self.fail:
            raise RuntimeError("boom")
        return SimpleNamespace(output_text=self.reply)


@pytest.fixture()
def fake():
    client = FakeOpenAI()
    app.dependency_overrides[get_openai] = lambda: client
    yield client
    app.dependency_overrides.pop(get_openai, None)


@pytest.fixture(scope="module")
def world(api, make_user):
    designer, client, stranger_designer = (make_user(p) for p in ("cpd", "cpc", "cps"))
    studio = api.post("/v1/studios", json={"name": "Copilot Studio"}, headers=designer.headers).json()["data"]
    api.post("/v1/studios", json={"name": "Other Studio"}, headers=stranger_designer.headers)
    body = {"studio_id": studio["id"], "name": "Flat", "property_type": "existing"}
    project = api.post("/v1/projects", json=body, headers=client.headers).json()["data"]
    api.put(f"/v1/projects/{project['id']}/brief", json={"styles": ["japandi"], "needs": "reading corner"}, headers=client.headers)
    return SimpleNamespace(designer=designer, client=client, stranger=stranger_designer, project=project)


def url(world, path="messages"):
    return f"/v1/projects/{world.project['id']}/copilot/{path}"


def ask(api, world, user, **body):
    return api.post(url(world), json={"message": "Analyse the layout", "geometry": ROOM, **body}, headers=user.headers)


def latest_no(api, world):
    versions = api.get(f"/v1/projects/{world.project['id']}/versions", headers=world.designer.headers).json()["data"]
    return versions[0]["version_no"] if versions else None


def test_reply_is_structured_checked_and_stored(api, world, fake):
    response = ask(api, world, world.designer, scope={"kind": "room", "id": "r1"})
    assert response.status_code == 201
    question, answer = response.json()["data"]
    assert question["payload"] == {"scope": {"kind": "room", "id": "r1"}}
    rec = answer["payload"]["recommendations"][0]
    assert rec["applicable"] and rec["actions"] == [{"type": "move_object", "object_id": "sofa", "x": 260, "y": 320}]

    call = fake.calls[-1]
    assert call["text"]["format"]["strict"] is True
    context = call["input"][0]["content"]
    assert context.startswith("<plan_context>") and '"bounds_cm"' in context and "reading corner" in context

    shown = api.get(url(world), headers=world.designer.headers).json()["data"]
    assert [m["role"] for m in shown][-2:] == ["user", "assistant"] and shown[-1]["payload"]["summary"]
    # The consultant chat page does not show copilot turns.
    chat = api.get(f"/v1/projects/{world.project['id']}/consultant/messages", headers=world.designer.headers).json()["data"]
    assert all(m["content"] != "Analyse the layout" for m in chat)


def test_unsafe_suggestion_is_marked_not_applicable(api, world, fake):
    fake.reply = model_reply([{**MOVE_SOFA, "x": 300, "y": 230}])  # onto the coffee table
    rec = ask(api, world, world.designer).json()["data"][1]["payload"]["recommendations"][0]
    assert not rec["applicable"] and rec["problems"]


def test_unusable_model_output_is_502_and_not_stored(api, world, fake):
    fake.reply = "not json"
    before = len(api.get(url(world), headers=world.designer.headers).json()["data"])
    assert ask(api, world, world.designer).status_code == 502
    after = api.get(url(world), headers=world.designer.headers).json()["data"]
    assert len(after) == before + 1 and after[-1]["role"] == "user"  # the slot stays used


def test_openai_failure_is_502_without_details(api, world, fake):
    fake.fail = True
    response = ask(api, world, world.designer)
    assert response.status_code == 502 and "boom" not in response.text


@pytest.mark.parametrize(
    "body",
    [
        {"message": ""},
        {"message": "x" * 2001},
        {"scope": {"kind": "room"}},
        {"scope": {"kind": "galaxy", "id": "r1"}},
        {"geometry": {"schema": 1}},
        {"extra": True},
    ],
)
def test_invalid_questions_are_rejected(api, world, fake, body):
    assert ask(api, world, world.designer, **body).status_code == 422
    assert fake.calls == []


def test_unknown_scope_target_is_422(api, world, fake):
    assert ask(api, world, world.designer, scope={"kind": "object", "id": "ghost"}).status_code == 422
    assert fake.calls == []


def test_outsiders_cannot_ask_or_read(api, world, fake):
    assert ask(api, world, world.stranger).status_code == 404
    assert api.get(url(world), headers=world.stranger.headers).status_code == 404
    assert api.post(url(world), json={"message": "hi", "geometry": ROOM}).status_code == 401
    # The designer's thread is private to the designer.
    assert all(m["content"] != "Analyse the layout" for m in api.get(url(world), headers=world.client.headers).json()["data"])


def apply_body(api, world, **overrides):
    return {"base_version_no": latest_no(api, world), "label": "Shift sofa", "actions": [{"type": "move_object", "object_id": "sofa", "x": 260, "y": 320}], "geometry": ROOM, **overrides}


def test_designer_applies_a_change_as_a_new_version(api, world):
    before = latest_no(api, world)
    response = api.post(url(world, "apply"), json=apply_body(api, world), headers=world.designer.headers)
    assert response.status_code == 201
    data = response.json()["data"]
    assert data["version_no"] == (before or 0) + 1 and data["author_role"] == "designer"
    sofa = next(item for item in data["geometry"]["furniture"] if item["id"] == "sofa")
    assert (sofa["x"], sofa["y"]) == (260, 320)


def test_stale_base_version_is_409(api, world):
    body = apply_body(api, world)
    assert api.post(url(world, "apply"), json=body, headers=world.designer.headers).status_code == 201
    # Same base again: the plan was saved since, so the change must not land on top.
    assert api.post(url(world, "apply"), json=body, headers=world.designer.headers).status_code == 409


def test_client_cannot_apply(api, world):
    assert api.post(url(world, "apply"), json=apply_body(api, world), headers=world.client.headers).status_code == 403


def test_outsider_cannot_apply(api, world):
    assert api.post(url(world, "apply"), json=apply_body(api, world), headers=world.stranger.headers).status_code == 404


@pytest.mark.parametrize(
    "actions",
    [
        [],
        [{"type": "move_object", "object_id": "ghost", "x": 1, "y": 1}],
        [{"type": "move_object", "object_id": "sofa", "x": 300, "y": 230}],  # onto the table
        [{"type": "delete_wall", "object_id": "w1"}],
        [{"type": "move_object", "object_id": "sofa", "x": 1, "y": 1}] * 21,
    ],
)
def test_bad_changes_are_refused(api, world, actions):
    before = latest_no(api, world)
    response = api.post(url(world, "apply"), json=apply_body(api, world, actions=actions), headers=world.designer.headers)
    assert response.status_code == 422
    assert latest_no(api, world) == before


def test_copilot_shares_the_daily_cap(api, world, fake, admin):
    convo = admin.table("ai_conversations").select("id").eq("project_id", world.project["id"]).eq("user_id", world.designer.id).execute().data[0]["id"]
    have = len(admin.table("ai_messages").select("id").eq("conversation_id", convo).eq("role", "user").execute().data)
    filler = [{"conversation_id": convo, "role": "user", "content": "filler"}] * max(DAILY_MESSAGE_CAP - have, 0)
    if filler:
        admin.table("ai_messages").insert(filler).execute()
    assert ask(api, world, world.designer).status_code == 429 and fake.calls == []
    # The chat page shares the same limit.
    chat = api.post(f"/v1/projects/{world.project['id']}/consultant/messages", json={"message": "hi"}, headers=world.designer.headers)
    assert chat.status_code == 429


def test_suspended_studio_blocks_copilot(api, world, fake, admin):
    studio_id = world.project["studio_id"]
    admin.table("studios").update({"status": "suspended"}).eq("id", studio_id).execute()
    try:
        assert ask(api, world, world.designer).status_code == 403
        assert api.post(url(world, "apply"), json=apply_body(api, world), headers=world.designer.headers).status_code == 403
    finally:
        admin.table("studios").update({"status": "active"}).eq("id", studio_id).execute()
