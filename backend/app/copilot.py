"""Design copilot engine: the geometry-aware context sent to the model, the reply schema, and the
server-side check of every change the model proposes. Pure functions over a plan Geometry (centimetres).

The model never edits a plan. It may only propose actions from ACTION_FIELDS; each one is validated here,
applied to a copy of the plan, and checked against hard geometric rules before it is offered to the designer.
"""

import json
import math
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from app.schemas import Cm, Geometry, Id

ACTION_FIELDS = {
    "move_object": ("x", "y"),
    "rotate_object": ("rotation",),
    "resize_object": ("w", "d"),
    "remove_object": (),
}
TOLERANCE_CM = 0.5  # touching is not overlapping
OPENING_REACH_CM = 20  # an opening belongs to a room when its wall runs along the room's edge
MAX_CONTEXT_FURNITURE = 300  # shortcut: a huge plan is cut for the model; per-room scope always fits
LIMITS = {"summary": 1200, "title": 120, "description": 600, "observations": 8, "recommendations": 3, "actions": 8}

FurnitureSize = Annotated[float, Field(gt=0, le=3000, allow_inf_nan=False)]  # same limit as the editor's inspector


class Action(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    type: Literal["move_object", "rotate_object", "resize_object", "remove_object"]
    object_id: Id
    x: Cm | None = None
    y: Cm | None = None
    rotation: Annotated[float, Field(ge=-360, le=360, allow_inf_nan=False)] | None = None
    w: FurnitureSize | None = None
    d: FurnitureSize | None = None

    @model_validator(mode="after")
    def _fields_match_type(self):
        needed = ACTION_FIELDS[self.type]
        if any(getattr(self, name) is None for name in needed):
            raise ValueError(f"{self.type} needs {', '.join(needed)}")
        return self

    def compact(self) -> dict:
        return {"type": self.type, "object_id": self.object_id, **{name: getattr(self, name) for name in ACTION_FIELDS[self.type]}}


class Scope(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    kind: Literal["project", "room", "object"] = "project"
    id: Id | None = None

    @model_validator(mode="after")
    def _id_matches_kind(self):
        if (self.kind == "project") != (self.id is None):
            raise ValueError("a room or object scope needs an id; the project scope takes none")
        return self


# ---- geometry ----------------------------------------------------------------------------------------------------

Box = tuple[float, float, float, float]  # x0, y0, x1, y1


def room_rect(geometry: Geometry, room_id: str) -> Box | None:
    """Inner bounds of a room: the box of its walls, inset by half the thickest wall.

    shortcut: a box, so an L-shaped room is checked against its bounding box; use polygons when rooms stop being rectangles.
    """
    walls = [wall for wall in geometry.walls if wall.roomId == room_id]
    if not walls:
        return None
    xs = [v for wall in walls for v in (wall.x1, wall.x2)]
    ys = [v for wall in walls for v in (wall.y1, wall.y2)]
    inset = max(wall.thickness for wall in walls) / 2
    return min(xs) + inset, min(ys) + inset, max(xs) - inset, max(ys) - inset


def footprint(item) -> Box:
    """Axis-aligned box of a rotated item. Exact at multiples of 90 degrees, slightly generous otherwise."""
    angle = math.radians(item.rotation)
    c, s = abs(math.cos(angle)), abs(math.sin(angle))
    hw = (item.w * c + item.d * s) / 2
    hd = (item.w * s + item.d * c) / 2
    return item.x - hw, item.y - hd, item.x + hw, item.y + hd


def _overlaps(a: Box, b: Box) -> bool:
    return a[0] < b[2] - TOLERANCE_CM and b[0] < a[2] - TOLERANCE_CM and a[1] < b[3] - TOLERANCE_CM and b[1] < a[3] - TOLERANCE_CM


def _inside(inner: Box, outer: Box) -> bool:
    return inner[0] >= outer[0] - TOLERANCE_CM and inner[1] >= outer[1] - TOLERANCE_CM and inner[2] <= outer[2] + TOLERANCE_CM and inner[3] <= outer[3] + TOLERANCE_CM


def _rooms(geometry: Geometry) -> list[tuple[object, Box]]:
    return [(room, rect) for room in geometry.rooms if (rect := room_rect(geometry, room.id))]


def room_of(geometry: Geometry, item, rooms=None) -> str | None:
    for room, (x0, y0, x1, y1) in rooms if rooms is not None else _rooms(geometry):
        if x0 <= item.x <= x1 and y0 <= item.y <= y1:
            return room.id
    return None


def _opening_segment(wall, opening):
    ux, uy = (wall.x2 - wall.x1) / wall.length, (wall.y2 - wall.y1) / wall.length
    end = opening.offset + opening.width
    return wall.x1 + ux * opening.offset, wall.y1 + uy * opening.offset, wall.x1 + ux * end, wall.y1 + uy * end, ux, uy


def _door_zone(wall, door) -> Box:
    """The square a door leaf sweeps, on both sides of the wall (the plan does not record which way it opens)."""
    x1, y1, x2, y2, ux, uy = _opening_segment(wall, door)
    nx, ny = -uy * door.width, ux * door.width
    xs = [x1 + nx, x1 - nx, x2 + nx, x2 - nx]
    ys = [y1 + ny, y1 - ny, y2 + ny, y2 - ny]
    return min(xs), min(ys), max(xs), max(ys)


def _label(item) -> str:
    return f"{item.type.replace('_', ' ')} ({item.id})"


def problems(geometry: Geometry) -> list[dict]:
    """Hard-rule violations: furniture past the walls or outside every room, overlapping furniture, blocked doors."""
    found = []
    rooms = _rooms(geometry)
    rects = {room.id: rect for room, rect in rooms}
    names = {room.id: room.name for room in geometry.rooms}
    walls = {wall.id: wall for wall in geometry.walls}
    doors = [(door, _door_zone(walls[door.wallId], door)) for door in geometry.openings if door.type == "door"]
    boxes = [(item, footprint(item)) for item in geometry.furniture]
    for index, (item, box) in enumerate(boxes):
        if rooms:
            room_id = room_of(geometry, item, rooms)
            if room_id is None:
                found.append({"object_ids": [item.id], "text": f"{_label(item)} is outside every room"})
            elif not _inside(box, rects[room_id]):
                found.append({"object_ids": [item.id], "text": f"{_label(item)} extends past the walls of {names[room_id]}"})
        for other, other_box in boxes[index + 1 :]:
            if _overlaps(box, other_box):
                found.append({"object_ids": [item.id, other.id], "text": f"{_label(item)} overlaps {_label(other)}"})
        for door, zone in doors:
            if _overlaps(box, zone):
                found.append({"object_ids": [item.id], "text": f"{_label(item)} blocks the swing of door {door.id}"})
    return found


def new_problems(before: Geometry, after: Geometry) -> list[str]:
    """Problems a change introduces. Ones the plan already had are not blamed on the change."""
    old = {p["text"] for p in problems(before)}
    return [p["text"] for p in problems(after) if p["text"] not in old]


def apply_actions(geometry: Geometry, actions: list[Action]) -> Geometry:
    """A new plan with the actions applied in order. Raises ValueError for an object that does not exist."""
    data = geometry.model_dump(by_alias=True, exclude_none=True)
    for action in actions:
        items = data["furniture"]
        index = next((i for i, item in enumerate(items) if item["id"] == action.object_id), None)
        if index is None:
            raise ValueError(f"unknown object {action.object_id}")
        if action.type == "remove_object":
            del items[index]
        else:
            items[index] = {**items[index], **{name: getattr(action, name) for name in ACTION_FIELDS[action.type]}}
    return Geometry.model_validate(data)


# ---- context for the model ---------------------------------------------------------------------------------------


def build_context(geometry: Geometry, scope: Scope, *, brief: dict | None, property_type: str) -> dict:
    """What the model sees: rooms with inner bounds, openings, furniture with size and position, detected problems.

    Raises ValueError when the scope names a room or object the plan does not have.
    """
    rooms = _rooms(geometry)
    rects = {room.id: rect for room, rect in rooms}
    walls = {wall.id: wall for wall in geometry.walls}
    room_ids = {room.id for room in geometry.rooms}
    furniture = {item.id: item for item in geometry.furniture}
    focus = None
    if scope.kind == "room" and scope.id not in room_ids:
        raise ValueError("unknown room")
    if scope.kind == "object":
        if scope.id not in furniture:
            raise ValueError("unknown object")
        focus = furniture[scope.id]
    focus_room = scope.id if scope.kind == "room" else room_of(geometry, focus, rooms) if focus else None

    def opening_room(opening):
        x1, y1, x2, y2, _, _ = _opening_segment(walls[opening.wallId], opening)
        mx, my = (x1 + x2) / 2, (y1 + y2) / 2
        r = OPENING_REACH_CM
        return next((rid for rid, (a, b, c, d) in rects.items() if a - r <= mx <= c + r and b - r <= my <= d + r), None)

    def item_view(item):
        return {"id": item.id, "type": item.type, "x": round(item.x), "y": round(item.y), "w": round(item.w), "d": round(item.d), "rotation": round(item.rotation), "room_id": room_of(geometry, item, rooms)}

    def opening_view(opening):
        x1, y1, x2, y2, _, _ = _opening_segment(walls[opening.wallId], opening)
        return {"id": opening.id, "type": opening.type, "width": round(opening.width), "from": [round(x1), round(y1)], "to": [round(x2), round(y2)], "room_id": opening_room(opening)}

    in_scope = (lambda rid: True) if focus_room is None and scope.kind == "project" else (lambda rid: rid == focus_room)
    room_views = []
    for room in geometry.rooms:
        rect = rects.get(room.id)
        if not in_scope(room.id):
            continue
        bounds = {"x": round(rect[0]), "y": round(rect[1]), "w": round(rect[2] - rect[0]), "d": round(rect[3] - rect[1])} if rect else None
        room_views.append({"id": room.id, "name": room.name, "type": room.type, "bounds_cm": bounds})
    items = [item_view(item) for item in geometry.furniture]
    openings = [opening_view(opening) for opening in geometry.openings]
    if scope.kind != "project":
        items = [item for item in items if item["room_id"] == focus_room or (focus and item["id"] == focus.id)]
        openings = [opening for opening in openings if opening["room_id"] == focus_room]
    visible = {item["id"] for item in items}
    return {
        "units": "cm; x/y is an item's centre; origin top-left, y grows downward; rotation in degrees clockwise",
        "property_type": property_type,
        "scope": scope.model_dump(),
        "focus": item_view(focus) if focus else None,
        "rooms": room_views,
        "openings": openings,
        "furniture": items[:MAX_CONTEXT_FURNITURE],
        "detected_problems": [p for p in problems(geometry) if set(p["object_ids"]) & visible],
        "brief": brief,
    }


# ---- the model's reply -------------------------------------------------------------------------------------------

_NULLABLE_NUMBER = {"type": ["number", "null"]}
REPLY_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["summary", "observations", "recommendations"],
    "properties": {
        "summary": {"type": "string", "description": "Two or three sentences for the designer."},
        "observations": {
            "type": "array",
            "description": f"At most {LIMITS['observations']}.",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["id", "type", "severity", "title", "description", "object_ids"],
                "properties": {
                    "id": {"type": "string"},
                    "type": {"type": "string", "enum": ["insight", "issue"]},
                    "severity": {"type": "string", "enum": ["low", "medium", "high"]},
                    "title": {"type": "string"},
                    "description": {"type": "string"},
                    "object_ids": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
        "recommendations": {
            "type": "array",
            "description": f"At most {LIMITS['recommendations']}, each a distinct option.",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["id", "title", "description", "actions"],
                "properties": {
                    "id": {"type": "string"},
                    "title": {"type": "string"},
                    "description": {"type": "string"},
                    "actions": {
                        "type": "array",
                        "description": "Empty when the advice cannot be expressed with these actions.",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["type", "object_id", "x", "y", "rotation", "w", "d"],
                            "properties": {
                                "type": {"type": "string", "enum": list(ACTION_FIELDS)},
                                "object_id": {"type": "string"},
                                "x": _NULLABLE_NUMBER,
                                "y": _NULLABLE_NUMBER,
                                "rotation": _NULLABLE_NUMBER,
                                "w": _NULLABLE_NUMBER,
                                "d": _NULLABLE_NUMBER,
                            },
                        },
                    },
                },
            },
        },
    },
}


class _Observation(BaseModel):
    id: str
    type: Literal["insight", "issue"]
    severity: Literal["low", "medium", "high"]
    title: str
    description: str
    object_ids: list[str]


class _Recommendation(BaseModel):
    id: str
    title: str
    description: str
    actions: list[dict]  # checked one by one, so a single bad action only disables its own recommendation


class _Reply(BaseModel):
    summary: str
    observations: list[_Observation]
    recommendations: list[_Recommendation]


def _check_recommendation(rec: _Recommendation, geometry: Geometry) -> dict:
    out = {"id": rec.id[:40], "title": rec.title[: LIMITS["title"]], "description": rec.description[: LIMITS["description"]]}
    raw = rec.actions[: LIMITS["actions"]]
    if not raw:
        return {**out, "actions": [], "applicable": False, "problems": []}
    try:
        actions = [Action.model_validate({k: v for k, v in item.items() if v is not None}) for item in raw]
        after = apply_actions(geometry, actions)
    except (ValidationError, ValueError, AttributeError):
        return {**out, "actions": [], "applicable": False, "problems": ["The suggested change refers to something that is not in the plan."]}
    found = new_problems(geometry, after)
    return {**out, "actions": [action.compact() for action in actions], "applicable": not found, "problems": found}


def parse_reply(text: str, geometry: Geometry) -> dict:
    """The model's JSON reply, clipped to size and with every proposed change checked. Raises ValueError if unusable."""
    try:
        reply = _Reply.model_validate(json.loads(text))
    except (ValidationError, json.JSONDecodeError, TypeError) as error:
        raise ValueError("unusable reply") from error
    known = {item.id for item in geometry.furniture} | {opening.id for opening in geometry.openings} | {room.id for room in geometry.rooms}
    observations = [
        {
            "id": obs.id[:40],
            "type": obs.type,
            "severity": obs.severity,
            "title": obs.title[: LIMITS["title"]],
            "description": obs.description[: LIMITS["description"]],
            "object_ids": [oid for oid in obs.object_ids if oid in known][:20],
        }
        for obs in reply.observations[: LIMITS["observations"]]
    ]
    return {
        "summary": reply.summary.strip()[: LIMITS["summary"]],
        "observations": observations,
        "recommendations": [_check_recommendation(rec, geometry) for rec in reply.recommendations[: LIMITS["recommendations"]]],
    }
