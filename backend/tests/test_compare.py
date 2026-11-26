"""Version comparison API: access, validation, and that comparing writes nothing."""

import copy
from types import SimpleNamespace

import pytest

from tests.conftest import needs_supabase
from tests.test_diff import BASE

pytestmark = needs_supabase


@pytest.fixture(scope="module")
def world(api, make_user):
    designer, client, stranger, other_designer = (make_user(p) for p in ("cmpd", "cmpc", "cmps", "cmpo"))
    studio = api.post("/v1/studios", json={"name": "Compare Studio"}, headers=designer.headers).json()["data"]
    assert api.post("/v1/studios", json={"name": "Other Studio"}, headers=other_designer.headers).status_code == 201

    def project(user):
        body = {"studio_id": studio["id"], "name": "Flat", "property_type": "existing"}
        return api.post("/v1/projects", json=body, headers=user.headers).json()["data"]

    mine, theirs = project(client), project(stranger)
    moved = copy.deepcopy(BASE)
    moved["furniture"][0]["x"] = 260

    def save(user, pid, geometry):
        return api.post(f"/v1/projects/{pid}/versions", json={"geometry": geometry}, headers=user.headers).json()["data"]

    v1, v2 = save(client, mine["id"], BASE), save(client, mine["id"], moved)
    other = save(stranger, theirs["id"], BASE)
    return SimpleNamespace(designer=designer, other_designer=other_designer, client=client, stranger=stranger, mine=mine, theirs=theirs, v1=v1, v2=v2, other=other)


def url(project):
    return f"/v1/projects/{project['id']}/versions/compare"


def body(a, b):
    return {"version_a_id": a["id"], "version_b_id": b["id"]}


def test_client_and_designer_compare(api, world):
    for user in (world.client, world.designer):
        response = api.post(url(world.mine), json=body(world.v1, world.v2), headers=user.headers)
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["version_a"]["version_no"] == 1 and data["version_b"]["version_no"] == 2
        assert data["summary"]["moved"] == 1 and data["changes"][0]["entity_id"] == "sofa"
        assert "geometry" not in data["version_a"]


def test_swapped_direction(api, world):
    data = api.post(url(world.mine), json=body(world.v2, world.v1), headers=world.client.headers).json()["data"]
    assert data["changes"][0]["before"] == {"x": 260, "y": 300} and data["changes"][0]["after"] == {"x": 200, "y": 300}


def test_comparing_writes_nothing(api, world):
    before = api.get(f"/v1/projects/{world.mine['id']}/versions", headers=world.client.headers).json()["data"]
    api.post(url(world.mine), json=body(world.v1, world.v2), headers=world.client.headers)
    assert api.get(f"/v1/projects/{world.mine['id']}/versions", headers=world.client.headers).json()["data"] == before


def test_same_version_is_refused(api, world):
    assert api.post(url(world.mine), json=body(world.v1, world.v1), headers=world.client.headers).status_code == 422


def test_version_of_another_project_is_not_found(api, world):
    # Even the owner of the other project cannot mix its version into this one.
    assert api.post(url(world.mine), json=body(world.v1, world.other), headers=world.client.headers).status_code == 404
    assert api.post(url(world.theirs), json=body(world.other, world.v1), headers=world.stranger.headers).status_code == 404


def test_outsiders_are_refused(api, world):
    assert api.post(url(world.mine), json=body(world.v1, world.v2), headers=world.stranger.headers).status_code == 404
    assert api.post(url(world.mine), json=body(world.v1, world.v2)).status_code == 401


def test_designer_of_another_studio_is_refused(api, world):
    response = api.post(url(world.mine), json=body(world.v1, world.v2), headers=world.other_designer.headers)
    assert response.status_code == 404 and "sofa" not in response.text


def test_unknown_version_is_404(api, world):
    missing = {"id": "00000000-0000-0000-0000-000000000000"}
    assert api.post(url(world.mine), json=body(world.v1, missing), headers=world.client.headers).status_code == 404


@pytest.mark.parametrize(
    "payload",
    [{}, {"version_a_id": "x", "version_b_id": "y"}, {"version_a_id": "../1", "version_b_id": None}, {"version_a_id": "00000000-0000-0000-0000-000000000000"}],
)
def test_malformed_requests_are_422(api, world, payload):
    assert api.post(url(world.mine), json=payload, headers=world.client.headers).status_code == 422


def test_extra_fields_are_refused(api, world):
    assert api.post(url(world.mine), json={**body(world.v1, world.v2), "geometry": {}}, headers=world.client.headers).status_code == 422
