"""Design copilot engine: pure geometry and reply checks, no database and no network."""

import copy
import json

import pytest
from pydantic import ValidationError

from app.copilot import Action, Scope, apply_actions, build_context, footprint, new_problems, parse_reply, problems
from app.schemas import Geometry

# A 500 x 400 cm living room (walls 10 cm thick) with a door on the top wall at x 50..140.
ROOM = {
    "schema": 1,
    "units": "cm",
    "rooms": [{"id": "r1", "name": "Living room", "type": "living"}],
    "walls": [
        {"id": "w1", "x1": 0, "y1": 0, "x2": 500, "y2": 0, "thickness": 10, "kind": "exterior", "roomId": "r1"},
        {"id": "w2", "x1": 500, "y1": 0, "x2": 500, "y2": 400, "thickness": 10, "kind": "exterior", "roomId": "r1"},
        {"id": "w3", "x1": 500, "y1": 400, "x2": 0, "y2": 400, "thickness": 10, "kind": "exterior", "roomId": "r1"},
        {"id": "w4", "x1": 0, "y1": 400, "x2": 0, "y2": 0, "thickness": 10, "kind": "exterior", "roomId": "r1"},
    ],
    "openings": [
        {"id": "o1", "wallId": "w1", "type": "door", "offset": 50, "width": 90},
        {"id": "o2", "wallId": "w3", "type": "window", "offset": 100, "width": 120},
    ],
    "furniture": [
        {"id": "sofa", "type": "sofa", "x": 300, "y": 320, "w": 200, "d": 90, "rotation": 0},
        {"id": "table", "type": "coffee_table", "x": 300, "y": 220, "w": 100, "d": 60, "rotation": 0},
    ],
}


def plan(mutate=None) -> Geometry:
    data = copy.deepcopy(ROOM)
    if mutate:
        mutate(data)
    return Geometry.model_validate(data)


def move(object_id, x, y):
    return Action(type="move_object", object_id=object_id, x=x, y=y)


# ---- actions -----------------------------------------------------------------------------------------------------


def test_actions_apply_without_touching_the_input():
    before = plan()
    after = apply_actions(
        before,
        [
            move("sofa", 260, 330),
            Action(type="rotate_object", object_id="table", rotation=90),
            Action(type="resize_object", object_id="table", w=80, d=80),
        ],
    )
    sofa, table = after.furniture
    assert (sofa.x, sofa.y) == (260, 330)
    assert (table.rotation, table.w, table.d) == (90, 80, 80)
    assert before.furniture[0].x == 300  # the input plan is unchanged


def test_remove_then_reference_is_rejected():
    with pytest.raises(ValueError, match="unknown object"):
        apply_actions(plan(), [Action(type="remove_object", object_id="sofa"), move("sofa", 1, 1)])


def test_unknown_object_is_rejected():
    with pytest.raises(ValueError, match="unknown object"):
        apply_actions(plan(), [move("ghost", 10, 10)])


@pytest.mark.parametrize(
    "fields",
    [
        {"type": "move_object", "object_id": "sofa", "x": 10},  # y missing
        {"type": "resize_object", "object_id": "sofa", "w": 100},  # d missing
        {"type": "resize_object", "object_id": "sofa", "w": 0, "d": 50},  # not a size
        {"type": "rotate_object", "object_id": "sofa"},
        {"type": "delete_wall", "object_id": "w1"},  # not on the allow list
        {"type": "move_object", "object_id": "bad id!", "x": 1, "y": 1},
        {"type": "move_object", "object_id": "sofa", "x": float("nan"), "y": 1},
        {"type": "move_object", "object_id": "sofa", "x": 10**7, "y": 1},
        {"type": "remove_object", "object_id": "sofa", "sql": "drop table"},
    ],
)
def test_malformed_actions_are_rejected(fields):
    with pytest.raises(ValidationError):
        Action.model_validate(fields)


def test_scope_needs_an_id_unless_it_is_the_project():
    assert Scope().kind == "project"
    with pytest.raises(ValidationError):
        Scope(kind="room")
    with pytest.raises(ValidationError):
        Scope(kind="project", id="r1")


# ---- geometry checks ---------------------------------------------------------------------------------------------


def test_clean_plan_has_no_problems():
    assert problems(plan()) == []


def test_rotated_footprint_swaps_width_and_depth():
    item = plan().furniture[0].model_copy(update={"rotation": 90})
    x0, y0, x1, y1 = footprint(item)
    assert round(x1 - x0) == 90 and round(y1 - y0) == 200


def test_item_past_the_walls_is_a_problem():
    found = problems(apply_actions(plan(), [move("sofa", 450, 320)]))
    assert any("past the walls" in p["text"] and p["object_ids"] == ["sofa"] for p in found)


def test_item_outside_every_room_is_a_problem():
    found = problems(apply_actions(plan(), [move("table", 900, 900)]))
    assert any("outside every room" in p["text"] for p in found)


def test_overlap_is_a_problem_and_touching_is_not():
    overlapping = problems(apply_actions(plan(), [move("table", 300, 300)]))
    assert any(set(p["object_ids"]) == {"sofa", "table"} for p in overlapping)
    # Sofa spans y 275..365; a 60 cm deep table centred at y 245 ends exactly at 275.
    assert problems(apply_actions(plan(), [move("table", 300, 245)])) == []


def test_blocking_a_door_is_a_problem():
    found = problems(apply_actions(plan(), [move("table", 95, 60)]))
    assert any("door" in p["text"] and p["object_ids"] == ["table"] for p in found)


def test_only_new_problems_count_against_a_change():
    # The table already blocks the door; moving the sofa must not be blamed for that.
    crowded = apply_actions(plan(), [move("table", 95, 60)])
    moved = apply_actions(crowded, [move("sofa", 260, 320)])
    assert new_problems(crowded, moved) == []
    assert new_problems(plan(), crowded) != []


def test_plan_without_walls_skips_room_checks():
    bare = plan(lambda p: (p.update(walls=[], openings=[])))
    assert problems(apply_actions(bare, [move("sofa", 5000, 5000)])) == []


# ---- context -----------------------------------------------------------------------------------------------------


def test_room_context_carries_geometry():
    context = build_context(plan(), Scope(kind="room", id="r1"), brief={"styles": ["japandi"]}, property_type="existing")
    room = context["rooms"][0]
    assert room["bounds_cm"] == {"x": 5, "y": 5, "w": 490, "d": 390}
    assert {o["type"] for o in context["openings"]} == {"door", "window"}
    sofa = next(f for f in context["furniture"] if f["id"] == "sofa")
    assert sofa == {"id": "sofa", "type": "sofa", "x": 300, "y": 320, "w": 200, "d": 90, "rotation": 0, "room_id": "r1"}
    assert context["brief"] == {"styles": ["japandi"]}


def test_object_context_names_the_focus():
    context = build_context(plan(), Scope(kind="object", id="table"), brief=None, property_type="existing")
    assert context["focus"]["id"] == "table" and context["focus"]["room_id"] == "r1"


def test_unknown_scope_target_is_rejected():
    with pytest.raises(ValueError):
        build_context(plan(), Scope(kind="room", id="nope"), brief=None, property_type="existing")
    with pytest.raises(ValueError):
        build_context(plan(), Scope(kind="object", id="nope"), brief=None, property_type="existing")


def test_empty_plan_context():
    empty = Geometry.model_validate({"schema": 1, "units": "cm", "rooms": [], "walls": [], "openings": [], "furniture": []})
    context = build_context(empty, Scope(), brief=None, property_type="new_build")
    assert context["rooms"] == [] and context["furniture"] == [] and context["detected_problems"] == []


# ---- model replies -----------------------------------------------------------------------------------------------


def reply(**overrides):
    body = {
        "summary": "Circulation is tight.",
        "observations": [
            {"id": "obs1", "type": "issue", "severity": "medium", "title": "Tight path", "description": "Too close.", "object_ids": ["sofa", "ghost"]}
        ],
        "recommendations": [
            {
                "id": "rec1",
                "title": "Shift the sofa",
                "description": "Move it 40 cm left.",
                "actions": [{"type": "move_object", "object_id": "sofa", "x": 260, "y": 320, "rotation": None, "w": None, "d": None}],
            }
        ],
    }
    body.update(overrides)
    return json.dumps(body)


def test_valid_reply_is_applicable():
    parsed = parse_reply(reply(), plan())
    assert parsed["observations"][0]["object_ids"] == ["sofa"]  # unknown ids are dropped
    rec = parsed["recommendations"][0]
    assert rec["applicable"] and rec["problems"] == []
    assert rec["actions"] == [{"type": "move_object", "object_id": "sofa", "x": 260, "y": 320}]


def test_recommendation_that_breaks_geometry_is_not_applicable():
    bad = [{"type": "move_object", "object_id": "sofa", "x": 300, "y": 230, "rotation": None, "w": None, "d": None}]
    rec = parse_reply(reply(recommendations=[{"id": "r", "title": "t", "description": "d", "actions": bad}]), plan())["recommendations"][0]
    assert not rec["applicable"] and any("overlaps" in text for text in rec["problems"])


def test_recommendation_with_unknown_object_is_not_applicable():
    bad = [{"type": "remove_object", "object_id": "ghost", "rotation": None, "x": None, "y": None, "w": None, "d": None}]
    rec = parse_reply(reply(recommendations=[{"id": "r", "title": "t", "description": "d", "actions": bad}]), plan())["recommendations"][0]
    assert not rec["applicable"] and rec["actions"] == []


def test_malformed_action_makes_only_that_recommendation_inapplicable():
    bad = [{"type": "paint_walls", "object_id": "sofa"}]
    recs = json.loads(reply())["recommendations"] + [{"id": "r2", "title": "t", "description": "d", "actions": bad}]
    parsed = parse_reply(reply(recommendations=recs), plan())
    assert [r["applicable"] for r in parsed["recommendations"]] == [True, False]


def test_advice_without_actions_is_kept_but_not_applicable():
    rec = parse_reply(reply(recommendations=[{"id": "r", "title": "Add a rug", "description": "d", "actions": []}]), plan())["recommendations"][0]
    assert not rec["applicable"] and rec["problems"] == []


def test_long_reply_is_clipped():
    many = [{"id": f"o{i}", "type": "insight", "severity": "low", "title": "x" * 500, "description": "y" * 5000, "object_ids": []} for i in range(20)]
    parsed = parse_reply(reply(summary="s" * 9000, observations=many), plan())
    assert len(parsed["summary"]) <= 1200 and len(parsed["observations"]) == 8
    assert len(parsed["observations"][0]["title"]) <= 120 and len(parsed["observations"][0]["description"]) <= 600


@pytest.mark.parametrize("text", ["", "not json", "[]", json.dumps({"summary": 5}), json.dumps({"observations": "x"})])
def test_unusable_reply_raises(text):
    with pytest.raises(ValueError):
        parse_reply(text, plan())
