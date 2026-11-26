// The "Element Inspector": numeric editing of the selected element, the plan summary and the version list.
// It is rebuilt only when the selection (or version list) changes; otherwise values are refreshed in place,
// so tabbing between fields never loses focus.
import { FURNITURE_BY_TYPE, REVIEW_NOTE, ROOM_TYPES } from "../catalog.js";
import * as P from "../plan.js";
import { formatDate, h } from "../ui.js";

const number = (label, unit, read, write, { min = 1, max = 3000, step = 1 } = {}) => ({ label, unit, read, write, min, max, step });
const choice = (label, options, read, write) => ({ label, options, read, write });
const text = (label, read, write) => ({ label, read, write, text: true });
const set = (kind, key) => (plan, id, value) => P.patch(plan, kind, id, { [key]: value });

const SPEC = {
  walls: {
    title: (wall) => (wall.kind === "exterior" ? "Exterior wall" : "Partition wall"),
    review: () => true,
    fields: [
      number("Length", "m", (wall) => P.metres(P.wallLength(wall)), (plan, id, m) => P.setWallLength(plan, id, m * 100), { min: 0.1, max: 100, step: 0.1 }),
      number("Thickness", "cm", (wall) => wall.thickness, set("walls", "thickness"), { max: 100 }),
      choice("Type", [["exterior", "Exterior"], ["partition", "Partition"]], (wall) => wall.kind, set("walls", "kind")),
    ],
  },
  openings: {
    title: (opening) => (opening.type === "door" ? "Door" : "Window"),
    review: () => true,
    fields: [
      number("Width", "cm", (opening) => Math.round(opening.width), set("openings", "width"), { min: 30 }),
      number("From wall start", "cm", (opening) => Math.round(opening.offset), set("openings", "offset"), { min: 0, max: 100_000 }),
      choice("Type", [["door", "Door"], ["window", "Window"]], (opening) => opening.type, set("openings", "type")),
    ],
  },
  furniture: {
    title: (item) => FURNITURE_BY_TYPE.get(item.type)?.label ?? item.type,
    review: (item) => Boolean(FURNITURE_BY_TYPE.get(item.type)?.review),
    fields: [
      number("Width (X)", "cm", (item) => Math.round(item.w), set("furniture", "w"), { min: 10 }),
      number("Depth (Y)", "cm", (item) => Math.round(item.d), set("furniture", "d"), { min: 10 }),
      number("Rotation", "deg", (item) => Math.round(item.rotation), set("furniture", "rotation"), { min: -360, max: 360, step: 15 }),
    ],
  },
  rooms: {
    title: (room) => room.name,
    review: () => false,
    fields: [
      text("Name", (room) => room.name, (plan, id, value) => (value.trim() ? P.patch(plan, "rooms", id, { name: value.trim().slice(0, 80) }) : plan)),
      choice("Room type", ROOM_TYPES, (room) => room.type, set("rooms", "type")),
    ],
  },
};

let built = { key: null, versions: null };
let syncers = [];

function fieldNode(spec, editor) {
  const control = spec.options
    ? h("select", { "aria-label": spec.label }, spec.options.map(([value, label]) => h("option", { value }, label)))
    : h("input", spec.text ? { "aria-label": spec.label, maxLength: 80 } : { "aria-label": spec.label, type: "number", min: spec.min, max: spec.max, step: spec.step, inputMode: "decimal" });
  control.addEventListener("change", () => {
    const { selection, plan } = editor;
    const value = spec.options || spec.text ? control.value : Number(control.value);
    const usable = typeof value === "string" || (control.value !== "" && Number.isFinite(value));
    if (usable) editor.commit(spec.write(plan, selection.id, typeof value === "string" ? value : Math.min(Math.max(value, spec.min), spec.max)));
    // Show what was actually applied (clamped, or unchanged if the input was not usable), even while focused.
    const item = editor.plan[selection.kind].find((candidate) => candidate.id === selection.id);
    if (item) control.value = spec.read(item);
  });
  syncers.push((item) => {
    if (document.activeElement !== control) control.value = spec.read(item);
  });
  return h("div", { class: "field" }, h("span", {}, spec.label), h("div", { class: "value" }, control, spec.unit && h("span", { class: "unit" }, spec.unit)));
}

function summaryNode() {
  const line = (label) => {
    const value = h("span", { class: "mono" });
    return { value, node: h("div", { class: "row between" }, h("span", { class: "muted" }, label), value) };
  };
  const rows = { rooms: line("Rooms"), area: line("Room area"), walls: line("Walls"), openings: line("Doors & windows"), furniture: line("Furniture") };
  syncers.push((_, plan) => {
    rows.rooms.value.textContent = plan.rooms.length;
    rows.area.value.textContent = `${P.planArea(plan).toFixed(1)} m²`;
    rows.walls.value.textContent = plan.walls.length;
    rows.openings.value.textContent = plan.openings.length;
    rows.furniture.value.textContent = plan.furniture.length;
  });
  return [
    h("div", { class: "selection stack" }, h("span", { class: "label" }, "Plan summary"), Object.values(rows).map((row) => row.node)),
    h("p", { class: "muted small" }, "Select anything on the canvas to edit its dimensions. Drag to move, drag a wall's end points to resize it."),
  ];
}

function versionsNode(versions, onLoad, onCompare) {
  if (!versions) return null;
  return h("div", { class: "stack" },
    h("div", { class: "row between" }, h("span", { class: "label" }, "Plan versions"), h("span", { class: "code" }, `${versions.length} saved`)),
    versions.length === 0 && h("p", { class: "muted small" }, "Nothing saved yet."),
    versions.length >= 2 && onCompare && h("button", { type: "button", onclick: () => onCompare() }, h("span", { class: "icon", "aria-hidden": "true" }, "compare"), "Compare versions"),
    versions.map((version) =>
      h("button", { type: "button", class: "version", title: "Load this version onto the canvas", onclick: () => onLoad(version) },
        h("span", { class: `chip ${version.author_role === "designer" ? "accent" : "ok"}` }, `v${version.version_no} · ${version.author_role}`),
        h("span", {}, version.label || "Untitled"),
        h("span", { class: "code when" }, formatDate(version.created_at)),
      ),
    ),
  );
}

export function renderInspector(root, editor, { versions, onLoadVersion, onCompare }) {
  const { selection, plan } = editor;
  const item = selection ? plan[selection.kind].find((candidate) => candidate.id === selection.id) : null;
  const key = item ? `${selection.kind}:${selection.id}` : "none";
  if (key !== built.key || versions !== built.versions) {
    built = { key, versions };
    syncers = [];
    const spec = item && SPEC[selection.kind];
    const title = h("div", { class: "name" });
    if (spec) syncers.push((current) => (title.textContent = spec.title(current)));
    root.replaceChildren(
      ...[
        h("div", {}, h("h2", {}, "Element Inspector"), h("div", { class: "code" }, item ? `${selection.kind.toUpperCase()} · ${selection.id}` : "NOTHING SELECTED")),
        spec
          ? [
              h("div", { class: "selection" }, h("span", { class: "label" }, "Active selection"), title),
              h("div", { class: "stack" }, h("span", { class: "label" }, "Dimensions"), h("div", { class: "fields" }, spec.fields.map((field) => fieldNode(field, editor)))),
              spec.review(item) && h("p", { class: "note" }, REVIEW_NOTE),
            ]
          : summaryNode(),
        versionsNode(versions, onLoadVersion, onCompare),
      ].flat().filter(Boolean),
    );
  }
  for (const sync of syncers) sync(item, plan);
}
