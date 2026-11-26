// The canonical 2D plan and every edit to it. Pure functions: a plan is never mutated,
// each edit returns a new plan (which is what makes undo and versioning trivial).
// Units are centimetres, origin top-left, y grows downward. Furniture x/y is the item's centre.
// The backend validates the same shape in backend/app/schemas.py.

export const GRID = 10;
export const MIN_WALL = 10;
const THICKNESS = { exterior: 20, partition: 10 };
const OPENING_WIDTH = { door: 80, window: 120 };
const ROW_WIDTH = 1500; // wizard rooms wrap to a new row past this
const POSITIVE = new Set(["w", "d", "width", "thickness"]);

export const snap = (value, grid = GRID) => Math.round(value / grid) * grid;
export const wallLength = (wall) => Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
// getRandomValues works on plain HTTP too (randomUUID needs a secure context), e.g. when testing from a phone on the LAN.
const uid = (prefix) => `${prefix}_${Array.from(crypto.getRandomValues(new Uint8Array(5)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;

export const emptyPlan = () => ({ schema: 1, units: "cm", rooms: [], walls: [], openings: [], furniture: [] });

// Keeps every opening inside its wall and drops openings whose wall is gone.
function normalize(plan) {
  const walls = new Map(plan.walls.map((wall) => [wall.id, wall]));
  const openings = plan.openings.flatMap((opening) => {
    const wall = walls.get(opening.wallId);
    if (!wall) return [];
    const length = wallLength(wall);
    const width = Math.min(opening.width, length);
    const offset = clamp(opening.offset, 0, length - width);
    return [width === opening.width && offset === opening.offset ? opening : { ...opening, width, offset }];
  });
  return { ...plan, openings };
}

export function addRoom(plan, { name, type, width, length }, x, y) {
  const room = { id: uid("r"), name, type };
  const corners = [[x, y], [x + width, y], [x + width, y + length], [x, y + length]];
  const walls = corners.map(([x1, y1], i) => {
    const [x2, y2] = corners[(i + 1) % 4];
    return { id: uid("w"), x1, y1, x2, y2, thickness: THICKNESS.exterior, kind: "exterior", roomId: room.id };
  });
  return { ...plan, rooms: [...plan.rooms, room], walls: [...plan.walls, ...walls] };
}

export function fromRooms(rooms) {
  let plan = emptyPlan();
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const room of rooms) {
    if (x > 0 && x + room.width > ROW_WIDTH) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    plan = addRoom(plan, room, x, y);
    x += room.width;
    rowHeight = Math.max(rowHeight, room.length);
  }
  return plan;
}

export function addWall(plan, a, b, kind) {
  const wall = { id: uid("w"), x1: a.x, y1: a.y, x2: b.x, y2: b.y, thickness: THICKNESS[kind], kind };
  return wallLength(wall) < MIN_WALL ? plan : { ...plan, walls: [...plan.walls, wall] };
}

// `along` is where on the wall (cm from its start) the opening should be centred.
export function addOpening(plan, wallId, type, along) {
  const width = OPENING_WIDTH[type];
  const opening = { id: uid("o"), wallId, type, offset: along - width / 2, width };
  return normalize({ ...plan, openings: [...plan.openings, opening] });
}

export function addFurniture(plan, { type, w, d }, x, y) {
  const item = { id: uid("f"), type, x: snap(x), y: snap(y), w, d, rotation: 0 };
  return { ...plan, furniture: [...plan.furniture, item] };
}

// kind is the collection name: "rooms" | "walls" | "openings" | "furniture".
export function patch(plan, kind, id, changes) {
  const valid = Object.entries(changes).filter(
    ([key, value]) => typeof value !== "number" || (Number.isFinite(value) && (!POSITIVE.has(key) || value > 0)),
  );
  const clean = Object.fromEntries(valid);
  if ("rotation" in clean) clean.rotation = ((clean.rotation % 360) + 360) % 360;
  return normalize({ ...plan, [kind]: plan[kind].map((item) => (item.id === id ? { ...item, ...clean } : item)) });
}

export function remove(plan, kind, id) {
  const without = { ...plan, [kind]: plan[kind].filter((item) => item.id !== id) };
  if (kind === "rooms") return normalize({ ...without, walls: without.walls.filter((wall) => wall.roomId !== id) });
  if (kind !== "walls") return without;
  // A room only exists as its walls: once the last one is gone it could no longer be seen, selected or deleted.
  const walled = new Set(without.walls.map((wall) => wall.roomId));
  return normalize({ ...without, rooms: without.rooms.filter((room) => walled.has(room.id)) });
}

const shiftWall = (wall, dx, dy) => ({ ...wall, x1: wall.x1 + dx, y1: wall.y1 + dy, x2: wall.x2 + dx, y2: wall.y2 + dy });

export function translate(plan, kind, id, dx, dy) {
  if (!dx && !dy) return plan;
  if (kind === "rooms") return { ...plan, walls: plan.walls.map((wall) => (wall.roomId === id ? shiftWall(wall, dx, dy) : wall)) };
  if (kind === "walls") return { ...plan, walls: plan.walls.map((wall) => (wall.id === id ? shiftWall(wall, dx, dy) : wall)) };
  if (kind === "furniture") {
    return { ...plan, furniture: plan.furniture.map((item) => (item.id === id ? { ...item, x: item.x + dx, y: item.y + dy } : item)) };
  }
  return plan;
}

export function moveWallEnd(plan, id, end, x, y) {
  const wall = plan.walls.find((candidate) => candidate.id === id);
  const moved = end === 1 ? { ...wall, x1: x, y1: y } : { ...wall, x2: x, y2: y };
  return wallLength(moved) < MIN_WALL ? plan : patch(plan, "walls", id, moved);
}

export function setWallLength(plan, id, length) {
  const wall = plan.walls.find((candidate) => candidate.id === id);
  const scale = length / wallLength(wall);
  return moveWallEnd(plan, id, 2, wall.x1 + (wall.x2 - wall.x1) * scale, wall.y1 + (wall.y2 - wall.y1) * scale);
}

export function projectOnWall(wall, point) {
  const length = wallLength(wall);
  const ux = (wall.x2 - wall.x1) / length;
  const uy = (wall.y2 - wall.y1) / length;
  const along = clamp((point.x - wall.x1) * ux + (point.y - wall.y1) * uy, 0, length);
  const distance = Math.hypot(point.x - (wall.x1 + ux * along), point.y - (wall.y1 + uy * along));
  return { along, distance };
}

export function nearestWall(plan, point, maxDistance) {
  let best = null;
  for (const wall of plan.walls) {
    const hit = projectOnWall(wall, point);
    if (hit.distance <= maxDistance && (!best || hit.distance < best.distance)) best = { wall, ...hit };
  }
  return best;
}

// End points of an opening, for drawing it on top of its wall.
export function openingSegment(wall, opening) {
  const length = wallLength(wall);
  const ux = (wall.x2 - wall.x1) / length;
  const uy = (wall.y2 - wall.y1) / length;
  const end = opening.offset + opening.width;
  return { x1: wall.x1 + ux * opening.offset, y1: wall.y1 + uy * opening.offset, x2: wall.x1 + ux * end, y2: wall.y1 + uy * end, ux, uy };
}

function box(points) {
  if (points.length === 0) return null;
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

const wallPoints = (walls) => walls.flatMap((wall) => [[wall.x1, wall.y1], [wall.x2, wall.y2]]);

export const roomBox = (plan, roomId) => box(wallPoints(plan.walls.filter((wall) => wall.roomId === roomId)));

export function planBox(plan) {
  const reach = (item) => Math.hypot(item.w, item.d) / 2;
  const furniture = plan.furniture.flatMap((item) => [
    [item.x - reach(item), item.y - reach(item)],
    [item.x + reach(item), item.y + reach(item)],
  ]);
  return box([...wallPoints(plan.walls), ...furniture]) ?? { x: 0, y: 0, w: 600, h: 400 };
}

export const metres = (cm) => (cm / 100).toFixed(2);
export const squareMetres = (b) => (b ? (b.w * b.h) / 10_000 : 0);
export const planArea = (plan) => plan.rooms.reduce((total, room) => total + squareMetres(roomBox(plan, room.id)), 0);

export function duplicateFurniture(plan, id) {
  const item = plan.furniture.find((candidate) => candidate.id === id);
  return { ...plan, furniture: [...plan.furniture, { ...item, id: uid("f"), x: item.x + 2 * GRID, y: item.y + 2 * GRID }] };
}

export const isPlan = (value) =>
  value?.schema === 1 && ["rooms", "walls", "openings", "furniture"].every((key) => Array.isArray(value[key]));

const HISTORY_LIMIT = 100;

export const history = {
  start: (plan) => ({ past: [], present: plan, future: [] }),
  push: (h, plan) =>
    plan === h.present ? h : { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: plan, future: [] },
  undo: (h) =>
    h.past.length === 0 ? h : { past: h.past.slice(0, -1), present: h.past.at(-1), future: [h.present, ...h.future] },
  redo: (h) =>
    h.future.length === 0 ? h : { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) },
};

// Copilot changes (the action list in backend/app/copilot.py), used to preview a suggestion on the canvas.
// Unknown action types and items are skipped; the server checks everything again when a change is applied.
const ACTION_KEYS = { move_object: ["x", "y"], rotate_object: ["rotation"], resize_object: ["w", "d"] };

export function applyActions(plan, actions) {
  return actions.reduce((next, action) => {
    if (!next.furniture.some((item) => item.id === action.object_id)) return next;
    if (action.type === "remove_object") return remove(next, "furniture", action.object_id);
    const keys = ACTION_KEYS[action.type];
    return keys ? patch(next, "furniture", action.object_id, Object.fromEntries(keys.map((key) => [key, action[key]]))) : next;
  }, plan);
}
