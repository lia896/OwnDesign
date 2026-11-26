// Draws a plan into an <svg>. The whole drawing is rebuilt on every change: residential plans are a few
// hundred elements, so this stays fast and there is no stale state to reconcile.
// User text (room names) only ever enters as text nodes.
import { FURNITURE_BY_TYPE } from "../catalog.js";
import { metres, openingSegment, roomBox, squareMetres, wallLength } from "../plan.js";

const NS = "http://www.w3.org/2000/svg";
const RULER_PX = 22;
const RULER_STEPS_M = [0.5, 1, 2, 5, 10, 20, 50];

export function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) if (value != null) node.setAttribute(key, value);
  node.append(...children.flat().filter((child) => child != null && child !== false));
  return node;
}

// The part of the plan currently on screen, in plan centimetres, and how many cm one screen pixel covers.
export function visibleArea(canvas) {
  const inverse = canvas.getScreenCTM()?.inverse();
  const rect = canvas.getBoundingClientRect();
  if (!inverse || rect.width === 0) return { x: 0, y: 0, w: 1000, h: 800, scale: 1 };
  const a = new DOMPoint(rect.left, rect.top).matrixTransform(inverse);
  const b = new DOMPoint(rect.right, rect.bottom).matrixTransform(inverse);
  return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y, scale: (b.x - a.x) / rect.width };
}

function grid(area) {
  const showMinor = 10 / area.scale >= 8; // only when 10 cm is at least 8 px wide
  const pattern = (id, size, cls) =>
    svg("pattern", { id, width: size, height: size, patternUnits: "userSpaceOnUse" },
      svg("path", { d: `M${size} 0H0V${size}`, fill: "none", class: cls, "stroke-width": 1, "vector-effect": "non-scaling-stroke" }));
  const fill = (id) => svg("rect", { x: area.x, y: area.y, width: area.w, height: area.h, fill: `url(#${id})`, "pointer-events": "none" });
  return [
    svg("defs", {}, pattern("grid-major", 100, "grid-major"), showMinor && pattern("grid-minor", 10, "grid-minor")),
    showMinor && fill("grid-minor"),
    fill("grid-major"),
  ];
}

function rulers(area) {
  const { x, y, w, h, scale } = area;
  const band = RULER_PX * scale;
  const step = (RULER_STEPS_M.find((m) => (m * 100) / scale >= 60) ?? 100) * 100;
  const font = 10 * scale;
  const label = (cm) => `${(cm / 100).toFixed(step < 100 ? 1 : 0)}m`;
  const marks = [];
  for (let cm = Math.ceil((x + band) / step) * step; cm < x + w; cm += step) {
    marks.push(
      svg("line", { x1: cm, y1: y + band * 0.6, x2: cm, y2: y + band, class: "ruler-tick", "stroke-width": scale }),
      svg("text", { x: cm + 3 * scale, y: y + band * 0.55, "font-size": font, class: "ruler-text" }, label(cm)),
    );
  }
  for (let cm = Math.ceil((y + band) / step) * step; cm < y + h; cm += step) {
    marks.push(
      svg("line", { x1: x + band * 0.6, y1: cm, x2: x + band, y2: cm, class: "ruler-tick", "stroke-width": scale }),
      svg("text", { x: x + band * 0.55, y: cm - 3 * scale, "font-size": font, class: "ruler-text", transform: `rotate(-90 ${x + band * 0.55} ${cm - 3 * scale})` }, label(cm)),
    );
  }
  return svg("g", { "pointer-events": "none" },
    svg("rect", { x, y, width: w, height: band, class: "ruler" }),
    svg("rect", { x, y, width: band, height: h, class: "ruler" }),
    marks,
  );
}

// A dark measurement pill that keeps a constant on-screen size.
function chip(x, y, text, scale) {
  const font = 11 * scale;
  const width = (text.length * 0.62 + 1.4) * font;
  const height = font * 1.7;
  return svg("g", { "pointer-events": "none" },
    svg("rect", { x: x - width / 2, y: y - height / 2, width, height, rx: 3 * scale, class: "chip-bg" }),
    svg("text", { x, y: y + font * 0.35, "text-anchor": "middle", "font-size": font, class: "chip-text" }, text),
  );
}

const focusable = (kind, id, label, cls) => ({ "data-kind": kind, "data-id": id, tabindex: 0, role: "button", "aria-label": label, class: cls });

function wallNode(wall, selected) {
  const line = (cls, width) => svg("line", { x1: wall.x1, y1: wall.y1, x2: wall.x2, y2: wall.y2, class: cls, "stroke-width": width });
  const name = wall.kind === "exterior" ? "Exterior wall" : "Partition";
  return svg("g", focusable("walls", wall.id, `${name}, ${metres(wallLength(wall))} m`, selected ? "selected" : ""),
    line(`wall ${wall.kind}`, wall.thickness),
    line("hit", Math.max(wall.thickness, 36)),
  );
}

function openingNode(opening, wall, selected) {
  const s = openingSegment(wall, opening);
  const nx = -s.uy; // unit normal to the wall
  const ny = s.ux;
  const t = wall.thickness;
  const along = (cls, width, shift = 0) =>
    svg("line", { x1: s.x1 + nx * shift, y1: s.y1 + ny * shift, x2: s.x2 + nx * shift, y2: s.y2 + ny * shift, class: cls, "stroke-width": width });
  const symbol =
    opening.type === "door"
      ? [
          // Door leaf standing open at 90 degrees, and the arc it sweeps when closing.
          svg("line", { x1: s.x1, y1: s.y1, x2: s.x1 + nx * opening.width, y2: s.y1 + ny * opening.width, class: "symbol" }),
          svg("path", { d: `M${s.x1 + nx * opening.width} ${s.y1 + ny * opening.width} A${opening.width} ${opening.width} 0 0 0 ${s.x2} ${s.y2}`, class: "symbol", "stroke-dasharray": "6 6" }),
        ]
      : [along("symbol", 2, t / 4), along("symbol", 2, -t / 4)];
  const label = `${opening.type === "door" ? "Door" : "Window"}, ${Math.round(opening.width)} cm wide`;
  return svg("g", focusable("openings", opening.id, label, selected ? "selected" : ""), along("gap", t + 4), symbol, along("hit", Math.max(t, 36)));
}

function furnitureNode(item, selected, changed) {
  const spec = FURNITURE_BY_TYPE.get(item.type);
  const label = spec?.label ?? item.type;
  const font = Math.min(Math.max(Math.min(item.w, item.d) * 0.16, 9), 15);
  const cls = ["item", spec?.review && "review", selected && "selected", changed && "changed"].filter(Boolean).join(" ");
  return svg("g", { ...focusable("furniture", item.id, `${label}, ${Math.round(item.w)} by ${Math.round(item.d)} cm`, cls), transform: `translate(${item.x} ${item.y}) rotate(${item.rotation})` },
    svg("rect", { x: -item.w / 2, y: -item.d / 2, width: item.w, height: item.d, rx: 4 }),
    svg("text", { y: font * 0.35, "text-anchor": "middle", "font-size": font }, label),
  );
}

function roomNode(plan, room, selected, scale) {
  const b = roomBox(plan, room.id);
  if (!b) return null;
  const cx = b.x + b.w / 2;
  const cy = b.y + Math.min(b.h / 2, 60);
  const nameSize = Math.max(22, 13 * scale); // never smaller than 13 px on screen
  const metaSize = Math.max(13, 10 * scale);
  const width = Math.max(room.name.length * nameSize * 0.6, nameSize * 5);
  return svg("g", focusable("rooms", room.id, `Room ${room.name}, ${squareMetres(b).toFixed(1)} square metres`, selected ? "selected" : ""),
    svg("rect", { x: cx - width / 2, y: cy - nameSize * 1.3, width, height: nameSize * 2.8, class: "room-hit" }),
    svg("text", { x: cx, y: cy, "text-anchor": "middle", "font-size": nameSize, class: "room-name" }, room.name),
    svg("text", { x: cx, y: cy + metaSize * 1.6, "text-anchor": "middle", "font-size": metaSize, class: "room-meta" }, `${squareMetres(b).toFixed(1)} m²`),
  );
}

// One length label per distinct wall position, so two rooms sharing a wall are not labelled twice.
function dimensions(plan, scale) {
  const font = Math.max(12, 10 * scale);
  const seen = new Set();
  return plan.walls.flatMap((wall) => {
    const length = wallLength(wall);
    const mx = (wall.x1 + wall.x2) / 2;
    const my = (wall.y1 + wall.y2) / 2;
    const key = `${Math.round(mx)}:${Math.round(my)}`;
    if (length < 80 || seen.has(key)) return [];
    seen.add(key);
    const off = wall.thickness / 2 + font * 1.2;
    const nx = -(wall.y2 - wall.y1) / length;
    const ny = (wall.x2 - wall.x1) / length;
    return [svg("text", { x: mx - nx * off, y: my - ny * off + font * 0.35, "text-anchor": "middle", "font-size": font, class: "dim" }, `${metres(length)} m`)];
  });
}

function selectionOverlay(plan, selection, scale) {
  if (!selection) return [];
  if (selection.kind === "walls") {
    const wall = plan.walls.find((w) => w.id === selection.id);
    if (!wall) return [];
    const handle = (end, x, y) => svg("circle", { cx: x, cy: y, r: 7 * scale, class: "handle", "stroke-width": 2 * scale, "data-kind": "handle", "data-end": end });
    return [chip((wall.x1 + wall.x2) / 2, (wall.y1 + wall.y2) / 2, `${metres(wallLength(wall))} m`, scale), handle(1, wall.x1, wall.y1), handle(2, wall.x2, wall.y2)];
  }
  if (selection.kind === "furniture") {
    const item = plan.furniture.find((f) => f.id === selection.id);
    if (!item) return [];
    const reach = Math.hypot(item.w, item.d) / 2;
    return [chip(item.x, item.y + reach + 14 * scale, `${metres(item.w)} × ${metres(item.d)} m`, scale)];
  }
  return [];
}

// Where an item stood before a previewed copilot change: a dashed outline under the new plan.
const ghostNode = (item) =>
  svg("rect", { x: -item.w / 2, y: -item.d / 2, width: item.w, height: item.d, rx: 4, class: "ghost", transform: `translate(${item.x} ${item.y}) rotate(${item.rotation})`, "pointer-events": "none" });

export function draw(canvas, { plan, selection, preview, changed = new Set(), ghosts = [] }) {
  const area = visibleArea(canvas);
  const walls = new Map(plan.walls.map((wall) => [wall.id, wall]));
  const is = (kind, id) => selection?.kind === kind && selection.id === id;
  canvas.replaceChildren(
    ...[
      grid(area),
      ghosts.map(ghostNode),
      plan.furniture.map((item) => furnitureNode(item, is("furniture", item.id), changed.has(item.id))),
      plan.walls.map((wall) => wallNode(wall, is("walls", wall.id))),
      plan.openings.map((opening) => openingNode(opening, walls.get(opening.wallId), is("openings", opening.id))),
      dimensions(plan, area.scale),
      plan.rooms.map((room) => roomNode(plan, room, is("rooms", room.id), area.scale)),
      selectionOverlay(plan, selection, area.scale),
      preview && [
        svg("line", { ...preview, class: "preview", "stroke-width": 3 * area.scale, "pointer-events": "none" }),
        chip((preview.x1 + preview.x2) / 2, (preview.y1 + preview.y2) / 2 - 16 * area.scale, `${metres(Math.hypot(preview.x2 - preview.x1, preview.y2 - preview.y1))} m`, area.scale),
      ],
      rulers(area),
    ].flat(3).filter(Boolean),
  );
}
