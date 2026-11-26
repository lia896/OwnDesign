// Editor controller: owns the state, wires tools, keyboard, zoom, save and versions.
// Two modes: a saved project (?project=<id>, needs sign-in) or a local draft (guest or not yet saved).
import { api, getSession, requireSession, signOut } from "../api.js";
import { FURNITURE, FURNITURE_BY_TYPE } from "../catalog.js";
import * as P from "../plan.js";
import { KEYS, load, save as store } from "../store.js";
import { $, action, h, run, showStudio, toast } from "../ui.js";
import { mountCopilot } from "./copilot.js";
import { renderInspector } from "./panel.js";
import { attachPointer, zoomAt } from "./pointer.js";
import { draw, visibleArea } from "./render.js";

const TOOLS = [
  { id: "select", icon: "near_me", key: "V", label: "Select and move" },
  { id: "exterior", icon: "polyline", key: "W", label: "Draw exterior wall" },
  { id: "partition", icon: "vertical_split", key: "P", label: "Draw partition" },
  { id: "door", icon: "meeting_room", key: "D", label: "Place door" },
  { id: "window", icon: "window", key: "N", label: "Place window" },
  { id: "furniture", icon: "chair", key: "F", label: "Furniture catalog" },
];
const VIEW_LIMIT = 99_000; // cm
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

const params = new URLSearchParams(location.search);
const projectId = params.get("project");
const canvas = $("#canvas");

const state = {
  history: null,
  live: null, // plan being dragged, not yet in history
  selection: null,
  tool: "select",
  catalogOpen: false,
  view: { x: 0, y: 0, w: 1000, h: 800 },
  previewLine: null,
  saved: null, // the plan object last written to the server
  project: null,
  draft: null,
  versions: null,
  signedIn: false,
  aiPreview: null, // { plan, changed, ghosts, title }: a copilot suggestion shown on the canvas, not part of the plan
};
let copilot = null;

const editor = {
  get plan() {
    return state.live ?? state.history.present;
  },
  get selection() {
    return state.selection;
  },
  get tool() {
    return state.tool;
  },
  get view() {
    return state.view;
  },
  preview(plan) {
    state.live = plan;
    render();
  },
  commitPreview() {
    if (state.live) editor.commit(state.live);
  },
  commit(plan, selection = state.selection) {
    copilot?.endPreview(); // any edit ends a copilot preview, so the preview can never be edited or saved by mistake
    state.live = null;
    // A click without movement, or re-entering the same value, must not add an undo step or mark the plan unsaved.
    if (JSON.stringify(plan) !== JSON.stringify(state.history.present)) state.history = P.history.push(state.history, plan);
    state.selection = selection;
    keepDraft();
    render();
  },
  select(selection) {
    if (selection?.kind === state.selection?.kind && selection?.id === state.selection?.id) return;
    state.selection = selection;
    render();
  },
  setTool(tool) {
    state.tool = tool;
    state.catalogOpen = false;
    render();
  },
  setView(view) {
    // Keeps the view inside the area the backend accepts (plus/minus 1 km), so nothing can be drawn out of range.
    const clamp = (value, size) => Math.min(Math.max(value, -VIEW_LIMIT), VIEW_LIMIT - size);
    state.view = { ...view, x: clamp(view.x, view.w), y: clamp(view.y, view.h) };
    render();
  },
  setPreviewLine(line) {
    state.previewLine = line;
    render();
  },
  refresh: () => render(),
  toast,
};

// A draft lives in this browser until it is saved to an account, so a refresh never loses work.
function keepDraft() {
  if (!state.draft) return;
  state.draft = { ...state.draft, plan: state.history.present };
  store(KEYS.draft, state.draft);
}

const isDirty = () => state.project && state.history.present !== state.saved;

function render() {
  const plan = editor.plan;
  const { selection } = state;
  if (selection && !plan[selection.kind].some((item) => item.id === selection.id)) state.selection = null;

  const { x, y, w, h: height } = state.view;
  canvas.setAttribute("viewBox", `${x} ${y} ${w} ${height}`);
  canvas.dataset.tool = state.tool;
  const hadFocus = canvas.contains(document.activeElement);
  const ai = state.aiPreview;
  canvas.classList.toggle("previewing", Boolean(ai));
  $("#ai-preview").hidden = !ai;
  if (ai) $("#ai-preview-title").textContent = ai.title;
  draw(canvas, ai ? { plan: ai.plan, selection: null, changed: ai.changed, ghosts: ai.ghosts } : { plan, selection: state.selection, preview: state.previewLine });
  if (hadFocus) {
    const node = state.selection && canvas.querySelector(`[data-kind="${state.selection.kind}"][data-id="${state.selection.id}"]`);
    (node ?? canvas).focus({ preventScroll: true });
  }

  renderInspector($("#inspector"), editor, { versions: state.versions, onLoadVersion: loadVersion });
  copilot?.refresh();

  for (const button of $("#tools").children) {
    const { tool } = button.dataset;
    const active = tool === "furniture" ? state.catalogOpen || state.tool.startsWith("furniture:") : tool === state.tool;
    button.setAttribute("aria-pressed", String(active));
  }
  for (const button of $("#catalog").querySelectorAll("button")) button.setAttribute("aria-pressed", String(`furniture:${button.dataset.type}` === state.tool));
  $("#catalog").hidden = !state.catalogOpen;
  $("#tool-name").textContent = state.tool.startsWith("furniture:") ? "Place furniture" : TOOLS.find((tool) => tool.id === state.tool).label;
  $("#undo").disabled = state.history.past.length === 0;
  $("#redo").disabled = state.history.future.length === 0;

  $("#actions").hidden = !state.selection;
  const isFurniture = state.selection?.kind === "furniture";
  $("#rotate").hidden = !isFurniture;
  $("#duplicate").hidden = !isFurniture;

  const zoom = `${Math.round(100 / visibleArea(canvas).scale)}%`;
  $("#zoom-level").textContent = zoom;
  $("#status-zoom").textContent = `Zoom: ${zoom}`;
  $("#context-area").textContent = `${P.planArea(plan).toFixed(1)} m²`;
  const latest = state.versions?.[0];
  $("#crumb-version").textContent = state.project ? `Plan Editor (${latest ? `v${latest.version_no}` : "no versions"}${isDirty() ? ", edited" : ""})` : "Plan Editor (Draft)";
  $("#status-save").textContent = state.project
    ? isDirty() ? "Unsaved changes" : latest ? `Saved · v${latest.version_no}` : "Nothing saved yet"
    : state.signedIn ? "Draft · not saved to your account yet" : "Guest draft · kept in this browser only";
}

function fit() {
  const box = P.planBox(editor.plan);
  const pad = 180;
  editor.setView({ x: box.x - pad, y: box.y - pad, w: box.w + 2 * pad, h: box.h + 2 * pad });
}

const zoomBy = (factor) => {
  const area = visibleArea(canvas);
  editor.setView(zoomAt(state.view, { x: area.x + area.w / 2, y: area.y + area.h / 2 }, factor));
};

const undo = () => {
  state.history = P.history.undo(state.history);
  keepDraft();
  render();
};
const redo = () => {
  state.history = P.history.redo(state.history);
  keepDraft();
  render();
};
const removeSelection = () => state.selection && editor.commit(P.remove(editor.plan, state.selection.kind, state.selection.id), null);
const rotateSelection = () => {
  const item = editor.plan.furniture.find((candidate) => candidate.id === state.selection?.id);
  if (item) editor.commit(P.patch(editor.plan, "furniture", item.id, { rotation: item.rotation + 90 }));
};

function nudge([dx, dy]) {
  const { selection } = state;
  const plan = editor.plan;
  if (selection.kind === "openings") {
    const opening = plan.openings.find((candidate) => candidate.id === selection.id);
    return editor.commit(P.patch(plan, "openings", selection.id, { offset: opening.offset + (dx || dy) * P.GRID }));
  }
  editor.commit(P.translate(plan, selection.kind, selection.id, dx * P.GRID, dy * P.GRID));
}

// Keyboard alternative to clicking on the canvas: puts the active tool's element at the centre of the view.
function placeAtCentre() {
  const area = visibleArea(canvas);
  const centre = { x: P.snap(area.x + area.w / 2), y: P.snap(area.y + area.h / 2) };
  const { tool } = state;
  const plan = editor.plan;
  let next;
  let kind;
  if (tool === "exterior" || tool === "partition") {
    next = P.addWall(plan, { x: centre.x - 150, y: centre.y }, { x: centre.x + 150, y: centre.y }, tool);
    kind = "walls";
  } else if (tool === "door" || tool === "window") {
    const wall = state.selection?.kind === "walls" && plan.walls.find((candidate) => candidate.id === state.selection.id);
    if (!wall) return toast("Select a wall first, then choose the door or window tool and press Enter.");
    next = P.addOpening(plan, wall.id, tool, P.wallLength(wall) / 2);
    kind = "openings";
  } else {
    next = P.addFurniture(plan, FURNITURE_BY_TYPE.get(tool.slice("furniture:".length)), centre.x, centre.y);
    kind = "furniture";
  }
  editor.commit(next, { kind, id: next[kind].at(-1).id });
  editor.setTool("select");
}

function onKey(event) {
  if (event.target.closest("input, select, textarea, dialog")) return;
  if (state.live || state.previewLine) return; // mid-drag: the drag would overwrite a keyboard edit
  if (state.aiPreview) {
    // The canvas shows a suggestion, not the plan: only Escape (end the preview) is handled.
    if (event.key === "Escape") copilot.endPreview();
    return;
  }
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const mod = event.ctrlKey || event.metaKey;
  if (mod && key === "z") event.shiftKey ? redo() : undo();
  else if (mod && key === "y") redo();
  else if (mod && key === "s") openSave();
  else if (mod || event.altKey) return;
  else if ((key === "Delete" || key === "Backspace") && state.selection) removeSelection();
  else if (key === "Escape") {
    state.selection = null;
    editor.setTool("select");
  } else if (key === "Enter" && state.tool !== "select") {
    if (event.target.closest("button, a")) return; // Enter on a focused control activates that control
    placeAtCentre();
  } else if (ARROWS[key] && state.selection) nudge(ARROWS[key]);
  else if (key === "r" && state.selection?.kind === "furniture") rotateSelection();
  else {
    const tool = TOOLS.find((candidate) => candidate.key.toLowerCase() === key);
    if (!tool) return;
    pickTool(tool.id);
  }
  event.preventDefault();
}

function pickTool(id) {
  if (id !== "furniture") return editor.setTool(id);
  state.catalogOpen = !state.catalogOpen;
  if (state.tool.startsWith("furniture:")) state.tool = "select";
  render();
  if (state.catalogOpen) $("#catalog button").focus(); // keyboard users land in the catalog, not behind the whole plan
}

// From a button: focus moves to the canvas, so Enter then places the element instead of pressing the button again.
function chooseTool(id) {
  pickTool(id);
  if (id !== "furniture") canvas.focus({ preventScroll: true });
}

async function loadVersion(summary) {
  const version = await api(`/v1/projects/${state.project.id}/versions/${summary.id}`).catch((error) => toast(error.message, "error"));
  if (!version) return;
  editor.commit(version.geometry, null);
  fit();
  toast(`Loaded v${version.version_no}. Save to make it the newest version, or Undo to go back.`);
}

function openSave() {
  if (!state.project && !state.signedIn) return $("#signup-dialog").showModal();
  const dialog = $("#save-dialog");
  dialog.querySelector("form").reset();
  dialog.returnValue = ""; // otherwise Escape would repeat the previous "save"
  dialog.showModal();
}

async function savePlan(label) {
  const plan = state.history.present;
  if (!state.project) {
    // First save of a draft: create the project, then store the plan as version 1.
    const { name, property_type: propertyType, studio } = state.draft;
    const remembered = state.draft.projectId;
    const id = remembered ?? (await api("/v1/projects", { method: "POST", body: { studio_id: studio.id, name, property_type: propertyType } })).id;
    state.draft = { ...state.draft, projectId: id }; // if the next call fails, a retry reuses this project
    store(KEYS.draft, state.draft);
    try {
      await api(`/v1/projects/${id}/versions`, { method: "POST", body: { label, geometry: plan } });
    } catch (error) {
      if (error.status !== 404 || !remembered) throw error;
      // The remembered project belongs to another account that used this browser: forget it and start clean.
      state.draft = { ...state.draft, projectId: undefined };
      store(KEYS.draft, state.draft);
      return savePlan(label);
    }
    store(KEYS.draft, null);
    return location.replace(`editor.html?project=${id}`);
  }
  const version = await api(`/v1/projects/${state.project.id}/versions`, { method: "POST", body: { label, geometry: plan } });
  state.saved = plan;
  state.versions = [version, ...state.versions];
  render();
  toast(`Saved as v${version.version_no}`);
}

function setupCopilot() {
  const panel = $("#copilot");
  const toggle = $("#copilot-toggle");
  copilot = mountCopilot(panel, {
    projectId: state.project.id,
    plan: () => state.history.present,
    selection: () => state.selection,
    baseVersionNo: () => state.versions[0]?.version_no ?? null,
    preview(plan, changed, title) {
      const before = state.history.present.furniture.filter((item) => changed.has(item.id));
      state.aiPreview = { plan, changed, ghosts: before, title };
      render();
    },
    endPreview() {
      state.aiPreview = null;
      render();
    },
    applied(version) {
      const hadEdits = isDirty();
      editor.commit(version.geometry);
      state.saved = state.history.present;
      state.versions = [version, ...state.versions];
      render();
      toast(`Applied and saved as v${version.version_no}${hadEdits ? ", with your unsaved edits" : ""}. Undo returns to the previous plan.`);
    },
  });
  const show = (open) => {
    toggle.setAttribute("aria-expanded", String(open));
    $(".editor").classList.toggle("with-copilot", open);
    open ? copilot.open() : copilot.close();
    requestAnimationFrame(render); // the canvas changed width
  };
  toggle.hidden = false;
  toggle.addEventListener("click", () => show(toggle.getAttribute("aria-expanded") !== "true"));
  $("#copilot-close").addEventListener("click", () => {
    show(false);
    toggle.focus();
  });
  $("#ai-preview-end").addEventListener("click", () => copilot.endPreview());
}

function buildChrome(name, role) {
  $("#tools").replaceChildren(
    ...TOOLS.map((tool) =>
      h("button", { type: "button", title: `${tool.label} (${tool.key})`, "aria-label": tool.label, "data-tool": tool.id, onclick: () => chooseTool(tool.id) },
        h("span", { class: "icon", "aria-hidden": "true" }, tool.icon),
        h("span", { class: "key", "aria-hidden": "true" }, tool.key),
      ),
    ),
  );
  const groups = [...new Set(FURNITURE.map((item) => item.group))];
  $("#catalog").replaceChildren(
    ...groups.flatMap((group) => [
      h("span", { class: "label" }, group),
      h("div", { class: "items" },
        FURNITURE.filter((item) => item.group === group).map((item) =>
          h("button", { type: "button", "data-type": item.type, onclick: () => chooseTool(`furniture:${item.type}`) },
            item.label,
            h("span", { class: "code" }, `${item.w}×${item.d}`),
          ),
        ),
      ),
    ]),
  );

  document.title = `${name} · 2D Canvas`;
  $("#crumb-name").textContent = name;
  $("#context-name").textContent = name;
  $("#context-role").textContent = role;
  $("#account").textContent = state.signedIn ? "Sign out" : "Sign in";
  $("#account").addEventListener("click", () => (state.signedIn ? signOut() : location.assign("auth.html?next=editor.html")));
  $("#home-link").href = state.signedIn ? "projects.html" : "index.html";

  $("#undo").addEventListener("click", undo);
  $("#redo").addEventListener("click", redo);
  $("#rotate").addEventListener("click", rotateSelection);
  $("#delete").addEventListener("click", removeSelection);
  $("#duplicate").addEventListener("click", () => {
    const next = P.duplicateFurniture(editor.plan, state.selection.id);
    editor.commit(next, { kind: "furniture", id: next.furniture.at(-1).id });
  });
  $("#zoom-in").addEventListener("click", () => zoomBy(1 / 1.25));
  $("#zoom-out").addEventListener("click", () => zoomBy(1.25));
  $("#zoom-fit").addEventListener("click", fit);
  $("#save").addEventListener("click", openSave);
  $("#save-cancel").addEventListener("click", () => $("#save-dialog").close("cancel"));
  $("#save-dialog").addEventListener("close", action(async (event) => {
    const dialog = event.currentTarget;
    if (dialog.returnValue === "save") await savePlan(dialog.querySelector("input").value.trim());
  }));

  attachPointer(canvas, editor);
  canvas.addEventListener("focusin", (event) => {
    const target = event.target.closest?.("[data-kind]");
    if (target && target.dataset.kind !== "handle") editor.select({ kind: target.dataset.kind, id: target.dataset.id });
  });
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", render);
  window.addEventListener("beforeunload", (event) => {
    if (isDirty()) event.preventDefault();
  });
}

run(async () => {
  let plan;
  let name;
  let role;
  if (projectId) {
    await requireSession();
    state.signedIn = true;
    const base = `/v1/projects/${encodeURIComponent(projectId)}`;
    [state.project, state.versions] = await Promise.all([api(base), api(`${base}/versions`)]);
    plan = state.versions.length ? (await api(`${base}/versions/latest`)).geometry : P.emptyPlan();
    name = state.project.name;
    role = `Editing as ${state.project.my_role}`;
    showStudio(state.project.studio.name);
    // Starting over from the wizard would discard this saved plan's context, so those links go to the project list.
    $("#tab-wizard").href = state.project.my_role === "designer" ? "studio.html" : "projects.html";
    $("#tab-wizard").textContent = "All projects";
    $("#nav-wizard").hidden = true;
    // The brief and the consultant belong to a saved project, so their links appear only here.
    for (const page of ["design", "consultant"]) {
      for (const link of [$(`#tab-${page}`), $(`#nav-${page}`)]) {
        link.href = `${page}.html?project=${encodeURIComponent(projectId)}`;
        link.hidden = false;
      }
    }
  } else {
    state.draft = load(KEYS.draft);
    if (!state.draft || !P.isPlan(state.draft.plan)) return location.replace("wizard.html");
    state.signedIn = Boolean(await getSession());
    plan = state.draft.plan;
    name = state.draft.name;
    role = "Draft";
    showStudio(state.draft.studio.name);
  }
  state.history = P.history.start(plan);
  state.saved = plan;
  buildChrome(name, role);
  if (state.project) setupCopilot();
  fit();
  if (params.get("save") && state.draft && state.signedIn) openSave();
});
