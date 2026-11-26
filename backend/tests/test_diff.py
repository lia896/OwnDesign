"""Version comparison engine: deterministic diff of two plan versions. No database, no network."""

import copy

from app.diff import compare
from app.schemas import Geometry

BASE = {
    "schema": 1,
    "units": "cm",
    "rooms": [{"id": "r1", "name": "Living room", "type": "living"}, {"id": "r2", "name": "Bedroom", "type": "bedroom"}],
    "walls": [
        {"id": "w1", "x1": 0, "y1": 0, "x2": 500, "y2": 0, "thickness": 20, "kind": "exterior", "roomId": "r1"},
        {"id": "w2", "x1": 0, "y1": 400, "x2": 500, "y2": 400, "thickness": 20, "kind": "exterior", "roomId": "r1"},
        {"id": "w3", "x1": 500, "y1": 0, "x2": 900, "y2": 0, "thickness": 20, "kind": "exterior", "roomId": "r2"},
        {"id": "w4", "x1": 500, "y1": 400, "x2": 900, "y2": 400, "thickness": 20, "kind": "exterior", "roomId": "r2"},
    ],
    "openings": [{"id": "o1", "wallId": "w1", "type": "door", "offset": 50, "width": 90}],
    "furniture": [
        {"id": "sofa", "type": "sofa", "x": 200, "y": 300, "w": 200, "d": 90, "rotation": 0},
        {"id": "chair", "type": "chair", "x": 100, "y": 100, "w": 45, "d": 45, "rotation": 0},
        {"id": "lamp", "type": "lamp", "x": 50, "y": 50, "w": 30, "d": 30, "rotation": 0},
    ],
}


def geo(mutate=None) -> Geometry:
    data = copy.deepcopy(BASE)
    if mutate:
        mutate(data)
    return Geometry.model_validate(data)


def item(data, item_id):
    return next(f for f in data["furniture"] if f["id"] == item_id)


def only(result, entity_id):
    found = [c for c in result["changes"] if c["entity_id"] == entity_id]
    assert len(found) == 1, found
    return found[0]


def test_identical_versions_have_no_changes():
    result = compare(geo(), geo())
    assert result["changes"] == [] and result["summary"]["total"] == 0


def test_added_and_removed_furniture():
    def change(d):
        d["furniture"] = [f for f in d["furniture"] if f["id"] != "lamp"]
        d["furniture"].append({"id": "arm", "type": "armchair", "x": 650, "y": 200, "w": 85, "d": 85, "rotation": 0})

    result = compare(geo(), geo(change))
    added, removed = only(result, "arm"), only(result, "lamp")
    assert added["change_type"] == "added" and added["room_id"] == "r2" and added["before"] is None and added["box_b"]
    assert removed["change_type"] == "removed" and removed["room_id"] == "r1" and removed["after"] is None and removed["box_a"]
    assert added["furniture_type"] == "armchair"
    assert result["summary"] == {"total": 2, "added": 1, "removed": 1, "moved": 0, "rotated": 0, "resized": 0, "modified": 0, "structural": 0}


def test_moved_shows_only_position():
    result = compare(geo(), geo(lambda d: item(d, "sofa").update(x=240, y=330)))
    change = only(result, "sofa")
    assert change["change_type"] == "moved" and change["changed_properties"] == ["position"]
    assert change["before"] == {"x": 200, "y": 300} and change["after"] == {"x": 240, "y": 330}
    assert change["distance_cm"] == 50


def test_rotated_and_resized():
    result = compare(geo(), geo(lambda d: (item(d, "chair").update(rotation=90), item(d, "sofa").update(w=220))))
    assert only(result, "chair")["change_type"] == "rotated" and only(result, "chair")["after"] == {"rotation": 90}
    assert only(result, "sofa")["change_type"] == "resized" and only(result, "sofa")["before"] == {"w": 200, "d": 90}


def test_rotation_is_compared_as_an_angle():
    # 360 and 0 are the same orientation; -90 and 270 too.
    result = compare(geo(lambda d: item(d, "chair").update(rotation=-90)), geo(lambda d: item(d, "chair").update(rotation=270)))
    assert result["changes"] == []
    assert compare(geo(), geo(lambda d: item(d, "chair").update(rotation=360)))["changes"] == []


def test_tiny_differences_are_ignored():
    result = compare(geo(), geo(lambda d: item(d, "sofa").update(x=200.4, w=200.6, rotation=0.5)))
    assert result["changes"] == []


def test_just_over_the_tolerance_counts():
    assert only(compare(geo(), geo(lambda d: item(d, "sofa").update(x=201.5))), "sofa")["change_type"] == "moved"


def test_several_kinds_of_change_are_modified():
    result = compare(geo(), geo(lambda d: item(d, "sofa").update(x=260, rotation=90)))
    change = only(result, "sofa")
    assert change["change_type"] == "modified" and change["changed_properties"] == ["position", "rotation"]


def test_type_change_is_modified():
    change = only(compare(geo(), geo(lambda d: item(d, "chair").update(type="armchair"))), "chair")
    assert change["change_type"] == "modified" and change["before"] == {"type": "chair"} and change["after"] == {"type": "armchair"}


def test_moving_to_another_room_is_reported():
    change = only(compare(geo(), geo(lambda d: item(d, "chair").update(x=700))), "chair")
    assert change["changed_properties"] == ["position", "room"]
    assert change["before"]["room_id"] == "r1" and change["after"]["room_id"] == "r2" and change["room_id"] == "r2"


def test_structural_changes():
    def change(d):
        d["walls"][1]["y1"] = d["walls"][1]["y2"] = 450  # w2 moved down
        d["openings"][0]["width"] = 100
        d["rooms"][1]["name"] = "Main bedroom"
        d["walls"].append({"id": "w9", "x1": 250, "y1": 0, "x2": 250, "y2": 400, "thickness": 10, "kind": "partition"})

    result = compare(geo(), geo(change))
    wall, opening, room, new = only(result, "w2"), only(result, "o1"), only(result, "r2"), only(result, "w9")
    assert wall["change_type"] == "structural" and wall["entity_type"] == "wall" and wall["detail"] == "changed" and "position" in wall["changed_properties"]
    assert opening["changed_properties"] == ["width"] and opening["before"] == {"width": 90} and opening["room_id"] == "r1"
    assert room["changed_properties"] == ["name"] and room["after"] == {"name": "Main bedroom"}
    assert new["detail"] == "added" and new["room_id"] is None
    assert result["summary"]["structural"] == 4


def test_removed_room_and_its_walls():
    def change(d):
        d["rooms"] = d["rooms"][:1]
        d["walls"] = d["walls"][:2]

    result = compare(geo(), geo(change))
    assert only(result, "r2")["detail"] == "removed" and only(result, "w3")["detail"] == "removed"
    assert only(result, "r2")["room_name"] == "Bedroom"


def test_changes_are_grouped_by_room_then_type():
    def change(d):
        item(d, "sofa").update(x=250)
        d["furniture"].append({"id": "bed", "type": "double-bed", "x": 700, "y": 200, "w": 160, "d": 200, "rotation": 0})
        d["furniture"].append({"id": "far", "type": "chair", "x": 5000, "y": 5000, "w": 45, "d": 45, "rotation": 0})

    result = compare(geo(), geo(change))
    assert [(g["room_id"], g["change_ids"]) for g in result["groups"]] == [
        ("r1", ["furniture:sofa"]),
        ("r2", ["furniture:bed"]),
        (None, ["furniture:far"]),
    ]
    assert result["groups"][0]["room_name"] == "Living room" and result["groups"][-1]["room_name"] is None


def test_empty_plans():
    empty = Geometry.model_validate({"schema": 1, "units": "cm", "rooms": [], "walls": [], "openings": [], "furniture": []})
    assert compare(empty, empty)["changes"] == []
    everything = compare(empty, geo())
    assert everything["summary"]["added"] == 3 and everything["summary"]["structural"] == 7


def test_change_ids_are_stable_and_unique():
    b = geo(lambda d: (item(d, "sofa").update(x=260), d["furniture"].pop()))
    first, second = compare(geo(), b), compare(geo(), b)
    ids = [c["change_id"] for c in first["changes"]]
    assert ids == [c["change_id"] for c in second["changes"]] and len(ids) == len(set(ids))


def test_inputs_are_not_modified():
    a, b = geo(), geo(lambda d: item(d, "sofa").update(x=260))
    dumped = (a.model_dump(), b.model_dump())
    compare(a, b)
    assert (a.model_dump(), b.model_dump()) == dumped


def test_large_plan_is_fast():
    import time

    many = [{"id": f"f{i}", "type": "chair", "x": i % 900, "y": i // 9, "w": 45, "d": 45, "rotation": 0} for i in range(1000)]
    a = geo(lambda d: d.update(furniture=many))
    b = geo(lambda d: d.update(furniture=[{**f, "x": f["x"] + 10} for f in many]))
    start = time.perf_counter()
    result = compare(a, b)
    assert result["summary"]["moved"] == 1000 and time.perf_counter() - start < 1.0
