"""Browser tests of version comparison in the editor: real backend, real versions, nothing mocked."""

import copy

import pytest
from playwright.sync_api import expect

from tests.test_e2e_design import servers, sign_in, studio, world  # noqa: F401 (fixtures)
from tests.test_e2e_design import pytestmark as design_marks
from tests.test_geometry import VALID

pytestmark = [*design_marks, pytest.mark.usefixtures("servers")]


def second_version(api, world):
    """v2: the sofa moved 120 cm, an armchair added. v1 is the plan the world fixture saved."""
    plan = copy.deepcopy(VALID)
    plan["furniture"][0]["x"] = 220
    plan["furniture"].append({"id": "f2", "type": "armchair", "x": 300, "y": 220, "w": 85, "d": 85, "rotation": 0})
    response = api.post(f"{world.base}/versions", json={"label": "Moved sofa", "geometry": plan}, headers=world.client.headers)
    assert response.status_code == 201


def open_compare(page, user, world):
    sign_in(page, user, f"editor.html?project={world.pid}")
    page.get_by_role("button", name="Compare versions").first.click()
    page.get_by_role("heading", name="Version comparison").wait_for()
    page.locator("#cmp-total").filter(has_text="detected").wait_for()


def test_client_compares_inspects_and_exits_without_changes(page, api, world):
    second_version(api, world)
    versions_before = api.get(f"{world.base}/versions", headers=world.client.headers).json()["data"]
    open_compare(page, world.client, world)

    # Defaults: the newest version against the one before it.
    assert page.get_by_label("Version A · baseline").locator("option:checked").inner_text() == "v1"
    assert page.get_by_label("Version B · compared").locator("option:checked").inner_text() == "v2 · Moved sofa"
    assert page.locator("#cmp-total").inner_text() == "2 changes detected"
    assert page.locator(".cmp-count").count() == 2  # added and moved
    expect(page.locator("#cmp-svg-b .cmp-mark.cmp-added")).to_have_count(1)
    expect(page.locator("#cmp-svg-a .cmp-mark.cmp-added")).to_have_count(0)  # an added item does not exist in A

    # Selecting a change shows only what changed.
    page.get_by_role("button", name="Moved Sofa").click()
    details = page.locator("#cmp-details").text_content()  # the text itself; CSS shows the headers in capitals
    assert "Position (centre)" in details and "100, 100 cm" in details and "220, 100 cm" in details
    expect(page.locator("#cmp-svg-a .cmp-focus")).to_have_count(1)
    expect(page.locator("#cmp-svg-b .cmp-focus")).to_have_count(1)

    # Filters.
    page.get_by_label("Type").select_option("added")
    assert page.locator(".cmp-change").count() == 1 and "Armchair" in page.locator(".cmp-change").inner_text()
    page.get_by_label("Type").select_option("all")

    # Swap reverses the direction: the armchair is now removed, shown dashed in the difference view.
    page.get_by_role("button", name="Swap versions A and B").click()
    page.get_by_role("button", name="Removed Armchair").wait_for()
    page.get_by_role("button", name="Difference view").click()
    expect(page.locator("#cmp-plan-a")).to_be_hidden()
    expect(page.locator("#cmp-svg-b .cmp-gone")).to_have_count(1)  # drawn on the next frame

    # An added or removed item has no before/after table, and nothing like "null" is shown instead.
    page.get_by_role("button", name="Removed Armchair").click()
    expect(page.locator("#cmp-details")).to_contain_text("No longer in version B")
    expect(page.locator("#cmp-details")).not_to_contain_text("null")

    # Same version on both sides is refused in the page (after the swap, A is v2).
    page.get_by_label("Version B · compared").select_option(label="v2 · Moved sofa")
    page.get_by_text("Choose two different versions to compare.").wait_for()

    page.get_by_role("button", name="Exit comparison").click()
    page.locator("#canvas").wait_for()
    assert api.get(f"{world.base}/versions", headers=world.client.headers).json()["data"] == versions_before


def test_continue_from_an_older_version_loads_it_unsaved(page, api, world):
    second_version(api, world)
    open_compare(page, world.client, world)
    page.get_by_role("button", name="From version A").click()
    page.get_by_text("Loaded v1").wait_for()
    page.get_by_text("Unsaved changes").wait_for()
    assert len(api.get(f"{world.base}/versions", headers=world.client.headers).json()["data"]) == 2


def test_compare_needs_two_versions(page, world):
    sign_in(page, world.client, f"editor.html?project={world.pid}")
    button = page.locator("#compare-open")
    button.wait_for()
    assert button.is_disabled() and "at least two versions" in button.get_attribute("title")


def test_identical_versions_show_no_differences(page, api, world):
    assert api.post(f"{world.base}/versions", json={"label": "Same", "geometry": VALID}, headers=world.client.headers).status_code == 201
    sign_in(page, world.client, f"editor.html?project={world.pid}")
    page.get_by_role("button", name="Compare versions").first.click()
    page.get_by_text("No differences between these versions.").wait_for()
    assert page.locator(".cmp-change").count() == 0
