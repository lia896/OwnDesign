// Pure helpers for the design copilot panel (js/editor/copilot.js). No DOM, no network.
import { FURNITURE_BY_TYPE } from "./catalog.js";
import * as P from "./plan.js";

export const itemName = (item) => FURNITURE_BY_TYPE.get(item.type)?.label ?? item.type.replaceAll("_", " ");
const cm = (value) => `${Math.round(value)} cm`;

// The room an item stands in: the first room whose wall box contains its centre (the server uses the same rule on the inner wall faces).
export function roomOf(plan, item) {
  return plan.rooms.find((room) => {
    const box = P.roomBox(plan, room.id);
    return box && item.x >= box.x && item.x <= box.x + box.w && item.y >= box.y && item.y <= box.y + box.h;
  });
}

// What the copilot can focus on, given the editor's selection.
export function scopeTargets(plan, selection) {
  const item = selection?.kind === "furniture" && plan.furniture.find((candidate) => candidate.id === selection.id);
  const room = selection?.kind === "rooms" ? plan.rooms.find((candidate) => candidate.id === selection.id) : item ? roomOf(plan, item) : null;
  return { room: room ?? null, item: item || null };
}

export function describeAction(plan, action) {
  const item = plan.furniture.find((candidate) => candidate.id === action.object_id);
  const name = item ? itemName(item) : action.object_id;
  if (action.type === "move_object") {
    const shift = item ? ` (${cm(Math.hypot(action.x - item.x, action.y - item.y))})` : "";
    return `Move ${name} to ${Math.round(action.x)}, ${Math.round(action.y)}${shift}`;
  }
  if (action.type === "rotate_object") return `Rotate ${name} to ${Math.round(action.rotation)}°`;
  if (action.type === "resize_object") return `Resize ${name} to ${Math.round(action.w)} × ${Math.round(action.d)} cm`;
  if (action.type === "remove_object") return `Remove ${name}`;
  return "Unknown change";
}
