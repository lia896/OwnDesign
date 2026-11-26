import assert from "node:assert/strict";
import { test } from "node:test";

import { changeLine, changeTitle, defaultPair, detailRows, filterGroups, focusBox, marks, resolveGroups, versionName } from "../js/compare-logic.js";

const moved = {
  change_id: "furniture:f1", entity_id: "f1", entity_type: "furniture", furniture_type: "sofa", change_type: "moved", room_id: "r2", room_name: "Bedroom",
  changed_properties: ["position", "room"], before: { x: 200, y: 300, room_id: "r1" }, after: { x: 240, y: 330, room_id: "r2" }, distance_cm: 50,
  box_a: { x: 100, y: 255, w: 200, h: 90 }, box_b: { x: 140, y: 285, w: 200, h: 90 },
};
const added = { change_id: "furniture:f2", entity_id: "f2", entity_type: "furniture", furniture_type: "armchair", change_type: "added", room_id: "r1", changed_properties: [], before: null, after: null, box_a: null, box_b: { x: 0, y: 0, w: 85, h: 85 } };
const wall = { change_id: "wall:w1", entity_id: "w1", entity_type: "wall", label: "exterior", change_type: "structural", detail: "changed", room_id: "r1", changed_properties: ["position", "thickness"], before: { position: [0, 0, 500, 0], thickness: 20 }, after: { position: [0, 50, 500, 50], thickness: 25 }, box_a: { x: 0, y: -10, w: 500, h: 20 }, box_b: { x: 0, y: 40, w: 500, h: 20 } };
const rooms = { r1: "Living room", r2: "Bedroom" };
const roomName = (id) => rooms[id] ?? null;

test("defaults to the newest version against the one before it", () => {
  const versions = [{ id: "c", version_no: 3 }, { id: "b", version_no: 2 }, { id: "a", version_no: 1 }];
  assert.deepEqual(defaultPair(versions), { a: "b", b: "c" });
  assert.equal(defaultPair(versions.slice(0, 1)), null);
  assert.equal(defaultPair([]), null);
  assert.equal(defaultPair(null), null);
  assert.equal(versionName({ version_no: 4, label: "Client review" }), "v4 · Client review");
  assert.equal(versionName({ version_no: 4, label: "" }), "v4");
});

test("changes are titled and described in plain words", () => {
  assert.equal(changeTitle(moved), "Sofa");
  assert.equal(changeTitle(wall), "Exterior wall");
  assert.equal(changeTitle({ entity_type: "room", room_name: "Bedroom" }), "Room: Bedroom");
  assert.equal(changeTitle({ entity_type: "furniture", furniture_type: "floor-lamp" }), "floor lamp");
  assert.equal(changeLine(moved, roomName), "Moved 50 cm, now in Bedroom");
  assert.equal(changeLine(added), "New in version B");
  assert.equal(changeLine({ ...added, change_type: "removed" }), "No longer in version B");
  assert.equal(changeLine({ ...wall, detail: "removed" }), "No longer in version B");
  assert.equal(changeLine(wall), "Moved, thickness changed");
  assert.equal(changeLine({ change_type: "rotated", changed_properties: ["rotation"], before: { rotation: 0 }, after: { rotation: 90 } }), "Rotated 0° → 90°");
});

test("details show only what changed, in readable units", () => {
  assert.deepEqual(detailRows(moved, roomName), [
    { property: "Position (centre)", a: "200, 300 cm", b: "240, 330 cm" },
    { property: "Room", a: "Living room", b: "Bedroom" },
  ]);
  assert.deepEqual(detailRows(wall, roomName), [
    { property: "Position", a: "0, 0 cm to 500, 0 cm", b: "0, 50 cm to 500, 50 cm" },
    { property: "Thickness", a: "20 cm", b: "25 cm" },
  ]);
  assert.deepEqual(detailRows({ entity_type: "furniture", changed_properties: ["size", "type"], before: { w: 200, d: 90, type: "sofa" }, after: { w: 220.4, d: 90, type: "armchair" } }), [
    { property: "Size", a: "200 cm × 90 cm", b: "220 cm × 90 cm" },
    { property: "Item", a: "Sofa", b: "Armchair" },
  ]);
  assert.deepEqual(detailRows(added), []); // nothing to compare: no invented values
});

test("filters by kind and by room, dropping empty groups", () => {
  const groups = [{ room_id: "r1", changes: [added, wall] }, { room_id: "r2", changes: [moved] }, { room_id: null, changes: [{ ...added, room_id: null }] }];
  assert.equal(filterGroups(groups).length, 3);
  assert.deepEqual(filterGroups(groups, { kind: "moved" }).map((g) => g.room_id), ["r2"]);
  assert.deepEqual(filterGroups(groups, { room: "r1", kind: "structural" })[0].changes, [wall]);
  assert.deepEqual(filterGroups(groups, { room: "none" }).map((g) => g.room_id), [null]);
  assert.deepEqual(filterGroups(groups, { room: "r2", kind: "added" }), []);
  assert.deepEqual(filterGroups([], { kind: "added" }), []);
});

test("focus covers both locations of a change", () => {
  assert.deepEqual(focusBox(moved, 0), { x: 100, y: 255, w: 240, h: 120 });
  assert.deepEqual(focusBox(added, 10), { x: -10, y: -10, w: 105, h: 105 });
  assert.equal(focusBox({ box_a: null, box_b: null }), null);
});

test("marks follow the side: removed only on A, added only on B", () => {
  const removed = { ...added, entity_id: "f3", change_type: "removed", box_a: added.box_b, box_b: null };
  const all = [moved, added, removed, wall];
  assert.deepEqual(marks(all, "a").map((m) => [m.kind, m.id, m.tone]), [["furniture", "f1", "changed"], ["furniture", "f3", "removed"], ["walls", "w1", "structural"]]);
  assert.deepEqual(marks(all, "b").map((m) => [m.kind, m.id, m.tone]), [["furniture", "f1", "changed"], ["furniture", "f2", "added"], ["walls", "w1", "structural"]]);
});

test("groups get their changes back from the ids, skipping unknown ids", () => {
  const groups = resolveGroups([{ room_id: "r1", room_name: "Living room", change_ids: ["furniture:f2", "wall:w1", "gone"] }], [added, wall, moved]);
  assert.deepEqual(groups, [{ room_id: "r1", room_name: "Living room", changes: [added, wall] }]);
  assert.deepEqual(resolveGroups([], []), []);
});
