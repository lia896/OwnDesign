// Pure helpers for the version comparison view (js/editor/compare.js). No DOM, no network.
// The changes themselves come from the server (backend/app/diff.py); this only labels, filters and frames them.
import { FURNITURE_BY_TYPE } from "./catalog.js";

// Colour is never the only signal: every kind also has an icon and a word.
export const KIND_STYLE = {
  added: { label: "Added", icon: "add_circle", tone: "added" },
  removed: { label: "Removed", icon: "remove_circle", tone: "removed" },
  moved: { label: "Moved", icon: "open_with", tone: "changed" },
  rotated: { label: "Rotated", icon: "rotate_right", tone: "changed" },
  resized: { label: "Resized", icon: "aspect_ratio", tone: "changed" },
  modified: { label: "Modified", icon: "edit", tone: "changed" },
  structural: { label: "Structural", icon: "foundation", tone: "structural" },
};
export const KINDS = Object.keys(KIND_STYLE);
export const KIND_OF_ENTITY = { furniture: "furniture", wall: "walls", opening: "openings", room: "rooms" };

const ENTITY_NAME = { exterior: "Exterior wall", partition: "Partition wall", door: "Door", window: "Window" };
const cm = (value) => `${Math.round(value)} cm`;
const deg = (value) => `${Math.round(value)}°`;

// Versions arrive newest first. B is the newest (the current plan), A the one before it.
export function defaultPair(versions) {
  if (!versions || versions.length < 2) return null;
  return { a: versions[1].id, b: versions[0].id };
}

export function versionName(version) {
  return `v${version.version_no}${version.label ? ` · ${version.label}` : ""}`;
}

export function changeTitle(change) {
  if (change.entity_type === "furniture") return FURNITURE_BY_TYPE.get(change.furniture_type)?.label ?? String(change.furniture_type ?? "Item").replaceAll("-", " ");
  if (change.entity_type === "room") return `Room${change.room_name ? `: ${change.room_name}` : ""}`;
  return ENTITY_NAME[change.label] ?? "Element";
}

// One short line under the title, in the designer's words.
export function changeLine(change, roomName = () => null) {
  const props = change.changed_properties ?? [];
  if (change.change_type === "added" || change.detail === "added") return "New in version B";
  if (change.change_type === "removed" || change.detail === "removed") return "No longer in version B";
  const parts = [];
  if (props.includes("position")) parts.push(change.distance_cm != null ? `moved ${change.distance_cm} cm` : "moved");
  if (props.includes("room")) parts.push(`now in ${roomName(change.after?.room_id) ?? "no room"}`);
  if (props.includes("rotation")) parts.push(`rotated ${deg(change.before.rotation)} → ${deg(change.after.rotation)}`);
  if (props.includes("size")) parts.push("size changed");
  for (const prop of ["type", "name", "thickness", "kind", "offset", "width", "wall"]) if (props.includes(prop)) parts.push(`${prop === "wall" ? "moved to another wall" : `${prop} changed`}`);
  const text = parts.join(", ");
  return text ? text[0].toUpperCase() + text.slice(1) : "Changed";
}

const point = (x, y) => `${Math.round(x)}, ${Math.round(y)} cm`;
const furnitureLabel = (type) => FURNITURE_BY_TYPE.get(type)?.label ?? type;

// Before/after rows for the details table: only properties that changed, in readable units. No invented values.
export function detailRows(change, roomName = () => null) {
  const { before, after } = change;
  if (!before || !after) return [];
  const rows = [];
  const add = (property, a, b) => rows.push({ property, a, b });
  for (const prop of change.changed_properties) {
    if (prop === "position" && change.entity_type === "furniture") add("Position (centre)", point(before.x, before.y), point(after.x, after.y));
    else if (prop === "position") add("Position", `${point(before.position[0], before.position[1])} to ${point(before.position[2], before.position[3])}`, `${point(after.position[0], after.position[1])} to ${point(after.position[2], after.position[3])}`);
    else if (prop === "rotation") add("Rotation", deg(before.rotation), deg(after.rotation));
    else if (prop === "size") add("Size", `${cm(before.w)} × ${cm(before.d)}`, `${cm(after.w)} × ${cm(after.d)}`);
    else if (prop === "type" && change.entity_type === "furniture") add("Item", furnitureLabel(before.type), furnitureLabel(after.type));
    else if (prop === "room" && change.entity_type === "furniture") add("Room", roomName(before.room_id) ?? "None", roomName(after.room_id) ?? "None");
    else if (prop === "room") add("Room", roomName(before.room) ?? "None", roomName(after.room) ?? "None");
    else if (["thickness", "offset", "width"].includes(prop)) add(prop[0].toUpperCase() + prop.slice(1), cm(before[prop]), cm(after[prop]));
    else if (prop === "wall") add("Wall", "Earlier wall", "Another wall");
    else add(prop[0].toUpperCase() + prop.slice(1), String(before[prop]), String(after[prop]));
  }
  return rows;
}

// The server lists each group's change ids (so a large diff is not sent twice); this puts the changes back in.
export function resolveGroups(groups, changes) {
  const byId = new Map(changes.map((change) => [change.change_id, change]));
  return groups.map(({ change_ids: ids, ...group }) => ({ ...group, changes: ids.map((id) => byId.get(id)).filter(Boolean) }));
}

// filter: { kind: "all" | one of KINDS, room: "all" | room id | "none" }
export function filterGroups(groups, { kind = "all", room = "all" } = {}) {
  return groups
    .filter((group) => room === "all" || (room === "none" ? group.room_id === null : group.room_id === room))
    .map((group) => ({ ...group, changes: group.changes.filter((change) => kind === "all" || change.change_type === kind) }))
    .filter((group) => group.changes.length > 0);
}

// The area to zoom to for a change: both of its locations, with some room around them.
export function focusBox(change, pad = 120) {
  const boxes = [change.box_a, change.box_b].filter(Boolean);
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((b) => b.x)) - pad;
  const y0 = Math.min(...boxes.map((b) => b.y)) - pad;
  const x1 = Math.max(...boxes.map((b) => b.x + b.w)) + pad;
  const y1 = Math.max(...boxes.map((b) => b.y + b.h)) + pad;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Which drawn elements to mark on each side: A shows what existed before, B what exists after.
export function marks(changes, side) {
  const key = side === "a" ? "box_a" : "box_b";
  return changes.filter((change) => change[key]).map((change) => ({ kind: KIND_OF_ENTITY[change.entity_type], id: change.entity_id, tone: KIND_STYLE[change.change_type].tone, change }));
}
