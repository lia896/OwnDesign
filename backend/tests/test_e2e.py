"""Browser test of the critical journey (PRD acceptance scenarios 1, 2 and 6):

a guest follows a studio link, builds a plan, is asked to register before it can be
saved, registers, and the saved geometry survives a reload and is visible to the designer.

Starts the backend and the static frontend itself unless they are already running.
"""

import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

from tests.conftest import needs_supabase, unique_email

BACKEND = Path(__file__).resolve().parents[1]
FRONTEND = BACKEND.parent / "frontend"
SITE = "http://127.0.0.1:5500"

pytestmark = [
    needs_supabase,
    pytest.mark.skipif(not (FRONTEND / "js" / "config.js").exists(), reason="frontend/js/config.js missing"),
]


def _listening(port: int) -> bool:
    with socket.socket() as probe:
        probe.settimeout(0.3)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def _serve(port: int, command: list[str], cwd: Path):
    if _listening(port):
        return None
    process = subprocess.Popen(command, cwd=cwd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + 30
    while not _listening(port):
        if process.poll() is not None or time.monotonic() > deadline:
            process.kill()
            raise RuntimeError(f"Could not start server on port {port}")
        time.sleep(0.2)
    return process


@pytest.fixture(scope="module")
def servers():
    started = [
        _serve(8000, [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000"], BACKEND),
        _serve(5500, [sys.executable, "-m", "http.server", "5500", "--bind", "127.0.0.1"], FRONTEND),
    ]
    yield
    for process in started:
        if process:
            process.terminate()
            process.wait(timeout=10)  # or the next module could find the dying server still listening


def metric(page, name: str) -> str:
    return page.locator(f"[data-metric={name}]").inner_text().strip()


def overflows(page) -> bool:
    return page.evaluate("document.documentElement.scrollWidth > window.innerWidth")


def test_guest_builds_plan_registers_and_saves(servers, page, api, make_user):
    designer = make_user("e2e-designer")
    studio = api.post("/v1/studios", json={"name": "E2E Studio"}, headers=designer.headers).json()["data"]
    client_email = unique_email("e2e-client")
    walls = page.locator("#canvas [data-kind=walls]")
    furniture = page.locator("#canvas [data-kind=furniture]")

    # Guest arrives through the studio link and sees the studio's name.
    page.goto(f"{SITE}/entry.html?studio={studio['slug']}")
    page.get_by_role("heading", name="Plan your home with E2E Studio.").wait_for()
    assert page.locator("#entry-kind").inner_text() == "Studio link"
    page.get_by_role("link", name="Start designing").click()

    # Wizard: two default rooms -> eight walls on the canvas.
    page.get_by_label("Project name").fill("E2E Flat")
    page.get_by_role("button", name="Generate 2D canvas").click()
    page.wait_for_url("**/editor.html")
    walls.first.wait_for(state="attached")
    assert walls.count() == 8

    # Place a sofa in the middle of the canvas.
    box = page.locator("#canvas").bounding_box()
    page.keyboard.press("f")
    page.locator("#catalog button[data-type=sofa]").click()
    page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    assert furniture.count() == 1
    # The same can be done without a pointer: choose from the catalog and press Enter to place it.
    page.keyboard.press("f")
    page.locator("#catalog button[data-type=chair]").press("Enter")
    page.keyboard.press("Enter")
    assert furniture.count() == 2

    # The 3D walkthrough walks the draft: the outer wall stops the walker, and W does not reach the wall tool.
    page.get_by_role("button", name="3D walkthrough").click()
    page.locator("#walk canvas[data-position]").wait_for()
    page.keyboard.down("w")
    stopped = page.locator("#walk canvas[data-position$=',30']")  # an attribute wait: the page's CSP forbids eval
    stopped.wait_for()
    page.wait_for_timeout(500)
    page.keyboard.up("w")
    assert stopped.count() == 1
    # Saving still works here: a guest is asked for an account.
    page.keyboard.press("Control+s")
    page.get_by_role("heading", name="Create an account to save your plan").wait_for()
    page.get_by_role("button", name="Not now").click()
    page.keyboard.press("Escape")
    page.locator("#walk").wait_for(state="hidden")
    assert page.locator("#tool-name").inner_text() == "Select and move"
    assert (walls.count(), furniture.count()) == (8, 2)

    # Scenario 1: a guest cannot persist; saving asks for an account.
    page.locator("#save").click()
    page.get_by_role("heading", name="Create an account to save your plan").wait_for()
    page.get_by_role("link", name="Create account").click()
    page.get_by_label("Email").fill(client_email)
    page.get_by_label("Password").fill("e2e-Password-123")
    page.get_by_role("button", name="Create account").click()

    # Back in the editor with the draft intact; the save dialog opens by itself.
    page.get_by_label("Version note (optional)").fill("first draft")
    page.keyboard.press("Enter")  # Enter in the note field saves (it must not act as Cancel)
    page.wait_for_url("**/editor.html?project=*")
    walls.first.wait_for(state="attached")
    page.get_by_text("Saved · v1").wait_for()
    assert (walls.count(), furniture.count()) == (8, 2)

    # Scenario 2: move the sofa, save again, reload -> geometry and history are preserved.
    furniture.first.focus()
    page.keyboard.press("ArrowRight")
    page.get_by_text("Unsaved changes").wait_for()
    page.locator("#save").click()
    page.get_by_role("button", name="Save version").click()
    page.get_by_text("Saved · v2").wait_for()
    # Dismissing the dialog with Escape must not save again.
    page.keyboard.press("Control+s")
    page.get_by_role("heading", name="Save a new version").wait_for()
    page.keyboard.press("Escape")
    page.get_by_role("heading", name="Save a new version").wait_for(state="hidden")
    # Selecting something without moving it is not a change.
    furniture.first.focus()
    page.wait_for_timeout(500)
    assert page.locator("#status-save").inner_text() == "Saved · v2"
    page.reload()
    walls.first.wait_for(state="attached")
    assert (walls.count(), furniture.count()) == (8, 2)
    assert page.locator(".version").count() == 2

    # Scenario 6: the studio's designer sees the client's project and its latest plan.
    project_id = page.url.split("project=")[1]
    seen = api.get(f"/v1/projects/{project_id}", headers=designer.headers).json()["data"]
    assert (seen["name"], seen["client_email"], seen["my_role"]) == ("E2E Flat", client_email, "designer")
    versions = api.get(f"/v1/projects/{project_id}/versions", headers=designer.headers).json()["data"]
    assert [(v["version_no"], v["author_role"], v["label"]) for v in versions] == [(2, "client", ""), (1, "client", "first draft")]
    first = api.get(f"/v1/projects/{project_id}/versions/{versions[1]['id']}", headers=designer.headers).json()["data"]["geometry"]
    latest = api.get(f"/v1/projects/{project_id}/versions/latest", headers=designer.headers).json()["data"]["geometry"]
    assert latest["furniture"][0]["x"] == first["furniture"][0]["x"] + 10
    assert latest["walls"] == first["walls"]


def test_designer_opens_studio_invites_and_revises_client_plan(servers, page, api, make_user):
    from tests.test_geometry import VALID

    # A new designer signs up through the UI and gets a studio with its own link.
    page.goto(f"{SITE}/auth.html?mode=signup&role=studio")
    page.get_by_label("Studio name").fill("Atelier E2E")
    page.get_by_label("Email").fill(unique_email("e2e-owner"))
    page.get_by_label("Password").fill("e2e-Password-123")
    page.get_by_role("button", name="Create account").click()
    page.wait_for_url("**/studio.html")
    page.get_by_role("heading", name="Atelier E2E").wait_for()
    studio_url = page.get_by_label("Studio link").input_value()
    slug = studio_url.split("studio=")[1]
    assert studio_url.startswith(f"{SITE}/entry.html?studio=atelier-e2e-")
    # A new studio has nothing yet: every metric is zero and the directory shows its empty state.
    assert [metric(page, name) for name in ("projects", "clients", "pending-invites", "new-this-month")] == ["0"] * 4
    page.get_by_text("No projects yet").wait_for()

    # Personal invite: appears as pending, and its link resolves publicly to this studio.
    page.get_by_label("Client name").fill("Dana Client")
    page.get_by_label("Client email").fill("dana@example.com")
    page.get_by_role("button", name="Create invite link").click()
    page.get_by_role("cell", name="Pending").wait_for()
    assert metric(page, "pending-invites") == "1"

    # A client of this studio saves a plan (through the API, as the editor would).
    client = make_user("e2e-invited")
    studio = api.get(f"/v1/studios/by-slug/{slug}").json()["data"]
    project = api.post(
        "/v1/projects", json={"studio_id": studio["id"], "name": "Dana's flat", "property_type": "new_build"}, headers=client.headers
    ).json()["data"]
    assert api.post(f"/v1/projects/{project['id']}/versions", json={"geometry": VALID}, headers=client.headers).status_code == 201

    # The designer finds it on the dashboard, opens it, revises it and saves a designer version.
    # A second project that was created but never saved has no plan to draw.
    unsaved = "Penthouse" + "W" * 50
    api.post("/v1/projects", json={"studio_id": studio["id"], "name": unsaved, "property_type": "existing"}, headers=client.headers)

    page.reload()
    card = page.get_by_role("article", name="Dana's flat")
    card.get_by_text(client.email).wait_for()
    card.scroll_into_view_if_needed()  # a plan preview is fetched when its card comes into view
    card.locator("svg.thumb").wait_for(state="attached")
    page.get_by_role("article", name=unsaved).locator(".thumb.empty").wait_for(state="attached")
    assert [metric(page, name) for name in ("projects", "clients", "new-this-month")] == ["2", "1", "2"]
    page.locator("#activity li").filter(has_text="Dana's flat").first.wait_for()

    # The search box narrows the directory in the browser.
    search = page.get_by_label("Search projects")
    search.fill("no such project")
    page.get_by_text("No projects match").wait_for()
    assert card.is_hidden()
    search.fill("dana")
    card.wait_for()
    assert page.get_by_role("article", name=unsaved).is_hidden()
    search.fill("")

    # A long unbroken project name must not push the page sideways on a phone.
    page.set_viewport_size({"width": 390, "height": 800})
    assert not overflows(page)
    page.set_viewport_size({"width": 1280, "height": 720})

    card.get_by_role("link", name="Launch 2D canvas").click()
    page.get_by_text("Editing as designer").wait_for()
    page.locator("#canvas [data-kind=furniture]").first.focus()
    page.keyboard.press("r")
    page.locator("#save").click()
    page.get_by_label("Version note (optional)").fill("rotated the sofa")
    page.get_by_role("button", name="Save version").click()
    page.get_by_text("Saved · v2").wait_for()
    page.get_by_text("v2 · designer").wait_for()

    # The client sees the designer's revision, labelled as such, and the original is untouched.
    versions = api.get(f"/v1/projects/{project['id']}/versions", headers=client.headers).json()["data"]
    assert [(v["version_no"], v["author_role"]) for v in versions] == [(2, "designer"), (1, "client")]
    latest = api.get(f"/v1/projects/{project['id']}/versions/latest", headers=client.headers).json()["data"]["geometry"]
    assert latest["furniture"][0]["rotation"] == 90

    # The dashboard's activity feed records the designer's save.
    page.goto(f"{SITE}/studio.html")
    page.locator("#activity li").filter(has_text="designer").first.wait_for()


def test_client_portal_entry_points(servers, page, api, make_user):
    designer = make_user("e2e-portal")
    # Markup in a studio name is shown as text, and a long unbroken word must not widen the page.
    name = ("<i>Studio</i> " + "Supercalifragilistic" * 4)[:80]
    studio = api.post("/v1/studios", json={"name": name}, headers=designer.headers).json()["data"]
    invite = api.post(
        f"/v1/studios/{studio['id']}/invites",
        json={"client_name": "Noa Levi", "client_email": "noa@example.com"},
        headers=designer.headers,
    ).json()["data"]

    # A personal invite greets the client by name.
    page.goto(f"{SITE}/entry.html?invite={invite['token']}")
    page.get_by_role("heading", name=f"Hi Noa Levi, plan your home with {name}.").wait_for()
    assert page.locator("#entry-kind").inner_text() == "Personal invitation"
    assert page.locator("h1 i").count() == 0
    page.set_viewport_size({"width": 390, "height": 800})
    assert not overflows(page)
    page.set_viewport_size({"width": 1280, "height": 720})

    # Skipping the wizard opens the editor on an empty plan.
    page.get_by_role("button", name="Open a blank canvas").click()
    page.wait_for_url("**/editor.html")
    page.locator("#canvas").wait_for()
    assert page.locator("#canvas [data-kind=walls]").count() == 0

    # With a draft in the browser, a blank canvas asks before replacing it. Declining keeps the draft.
    page.goto(f"{SITE}/entry.html?invite={invite['token']}")
    page.get_by_text("You have an unsaved plan in this browser").wait_for()
    page.get_by_role("button", name="Open a blank canvas").click()  # Playwright dismisses the confirm by default
    page.wait_for_timeout(300)
    assert "entry.html" in page.url
    page.once("dialog", lambda dialog: dialog.accept())
    page.get_by_role("button", name="Open a blank canvas").click()
    page.wait_for_url("**/editor.html")

    # Unknown, malformed and missing links all end on the same message, never on an error.
    for query in ("?studio=no-such-studio-000000", "?invite=short", "?invite=" + "x" * 32, ""):
        page.goto(f"{SITE}/entry.html{query}")
        page.get_by_role("heading", name="This link is not valid").wait_for()
        assert page.get_by_role("link", name="Start designing").count() == 0
