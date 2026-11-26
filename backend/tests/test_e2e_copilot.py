"""Browser tests of the design copilot panel in the editor.

The model is never called: the copilot question is answered in the browser with a fixed reply. Applying a
suggestion goes to the real backend, which checks it again and saves a new plan version.
"""

import json

import pytest

from tests.test_e2e_design import MARKUP, servers, sign_in, studio, world  # noqa: F401 (fixtures)
from tests.test_e2e_design import pytestmark as design_marks

pytestmark = [*design_marks, pytest.mark.usefixtures("servers")]

TITLE = "Pull the sofa clear of the door"
REPLY = {
    "summary": "The sofa sits in the door swing.",
    "observations": [
        {"id": "o1", "type": "issue", "severity": "high", "title": "Door blocked", "description": MARKUP, "object_ids": ["f1"]},
        {"id": "o2", "type": "insight", "severity": "low", "title": "Good light", "description": "Seating faces the window.", "object_ids": []},
    ],
    "recommendations": [
        {"id": "r1", "title": TITLE, "description": "Move it 180 cm to the right.", "actions": [{"type": "move_object", "object_id": "f1", "x": 250, "y": 200}], "applicable": True, "problems": []},
        {"id": "r2", "title": MARKUP, "description": "Not possible.", "actions": [{"type": "move_object", "object_id": "f1", "x": 0, "y": 0}], "applicable": False, "problems": ["sofa (f1) blocks the swing of door o1"]},
    ],
}


def answer_in_browser(page, posts):
    """Answers every copilot question here, so no request reaches the model."""

    def handle(route):
        if route.request.method != "POST":
            return route.continue_()
        body = json.loads(route.request.post_data)
        posts.append(body)
        turns = [
            {"role": "user", "content": body["message"], "payload": {"scope": body["scope"]}, "created_at": "2026-11-26T09:00:00Z"},
            {"role": "assistant", "content": REPLY["summary"], "payload": REPLY, "created_at": "2026-11-26T09:00:01Z"},
        ]
        route.fulfill(status=201, content_type="application/json", body=json.dumps({"success": True, "data": turns}))

    page.route("**/copilot/messages", handle)


def open_copilot(page, user, pid):
    sign_in(page, user, f"editor.html?project={pid}")
    page.get_by_role("button", name="AI Copilot").click()
    page.get_by_role("heading", name="Plan review").wait_for()


def test_designer_reviews_previews_and_applies_a_suggestion(page, api, world):
    posts = []
    answer_in_browser(page, posts)
    open_copilot(page, world.designer, world.pid)
    assert page.locator("#copilot-context").inner_text() == "Analysing: 1 room · 1 furniture item"
    assert page.locator("#copilot-counter").inner_text() == "0 / 2000"
    assert page.locator("#copilot-send").is_disabled()

    page.get_by_role("button", name="Analyse the current layout").click()
    page.get_by_role("heading", name=TITLE).wait_for()
    assert posts[0]["scope"] == {"kind": "project", "id": None} and posts[0]["geometry"]["furniture"][0]["id"] == "f1"

    # Model text is shown as text, never run as markup.
    assert page.evaluate("window.__xss") is None
    assert page.get_by_text(MARKUP).count() >= 1
    blocked = page.locator(".rec.blocked")
    assert blocked.locator("button", has_text="Apply").count() == 0 and "blocks the swing" in blocked.inner_text()

    # Preview shows the change on the canvas and blocks editing until it ends.
    page.get_by_role("button", name="Preview").first.click()
    page.locator("#ai-preview").wait_for()
    assert page.locator("#canvas .item.changed").count() == 1 and page.locator("#canvas .ghost").count() == 1
    page.keyboard.press("Escape")
    page.locator("#ai-preview").wait_for(state="hidden")

    page.get_by_role("button", name="Apply").click()
    page.get_by_text("Saved · v2").wait_for()
    latest = api.get(f"{world.base}/versions/latest", headers=world.designer.headers).json()["data"]
    sofa = latest["geometry"]["furniture"][0]
    assert (latest["version_no"], sofa["x"], sofa["y"]) == (2, 250, 200) and latest["label"] == f"Copilot: {TITLE}"
    assert page.get_by_role("heading", name=TITLE).count() == 0  # an applied card goes away

    # Undo goes back to the earlier plan, as an unsaved edit.
    page.get_by_role("button", name="Undo").click()
    page.get_by_text("Unsaved changes").wait_for()


def test_selection_sets_the_scope(page, world):
    posts = []
    answer_in_browser(page, posts)
    open_copilot(page, world.designer, world.pid)
    page.locator('#canvas [data-kind="furniture"]').first.focus()
    scope = page.get_by_label("Context")
    scope.select_option("object")
    assert page.locator("#copilot-context").inner_text().startswith("Analysing: Sofa · 200 cm × 90 cm")
    page.get_by_label("Ask the copilot").fill("Is this sofa too big?")
    page.get_by_role("button", name="Ask").click()
    page.get_by_role("heading", name=TITLE).wait_for()
    assert posts[-1]["scope"] == {"kind": "object", "id": "f1"} and posts[-1]["message"] == "Is this sofa too big?"


def test_client_can_preview_but_not_apply(page, world):
    answer_in_browser(page, [])
    open_copilot(page, world.client, world.pid)
    assert "Only the studio's designers can apply" in page.locator("#copilot-note").inner_text()
    page.get_by_role("button", name="Suggest improvements").click()
    page.get_by_role("heading", name=TITLE).wait_for()
    assert page.locator(".rec button", has_text="Apply").count() == 0
    assert page.get_by_role("button", name="Preview").count() == 2


def test_dismissed_card_is_removed(page, world):
    answer_in_browser(page, [])
    open_copilot(page, world.designer, world.pid)
    page.get_by_role("button", name="Analyse the current layout").click()
    page.get_by_role("button", name=f"Dismiss {TITLE}").click()
    assert page.get_by_role("heading", name=TITLE).count() == 0
