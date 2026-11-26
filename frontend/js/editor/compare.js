// Version comparison mode of the editor: two saved versions side by side (or one difference view), with
// shared zoom and pan, the server's change list, and before/after details. Read only: nothing here edits or
// saves a plan. "Continue from" hands a version back to the editor's existing load-version flow.
import { api } from "../api.js";
import { changeLine, changeTitle, defaultPair, detailRows, filterGroups, focusBox, KIND_STYLE, KINDS, marks, resolveGroups, versionName } from "../compare-logic.js";
import * as P from "../plan.js";
import { $, h } from "../ui.js";
import { zoomAt } from "./pointer.js";
import { draw, svg, visibleArea } from "./render.js";

// host: { projectId, versions(), isDirty(), continueFrom(versionSummary), exit() }
export function mountCompare(root, host) {
  const base = `/v1/projects/${encodeURIComponent(host.projectId)}`;
  const geometries = new Map(); // versions are immutable, so a fetched one never needs fetching again
  const svgA = $("#cmp-svg-a", root);
  const svgB = $("#cmp-svg-b", root);
  const state = { a: null, b: null, mode: "side", result: null, selected: null, kind: "all", room: "all", view: { x: 0, y: 0, w: 1000, h: 800 }, request: 0 };

  const versionById = (id) => host.versions().find((version) => version.id === id);
  const geometry = async (id) => {
    if (!geometries.has(id)) geometries.set(id, (await api(`${base}/versions/${encodeURIComponent(id)}`)).geometry);
    return geometries.get(id);
  };
  const roomName = (id) => {
    if (!id || !state.result) return null;
    for (const plan of [state.result.planB, state.result.planA]) {
      const room = plan.rooms.find((candidate) => candidate.id === id);
      if (room) return room.name;
    }
    return null;
  };

  // ---- drawing ---------------------------------------------------------------------------------------------

  function decorate(canvas, side) {
    // The drawing is for looking only: no element is focusable or presented as a button.
    for (const node of canvas.querySelectorAll("[tabindex]")) {
      node.removeAttribute("tabindex");
      node.removeAttribute("role");
    }
    const changes = state.result?.changes ?? [];
    for (const mark of marks(changes, side)) {
      const node = canvas.querySelector(`[data-kind="${mark.kind}"][data-id="${CSS.escape(mark.id)}"]`);
      node?.classList.add("cmp-mark", `cmp-${mark.tone}`);
    }
    const scale = visibleArea(canvas).scale;
    const extra = [];
    // Difference view: what version A had and B no longer has, drawn as a dashed outline on B.
    if (side === "b" && state.mode === "diff") {
      for (const change of changes) {
        if (change.box_a && !change.box_b) extra.push(svg("rect", { ...rect(change.box_a), class: "cmp-gone", "stroke-width": 2 * scale, "pointer-events": "none" }));
      }
    }
    const selected = changes.find((change) => change.change_id === state.selected);
    const box = selected && (side === "a" ? selected.box_a : selected.box_b ?? (state.mode === "diff" ? selected.box_a : null));
    if (box) extra.push(svg("rect", { ...rect(box, 14), class: "cmp-focus", "stroke-width": 3 * scale, "pointer-events": "none" }));
    canvas.append(...extra);
  }

  const rect = (box, pad = 0) => ({ x: box.x - pad, y: box.y - pad, width: box.w + 2 * pad, height: box.h + 2 * pad, rx: 6 });

  function paint() {
    if (!state.result) return;
    const { x, y, w, h: height } = state.view;
    const sides = state.mode === "side" ? [[svgA, "a", state.result.planA], [svgB, "b", state.result.planB]] : [[svgB, "b", state.result.planB]];
    $("#cmp-plan-a", root).hidden = state.mode !== "side";
    for (const [canvas, side, plan] of sides) {
      canvas.setAttribute("viewBox", `${x} ${y} ${w} ${height}`);
      draw(canvas, { plan, selection: null });
      decorate(canvas, side);
    }
  }

  function fitTo(box) {
    state.view = box ?? P.planBox(state.result.planB);
    if (!box) {
      const both = [P.planBox(state.result.planA), P.planBox(state.result.planB)];
      const x0 = Math.min(...both.map((b) => b.x)) - 180;
      const y0 = Math.min(...both.map((b) => b.y)) - 180;
      state.view = { x: x0, y: y0, w: Math.max(...both.map((b) => b.x + b.w)) + 180 - x0, h: Math.max(...both.map((b) => b.y + b.h)) + 180 - y0 };
    }
    paint();
  }

  // Shared navigation: dragging or zooming either plan moves both, because they share one view.
  function attachNavigation(canvas) {
    let drag = null;
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button > 1) return;
      canvas.setPointerCapture(event.pointerId);
      drag = { x: event.clientX, y: event.clientY, view: state.view, scale: visibleArea(canvas).scale };
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!drag) return;
      state.view = { ...drag.view, x: drag.view.x - (event.clientX - drag.x) * drag.scale, y: drag.view.y - (event.clientY - drag.y) * drag.scale };
      paint();
    });
    const end = () => (drag = null);
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(canvas.getScreenCTM().inverse());
      state.view = zoomAt(state.view, point, event.deltaY > 0 ? 1.15 : 1 / 1.15);
      paint();
    }, { passive: false });
  }

  const zoomBy = (factor) => {
    const { x, y, w, h: height } = state.view;
    state.view = zoomAt(state.view, { x: x + w / 2, y: y + height / 2 }, factor);
    paint();
  };

  // ---- panel -----------------------------------------------------------------------------------------------

  function summary() {
    const counts = state.result.summary;
    const tile = (kind) => {
      const style = KIND_STYLE[kind];
      return h("div", { class: `cmp-count cmp-${style.tone}` }, h("span", { class: "icon", "aria-hidden": "true" }, style.icon), h("strong", {}, String(counts[kind])), h("span", {}, style.label));
    };
    $("#cmp-total", root).textContent = counts.total === 0 ? "No differences between these versions." : `${counts.total} ${counts.total === 1 ? "change" : "changes"} detected`;
    $("#cmp-summary", root).replaceChildren(...KINDS.filter((kind) => counts[kind] > 0).map(tile));
  }

  function filters() {
    const kinds = KINDS.filter((kind) => state.result.summary[kind] > 0);
    if (state.kind !== "all" && !kinds.includes(state.kind)) state.kind = "all";
    $("#cmp-kind", root).replaceChildren(h("option", { value: "all" }, "All changes"), ...kinds.map((kind) => h("option", { value: kind }, KIND_STYLE[kind].label)));
    $("#cmp-kind", root).value = state.kind;
    const rooms = state.result.groups.map((group) => [group.room_id ?? "none", group.room_name ?? "Outside any room"]);
    if (state.room !== "all" && !rooms.some(([id]) => id === state.room)) state.room = "all";
    $("#cmp-room", root).replaceChildren(h("option", { value: "all" }, "All rooms"), ...rooms.map(([id, name]) => {
      const option = h("option", { value: id });
      option.textContent = name;
      return option;
    }));
    $("#cmp-room", root).value = state.room;
    $("#cmp-filters", root).hidden = state.result.summary.total === 0;
  }

  function list() {
    const groups = filterGroups(state.result.groups, { kind: state.kind, room: state.room });
    $("#cmp-list", root).replaceChildren(
      ...groups.map((group) => {
        const heading = h("h3", { class: "label" });
        heading.textContent = `${group.room_name ?? "Outside any room"} · ${group.changes.length}`;
        return h("li", { class: "cmp-group" }, heading, h("ul", {}, group.changes.map(changeNode)));
      }),
    );
    $("#cmp-none", root).hidden = groups.length > 0 || state.result.summary.total === 0;
  }

  function changeNode(change) {
    const style = KIND_STYLE[change.change_type];
    const title = h("strong", {});
    title.textContent = changeTitle(change);
    const line = h("span", { class: "small muted" });
    line.textContent = changeLine(change, roomName);
    const button = h("button", { type: "button", class: `cmp-change cmp-${style.tone}`, "aria-pressed": String(change.change_id === state.selected), onclick: () => select(change.change_id) },
      h("span", { class: "chip" }, h("span", { class: "icon", "aria-hidden": "true" }, style.icon), style.label),
      title,
      line,
    );
    return h("li", {}, button);
  }

  function details() {
    const change = state.result.changes.find((candidate) => candidate.change_id === state.selected);
    const panel = $("#cmp-details", root);
    panel.hidden = !change;
    if (!change) return;
    const title = h("h3", {});
    title.textContent = `${changeTitle(change)} · ${KIND_STYLE[change.change_type].label}`;
    const rows = detailRows(change, roomName);
    const line = h("p", { class: "small muted" });
    line.textContent = changeLine(change, roomName);
    const table = rows.length
      ? h("table", { class: "cmp-table" },
          h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Property"), h("th", { scope: "col" }, "Version A"), h("th", { scope: "col" }, "Version B"))),
          h("tbody", {}, rows.map((row) => h("tr", {}, h("th", { scope: "row" }, row.property), h("td", { class: "mono" }, row.a), h("td", { class: "mono" }, row.b)))),
        )
      : null;
    panel.replaceChildren(...[title, line, table].filter(Boolean));
  }

  function select(changeId) {
    state.selected = state.selected === changeId ? null : changeId;
    const change = state.result.changes.find((candidate) => candidate.change_id === state.selected);
    list();
    details();
    if (change) fitTo(focusBox(change));
    else paint();
    root.querySelector(`.cmp-change[aria-pressed="true"]`)?.focus();
  }

  // ---- loading ---------------------------------------------------------------------------------------------

  function fillSelectors() {
    const versions = host.versions();
    for (const [id, key] of [["#cmp-a", "a"], ["#cmp-b", "b"]]) {
      const select = $(id, root);
      select.replaceChildren(...versions.map((version) => {
        const option = h("option", { value: version.id });
        option.textContent = versionName(version);
        return option;
      }));
      select.value = state[key];
    }
    captions();
  }

  function captions() {
    const a = versionById(state.a);
    const b = versionById(state.b);
    $("#cmp-caption-a", root).textContent = a ? `A · baseline · ${versionName(a)}` : "";
    $("#cmp-caption-b", root).textContent = b ? `${state.mode === "diff" ? "Differences on B" : "B · compared"} · ${versionName(b)}` : "";
  }

  async function load({ keepView = false } = {}) {
    fillSelectors();
    $("#cmp-error", root).textContent = "";
    if (state.a === state.b) {
      state.request++; // an answer for the previous pair, still on its way, must not repaint it
      $("#cmp-status", root).textContent = "";
      state.result = null;
      showResult(false);
      $("#cmp-error", root).textContent = "Choose two different versions to compare.";
      return;
    }
    const request = ++state.request; // a slower earlier answer must not replace a newer one
    $("#cmp-status", root).textContent = "Comparing…";
    try {
      const [result, planA, planB] = await Promise.all([
        api(`${base}/versions/compare`, { method: "POST", body: { version_a_id: state.a, version_b_id: state.b } }),
        geometry(state.a),
        geometry(state.b),
      ]);
      if (request !== state.request) return;
      state.result = { ...result, groups: resolveGroups(result.groups, result.changes), planA, planB };
      if (!state.result.changes.some((change) => change.change_id === state.selected)) state.selected = null;
      showResult(true);
      summary();
      filters();
      list();
      details();
      keepView ? paint() : fitTo(null);
    } catch (error) {
      if (request !== state.request) return;
      state.result = null;
      showResult(false);
      // The selections stay, so the designer can pick another version and try again.
      $("#cmp-error", root).textContent = error.message || "These versions could not be compared.";
    } finally {
      if (request === state.request) $("#cmp-status", root).textContent = "";
    }
  }

  function showResult(visible) {
    for (const id of ["#cmp-plans", "#cmp-result"]) $(id, root).hidden = !visible;
  }

  function setMode(mode) {
    state.mode = mode;
    for (const button of root.querySelectorAll("[data-mode]")) button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
    $("#cmp-plans", root).classList.toggle("single", mode === "diff");
    $("#cmp-plan-a", root).hidden = mode !== "side";
    captions();
    requestAnimationFrame(paint); // the plan area changed width
  }

  // ---- wiring ----------------------------------------------------------------------------------------------

  attachNavigation(svgA);
  attachNavigation(svgB);
  $("#cmp-a", root).addEventListener("change", (event) => {
    state.a = event.target.value;
    load();
  });
  $("#cmp-b", root).addEventListener("change", (event) => {
    state.b = event.target.value;
    load();
  });
  $("#cmp-swap", root).addEventListener("click", () => {
    [state.a, state.b] = [state.b, state.a];
    load({ keepView: true });
  });
  for (const button of root.querySelectorAll("[data-mode]")) button.addEventListener("click", () => setMode(button.dataset.mode));
  $("#cmp-kind", root).addEventListener("change", (event) => {
    state.kind = event.target.value;
    list();
  });
  $("#cmp-room", root).addEventListener("change", (event) => {
    state.room = event.target.value;
    list();
  });
  $("#cmp-zoom-in", root).addEventListener("click", () => zoomBy(1 / 1.25));
  $("#cmp-zoom-out", root).addEventListener("click", () => zoomBy(1.25));
  $("#cmp-zoom-fit", root).addEventListener("click", () => fitTo(null));
  $("#cmp-exit", root).addEventListener("click", () => host.exit());
  $("#cmp-continue-a", root).addEventListener("click", () => host.continueFrom(versionById(state.a)));
  $("#cmp-continue-b", root).addEventListener("click", () => host.continueFrom(versionById(state.b)));
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.target.closest("select")) host.exit();
  });
  window.addEventListener("resize", () => !root.hidden && paint());

  return {
    // Opens with the given pair, or the newest version against the one before it.
    open(pair = defaultPair(host.versions())) {
      if (!pair) return false;
      Object.assign(state, { a: pair.a, b: pair.b, selected: null, kind: "all", room: "all" });
      root.hidden = false;
      $("#cmp-dirty", root).hidden = !host.isDirty();
      setMode(state.mode);
      requestAnimationFrame(() => load()); // the plan areas need their size before the first drawing
      $("#cmp-a", root).focus();
      return true;
    },
    close() {
      state.request++;
      root.hidden = true;
    },
  };
}
