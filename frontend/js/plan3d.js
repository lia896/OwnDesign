// Turns the 2D plan into what the 3D walkthrough shows and collides with. Pure functions, centimetres.
// Coordinates are the plan's (x right, y down) plus z for height.
import { openingSegment, planBox, roomBox, wallLength } from "./plan.js";

// The plan stores no heights, so the walkthrough assumes typical residential ones.
export const HEIGHT = { wall: 260, door: 210, sill: 90, head: 210, eye: 160 };
export const FURNITURE_HEIGHT = {
  sofa: 80, armchair: 85, "coffee-table": 40, "tv-unit": 50, "dining-table": 75, chair: 90,
  "double-bed": 55, "single-bed": 55, wardrobe: 220, desk: 75,
  "kitchen-counter": 90, "kitchen-island": 90, sink: 90, stove: 90, fridge: 180,
  toilet: 45, bathtub: 55, shower: 10, vanity: 85,
};
export const RADIUS = 20; // how close the walker's centre may get to a wall
const STEP = 5; // smaller than RADIUS, so no step can jump over a wall
// shortcut: real plans stay far below this; merge overlapping walls before cutting if one ever reaches it.
const MAX_HOLES = 5000;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const BANDS = {
  solid: [["wall", 0, HEIGHT.wall]],
  door: [["wall", HEIGHT.door, HEIGHT.wall]],
  window: [["wall", 0, HEIGHT.sill], ["glass", HEIGHT.sill, HEIGHT.head], ["wall", HEIGHT.head, HEIGHT.wall]],
};

// Boxes { kind, x, y, angle, length, thickness, z0, z1 }, with x/y at the box's centre.
export function wallSolids(plan) {
  const walls = new Map(plan.walls.map((wall) => [wall.id, wall]));
  const openings = plan.openings.map((opening) => {
    const host = walls.get(opening.wallId);
    return { ...openingSegment(host, opening), type: opening.type, thickness: host.thickness };
  });

  let cutsLeft = MAX_HOLES;
  return plan.walls.flatMap((wall) => {
    const length = wallLength(wall);
    const ux = (wall.x2 - wall.x1) / length;
    const uy = (wall.y2 - wall.y1) / length;
    const along = (x, y) => clamp((x - wall.x1) * ux + (y - wall.y1) * uy, 0, length);
    const away = (x, y) => Math.abs((y - wall.y1) * ux - (x - wall.x1) * uy);

    // Adjacent rooms have two walls in the same place, so an opening cuts every wall lying along it.
    const holes = openings.flatMap((o) => {
      const reach = Math.max(wall.thickness, o.thickness) / 2;
      if (away(o.x1, o.y1) > reach || away(o.x2, o.y2) > reach) return [];
      const [from, to] = [along(o.x1, o.y1), along(o.x2, o.y2)].sort((a, b) => a - b);
      return to - from > 0.5 ? [{ type: o.type, from, to }] : [];
    });
    // The server accepts many overlapping walls and openings, and cutting them all would freeze the tab.
    cutsLeft -= holes.length;
    if (cutsLeft < 0) throw new RangeError("This plan has too many overlapping openings for the 3D view.");

    const cuts = [0, length, ...holes.flatMap((hole) => [hole.from, hole.to])].sort((a, b) => a - b);
    return cuts.slice(1).flatMap((end, i) => {
      const start = cuts[i];
      if (end - start <= 0.5) return [];
      const here = holes.filter((hole) => hole.from < (start + end) / 2 && hole.to > (start + end) / 2);
      const type = here.some((hole) => hole.type === "door") ? "door" : here.length ? "window" : "solid";
      // Solid ends reach half a thickness further, so corners have no notch.
      const from = type === "solid" && start === 0 ? -wall.thickness / 2 : start;
      const to = type === "solid" && end === length ? length + wall.thickness / 2 : end;
      const middle = (from + to) / 2;
      return BANDS[type].map(([kind, z0, z1]) => ({
        kind, z0, z1,
        x: wall.x1 + ux * middle,
        y: wall.y1 + uy * middle,
        angle: Math.atan2(uy, ux),
        length: to - from,
        thickness: wall.thickness,
      }));
    });
  });
}

// A point in a box's own axes, with the nearest spot of the box and the distance to it.
function measure(point, solid) {
  const cos = Math.cos(solid.angle);
  const sin = Math.sin(solid.angle);
  const dx = point.x - solid.x;
  const dy = point.y - solid.y;
  const u = dx * cos + dy * sin;
  const v = dy * cos - dx * sin;
  const cu = clamp(u, -solid.length / 2, solid.length / 2);
  const cv = clamp(v, -solid.thickness / 2, solid.thickness / 2);
  return { cos, sin, u, v, cu, cv, distance: Math.hypot(u - cu, v - cv) };
}

// Moves a point out of one box, if it is closer than RADIUS to it.
function pushOut(point, solid) {
  let { cos, sin, u, v, cu, cv, distance } = measure(point, solid);
  if (distance >= RADIUS) return point;
  if (distance > 0) {
    u = cu + ((u - cu) / distance) * RADIUS;
    v = cv + ((v - cv) / distance) * RADIUS;
  } else {
    v = (v < 0 ? -1 : 1) * (solid.thickness / 2 + RADIUS); // inside the box: leave through the nearer face
  }
  return { x: solid.x + u * cos - v * sin, y: solid.y + u * sin + v * cos };
}

const isClear = (point, solids) => solids.every((solid) => measure(point, solid).distance >= RADIUS - 0.01);

export function walk(position, { dx, dy }, solids) {
  const inTheWay = solids.filter((solid) => solid.z0 < HEIGHT.eye);
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / STEP));
  let point = position;
  let clear = isClear(point, inTheWay);
  for (let i = 0; i < steps; i++) {
    const next = inTheWay.reduce(pushOut, { x: point.x + dx / steps, y: point.y + dy / steps });
    const nextClear = isClear(next, inTheWay);
    // Between walls meeting at a sharp angle, leaving one pushes into the other: such a step is not taken.
    if (clear && !nextClear) break;
    point = next;
    clear = nextClear;
  }
  return point;
}

// The middle of the first room, or of the whole plan when it has no rooms.
export function startPoint(plan) {
  const box = (plan.rooms[0] && roomBox(plan, plan.rooms[0].id)) || planBox(plan);
  return walk({ x: box.x + box.w / 2, y: box.y + box.h / 2 }, { dx: 0, dy: 0 }, wallSolids(plan));
}
