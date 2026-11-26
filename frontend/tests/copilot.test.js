import assert from "node:assert/strict";
import { test } from "node:test";

import { describeAction, roomOf, scopeTargets } from "../js/copilot-logic.js";
import * as P from "../js/plan.js";

const plan = () => {
  const base = P.fromRooms([{ name: "Living room", type: "living", width: 500, length: 400 }]);
  return { ...base, furniture: [{ id: "f1", type: "sofa", x: 200, y: 200, w: 200, d: 90, rotation: 0 }, { id: "f2", type: "sofa", x: 5000, y: 5000, w: 200, d: 90, rotation: 0 }] };
};

test("an item belongs to the room that contains its centre, or to none", () => {
  const p = plan();
  assert.equal(roomOf(p, p.furniture[0]).name, "Living room");
  assert.equal(roomOf(p, p.furniture[1]), undefined);
});

test("scope follows the selection: item and its room, a room alone, or nothing", () => {
  const p = plan();
  const room = p.rooms[0];
  assert.deepEqual(scopeTargets(p, { kind: "furniture", id: "f1" }), { room, item: p.furniture[0] });
  assert.deepEqual(scopeTargets(p, { kind: "rooms", id: room.id }), { room, item: null });
  assert.deepEqual(scopeTargets(p, { kind: "furniture", id: "f2" }), { room: null, item: p.furniture[1] });
  assert.deepEqual(scopeTargets(p, null), { room: null, item: null });
  assert.deepEqual(scopeTargets(p, { kind: "walls", id: p.walls[0].id }), { room: null, item: null });
  assert.deepEqual(scopeTargets(p, { kind: "furniture", id: "gone" }), { room: null, item: null });
});

test("actions are described in designer terms", () => {
  const p = plan();
  assert.equal(describeAction(p, { type: "move_object", object_id: "f1", x: 230, y: 240 }), "Move Sofa to 230, 240 (50 cm)");
  assert.equal(describeAction(p, { type: "rotate_object", object_id: "f1", rotation: 90 }), "Rotate Sofa to 90°");
  assert.equal(describeAction(p, { type: "resize_object", object_id: "f1", w: 180.4, d: 85 }), "Resize Sofa to 180 × 85 cm");
  assert.equal(describeAction(p, { type: "remove_object", object_id: "f1" }), "Remove Sofa");
  assert.equal(describeAction(p, { type: "move_object", object_id: "ghost", x: 1, y: 2 }), "Move ghost to 1, 2");
  assert.equal(describeAction(p, { type: "paint", object_id: "f1" }), "Unknown change");
});
