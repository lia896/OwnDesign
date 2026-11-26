import assert from "node:assert/strict";
import { test } from "node:test";
import * as P from "../js/plan.js";
import { FURNITURE } from "../js/catalog.js";
import { FURNITURE_HEIGHT, HEIGHT, RADIUS, startPoint, walk, wallSolids } from "../js/plan3d.js";

// One 400 x 300 room; walls are ordered top, right, bottom, left.
const room = () => P.addRoom(P.emptyPlan(), { name: "A", type: "living", width: 400, length: 300 }, 0, 0);
const withOpening = (plan, wall, type, along) => P.addOpening(plan, plan.walls[wall].id, type, along);
// Solids that stand in the way at eye level at the given plan point.
const blocking = (solids, x, y) =>
  solids.filter((s) => {
    const dx = x - s.x;
    const dy = y - s.y;
    const u = dx * Math.cos(s.angle) + dy * Math.sin(s.angle);
    const v = dy * Math.cos(s.angle) - dx * Math.sin(s.angle);
    return s.z0 < HEIGHT.eye && Math.abs(u) <= s.length / 2 && Math.abs(v) <= s.thickness / 2;
  });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.01, `${actual} is not ${expected}`);

test("an empty plan has no solids and a finite start point", () => {
  assert.deepEqual(wallSolids(P.emptyPlan()), []);
  const start = startPoint(P.emptyPlan());
  assert.ok(Number.isFinite(start.x) && Number.isFinite(start.y));
});

test("walls without openings are full height and close the corners", () => {
  const solids = wallSolids(room());
  assert.equal(solids.length, 4);
  for (const s of solids) assert.deepEqual([s.kind, s.z0, s.z1], ["wall", 0, HEIGHT.wall]);
  near(solids[0].length, 420);
});

test("a door leaves a gap at eye level and keeps the wall above it", () => {
  const solids = wallSolids(withOpening(room(), 0, "door", 200));
  assert.equal(blocking(solids, 200, 0).length, 0);
  assert.equal(blocking(solids, 100, 0).length, 1);
  const lintel = solids.find((s) => s.z0 === HEIGHT.door);
  near(lintel.length, 80);
});

test("a door at the very end of a wall stays open", () => {
  const solids = wallSolids(withOpening(room(), 0, "door", 0));
  assert.equal(blocking(solids, 40, 0).filter((s) => s.angle === 0).length, 0);
});

test("a window as wide as its wall gives sill, glass and top", () => {
  let plan = withOpening(room(), 0, "window", 200);
  plan = P.patch(plan, "openings", plan.openings[0].id, { width: 5000 });
  const top = wallSolids(plan).filter((s) => s.angle === 0 && s.y === 0);
  assert.deepEqual(top.map((s) => [s.kind, s.z0, s.z1]), [
    ["wall", 0, HEIGHT.sill],
    ["glass", HEIGHT.sill, HEIGHT.head],
    ["wall", HEIGHT.head, HEIGHT.wall],
  ]);
});

for (const side of ["left room", "right room"]) {
  test(`a door in the ${side}'s wall also opens the wall that overlaps it`, () => {
    // The two shared walls run in opposite directions.
    const plan = P.fromRooms([
      { name: "A", type: "living", width: 400, length: 300 },
      { name: "B", type: "bedroom", width: 300, length: 300 },
    ]);
    const solids = wallSolids(withOpening(plan, side === "left room" ? 1 : 7, "door", 100));
    const y = side === "left room" ? 100 : 200;
    assert.equal(blocking(solids, 400, y).length, 0);
    const through = walk({ x: 300, y }, { dx: 200, dy: 0 }, solids);
    near(through.x, 500);
  });
}

test("an opening does not cut a wall that only meets it at a corner", () => {
  const solids = wallSolids(withOpening(room(), 0, "door", 0));
  assert.equal(blocking(solids, 0, 40).length, 1);
});

test("walls stop the walker, even in one huge step", () => {
  const solids = wallSolids(room());
  const end = walk({ x: 200, y: 150 }, { dx: 5000, dy: 0 }, solids);
  near(end.x, 400 - 10 - RADIUS);
  near(end.y, 150);
});

test("walking into a wall at an angle slides along it", () => {
  const end = walk({ x: 100, y: 60 }, { dx: 100, dy: -100 }, wallSolids(room()));
  near(end.x, 200);
  near(end.y, 10 + RADIUS);
});

test("a corner cannot be squeezed through", () => {
  const end = walk({ x: 100, y: 100 }, { dx: -900, dy: -900 }, wallSolids(room()));
  assert.ok(end.x >= 10 + RADIUS - 0.01 && end.y >= 10 + RADIUS - 0.01);
});

test("a door lets the walker out and a window does not", () => {
  const door = walk({ x: 200, y: 150 }, { dx: 0, dy: -300 }, wallSolids(withOpening(room(), 0, "door", 200)));
  near(door.y, -150);
  const window = walk({ x: 200, y: 150 }, { dx: 0, dy: -300 }, wallSolids(withOpening(room(), 0, "window", 200)));
  near(window.y, 10 + RADIUS);
});

test("a start point inside a wall is pushed out of it", () => {
  const plan = P.addWall(room(), { x: 0, y: 150 }, { x: 400, y: 150 }, "partition");
  const start = startPoint(plan);
  assert.equal(blocking(wallSolids(plan), start.x, start.y).length, 0);
  near(Math.abs(start.y - 150), 5 + RADIUS);
});

for (const degrees of [3, 10, 30]) {
  test(`walls meeting at ${degrees} degrees cannot be walked through`, () => {
    const angle = (degrees * Math.PI) / 180;
    const slope = Math.tan(angle);
    let plan = P.addWall(P.emptyPlan(), { x: 0, y: 0 }, { x: 3000, y: 0 }, "partition");
    plan = P.addWall(plan, { x: 0, y: 0 }, { x: 3000, y: 3000 * slope }, "partition");
    const solids = wallSolids(plan);
    // Start between the walls, where there is room to stand, and walk into the point where they meet.
    const x = 2000;
    let at = { x, y: (x * slope) / 2 };
    for (let i = 0; i < 300; i++) at = walk(at, { dx: -11, dy: -5.5 * slope }, solids);
    assert.ok(at.x > 0 && at.y > 0 && at.y < at.x * slope, `escaped to ${at.x}, ${at.y}`);
  });
}

test("a plan with an absurd number of overlapping openings is refused quickly", () => {
  let plan = room();
  const [wall] = plan.walls;
  plan = {
    ...plan,
    walls: Array.from({ length: 100 }, (_, i) => ({ ...wall, id: `w${i}` })),
    openings: Array.from({ length: 1000 }, (_, i) => ({ id: `o${i}`, wallId: "w0", type: "window", offset: i * 0.3, width: 50 })),
  };
  assert.throws(() => wallSolids(plan), RangeError);
});

test("every catalog item has a height below the ceiling", () => {
  for (const { type } of FURNITURE) assert.ok(FURNITURE_HEIGHT[type] > 0 && FURNITURE_HEIGHT[type] < HEIGHT.wall, type);
});
