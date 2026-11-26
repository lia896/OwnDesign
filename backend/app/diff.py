"""Version comparison engine: a deterministic diff of two plan versions (Geometry, centimetres).

Entities are matched by their stable ids, never by name or position in a list. An item deleted and drawn
again gets a new id, so it shows as removed plus added (no matching heuristics yet). Values within the
tolerances below are treated as equal, so rounding never shows up as a change. No input is modified.
"""

import math

from app.schemas import Geometry

POSITION_TOLERANCE_CM = 1.0
SIZE_TOLERANCE_CM = 1.0
ROTATION_TOLERANCE_DEG = 1.0
KINDS = ("added", "removed", "moved", "rotated", "resized", "modified", "structural")
SINGLE_KIND = {"position": "moved", "rotation": "rotated", "size": "resized"}

Box = dict  # {"x", "y", "w", "h"} in centimetres


def _box(x0, y0, x1, y1) -> Box:
    return {"x": round(x0, 1), "y": round(y0, 1), "w": round(x1 - x0, 1), "h": round(y1 - y0, 1)}


def _furniture_box(item) -> Box:
    angle = math.radians(item.rotation)
    c, s = abs(math.cos(angle)), abs(math.sin(angle))
    hw, hd = (item.w * c + item.d * s) / 2, (item.w * s + item.d * c) / 2
    return _box(item.x - hw, item.y - hd, item.x + hw, item.y + hd)


def _segment_box(x1, y1, x2, y2, pad) -> Box:
    return _box(min(x1, x2) - pad, min(y1, y2) - pad, max(x1, x2) + pad, max(y1, y2) + pad)


def _opening_box(opening, wall) -> Box:
    ux, uy = (wall.x2 - wall.x1) / wall.length, (wall.y2 - wall.y1) / wall.length
    end = opening.offset + opening.width
    return _segment_box(wall.x1 + ux * opening.offset, wall.y1 + uy * opening.offset, wall.x1 + ux * end, wall.y1 + uy * end, wall.thickness / 2)


class _Plan:
    """Lookups for one version: entities by id, room boxes, and which room a point is in."""

    def __init__(self, geometry: Geometry):
        self.rooms = {room.id: room for room in geometry.rooms}
        self.walls = {wall.id: wall for wall in geometry.walls}
        self.openings = {opening.id: opening for opening in geometry.openings}
        self.furniture = {item.id: item for item in geometry.furniture}
        self.room_boxes = {}
        for room in geometry.rooms:
            walls = [wall for wall in geometry.walls if wall.roomId == room.id]
            if walls:
                xs = [v for wall in walls for v in (wall.x1, wall.x2)]
                ys = [v for wall in walls for v in (wall.y1, wall.y2)]
                self.room_boxes[room.id] = (min(xs), min(ys), max(xs), max(ys))

    def room_at(self, x, y) -> str | None:
        # shortcut: the box of a room's walls; an L-shaped room claims its whole bounding box. Use polygons when rooms stop being boxes.
        return next((rid for rid, (x0, y0, x1, y1) in self.room_boxes.items() if x0 <= x <= x1 and y0 <= y <= y1), None)

    def room_box(self, room_id) -> Box | None:
        box = self.room_boxes.get(room_id)
        return _box(*box) if box else None

    def opening_room(self, opening) -> str | None:
        return self.walls[opening.wallId].roomId


def _angle_delta(a: float, b: float) -> float:
    delta = (b - a) % 360
    return min(delta, 360 - delta)


def _num(value: float) -> float:
    return round(value, 1)


def _furniture_change(a, b, pa: _Plan, pb: _Plan) -> dict | None:
    props, before, after = [], {}, {}
    distance = math.hypot(b.x - a.x, b.y - a.y)
    if distance > POSITION_TOLERANCE_CM:
        props.append("position")
        before |= {"x": _num(a.x), "y": _num(a.y)}
        after |= {"x": _num(b.x), "y": _num(b.y)}
    if _angle_delta(a.rotation, b.rotation) > ROTATION_TOLERANCE_DEG:
        props.append("rotation")
        before["rotation"], after["rotation"] = _num(a.rotation % 360), _num(b.rotation % 360)
    if abs(a.w - b.w) > SIZE_TOLERANCE_CM or abs(a.d - b.d) > SIZE_TOLERANCE_CM:
        props.append("size")
        before |= {"w": _num(a.w), "d": _num(a.d)}
        after |= {"w": _num(b.w), "d": _num(b.d)}
    if a.type != b.type:
        props.append("type")
        before["type"], after["type"] = a.type, b.type
    room_a, room_b = pa.room_at(a.x, a.y), pb.room_at(b.x, b.y)
    if room_a != room_b:
        props.append("room")
        before["room_id"], after["room_id"] = room_a, room_b
    kinds = [p for p in props if p != "room"]
    if not kinds:
        return None
    change = {
        "change_type": SINGLE_KIND.get(kinds[0], "modified") if len(kinds) == 1 else "modified",
        "changed_properties": props,
        "before": before,
        "after": after,
    }
    if "position" in props:
        change["distance_cm"] = round(distance)
    return change


def _diff_fields(a, b, fields: dict) -> tuple[list, dict, dict]:
    """fields: property name -> (getter, tolerance). Numeric getters return a tuple; tolerance None means exact."""
    props, before, after = [], {}, {}
    for name, (get, tolerance) in fields.items():
        va, vb = get(a), get(b)
        if tolerance is None:
            differs, shown = va != vb, (lambda v: v)
        else:
            differs = any(abs(x - y) > tolerance for x, y in zip(va, vb))
            shown = lambda v: _num(v[0]) if len(v) == 1 else [_num(x) for x in v]  # noqa: E731
        if differs:
            props.append(name)
            before[name], after[name] = shown(va), shown(vb)
    return props, before, after


WALL_FIELDS = {
    "position": (lambda w: (w.x1, w.y1, w.x2, w.y2), POSITION_TOLERANCE_CM),
    "thickness": (lambda w: (w.thickness,), SIZE_TOLERANCE_CM),
    "kind": (lambda w: w.kind, None),
    "room": (lambda w: w.roomId, None),
}
OPENING_FIELDS = {
    "type": (lambda o: o.type, None),
    "wall": (lambda o: o.wallId, None),
    "offset": (lambda o: (o.offset,), POSITION_TOLERANCE_CM),
    "width": (lambda o: (o.width,), SIZE_TOLERANCE_CM),
}
ROOM_FIELDS = {"name": (lambda r: r.name, None), "type": (lambda r: r.type, None)}


def compare(a: Geometry, b: Geometry) -> dict:
    """Structured changes from version A (baseline) to version B, a summary, and the changes grouped by room."""
    pa, pb = _Plan(a), _Plan(b)
    changes = []

    def record(entity_type, entity_id, change_type, room_id, box_a, box_b, **extra):
        room = pb.rooms.get(room_id) or pa.rooms.get(room_id)
        changes.append(
            {
                "change_id": f"{entity_type}:{entity_id}",
                "entity_id": entity_id,
                "entity_type": entity_type,
                "change_type": change_type,
                "room_id": room_id,
                "room_name": room.name if room else None,
                "box_a": box_a,
                "box_b": box_b,
                "changed_properties": [],
                "before": None,
                "after": None,
                **extra,
            }
        )

    for item_id in pa.furniture.keys() | pb.furniture.keys():
        ia, ib = pa.furniture.get(item_id), pb.furniture.get(item_id)
        if ia and ib:
            found = _furniture_change(ia, ib, pa, pb)
            if found:
                record("furniture", item_id, found.pop("change_type"), pb.room_at(ib.x, ib.y), _furniture_box(ia), _furniture_box(ib), furniture_type=ib.type, **found)
        elif ib:
            record("furniture", item_id, "added", pb.room_at(ib.x, ib.y), None, _furniture_box(ib), furniture_type=ib.type)
        else:
            record("furniture", item_id, "removed", pa.room_at(ia.x, ia.y), _furniture_box(ia), None, furniture_type=ia.type)

    def structural(entity_type, ids_a, ids_b, fields, box, room, label):
        for entity_id in ids_a.keys() | ids_b.keys():
            ea, eb = ids_a.get(entity_id), ids_b.get(entity_id)
            if ea and eb:
                props, before, after = _diff_fields(ea, eb, fields)
                if props:
                    record(entity_type, entity_id, "structural", room(pb, eb), box(pa, ea), box(pb, eb), detail="changed", changed_properties=props, before=before, after=after, label=label(eb))
            elif eb:
                record(entity_type, entity_id, "structural", room(pb, eb), None, box(pb, eb), detail="added", label=label(eb))
            else:
                record(entity_type, entity_id, "structural", room(pa, ea), box(pa, ea), None, detail="removed", label=label(ea))

    structural("room", pa.rooms, pb.rooms, ROOM_FIELDS, lambda p, r: p.room_box(r.id), lambda p, r: r.id, lambda r: r.type)
    structural("wall", pa.walls, pb.walls, WALL_FIELDS, lambda p, w: _segment_box(w.x1, w.y1, w.x2, w.y2, w.thickness / 2), lambda p, w: w.roomId, lambda w: w.kind)
    structural("opening", pa.openings, pb.openings, OPENING_FIELDS, lambda p, o: _opening_box(o, p.walls[o.wallId]), lambda p, o: p.opening_room(o), lambda o: o.type)

    order = {kind: index for index, kind in enumerate(KINDS)}
    changes.sort(key=lambda c: (order[c["change_type"]], c["entity_type"], c["entity_id"]))
    summary = {"total": len(changes), **{kind: sum(c["change_type"] == kind for c in changes) for kind in KINDS}}

    room_order = [*pb.rooms, *(rid for rid in pa.rooms if rid not in pb.rooms), None]
    groups = []
    for room_id in room_order:
        members = [c for c in changes if c["room_id"] == room_id]
        if members:
            groups.append({"room_id": room_id, "room_name": members[0]["room_name"], "change_ids": [c["change_id"] for c in members]})
    return {"summary": summary, "changes": changes, "groups": groups}
