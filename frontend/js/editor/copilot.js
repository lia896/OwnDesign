// The design copilot: an AI panel docked beside the plan. It sends the plan as it is in the editor (unsaved edits
// included) with a scope (whole project, one room, one item), and shows the structured reply: observations and
// recommendation cards. A card's changes can be previewed on the canvas; a studio designer can apply them, which
// the server checks again and saves as a new version. All model text is set with textContent only.
import { api } from "../api.js";
import { describeAction, itemName, roomOf, scopeTargets } from "../copilot-logic.js";
import { messageState } from "../design-logic.js";
import * as P from "../plan.js";
import { $, formatDate, h } from "../ui.js";

const cm = (value) => `${Math.round(value)} cm`;
const QUICK = ["Analyse the current layout", "Suggest improvements", "Check circulation and door clearances", "Suggest alternative arrangements"];
const SCOPE_LABEL = { project: "Entire project", room: "Room", object: "Item" };

// host: { projectId, canApply, plan(), selection(), baseVersionNo(), isDirty(), preview(plan, ids, title), endPreview(), applied(version) }
export function mountCopilot(root, host) {
  const base = `/v1/projects/${encodeURIComponent(host.projectId)}/copilot`;
  const dismissedKey = `copilot-dismissed:${host.projectId}`;
  const dismissed = new Set(JSON.parse(localStorage.getItem(dismissedKey) ?? "[]"));
  const box = $("#copilot-message", root);
  const scopeSelect = $("#copilot-scope", root);
  let previewing = null; // the card key being previewed
  let loaded = false;
  let busy = false;

  const remember = () => localStorage.setItem(dismissedKey, JSON.stringify([...dismissed].slice(-200)));

  function currentScope() {
    const { room, item } = scopeTargets(host.plan(), host.selection());
    const kind = scopeSelect.value;
    if (kind === "object" && item) return { kind, id: item.id };
    if (kind === "room" && room) return { kind, id: room.id };
    return { kind: "project", id: null };
  }

  // Context line and scope options follow the selection on the canvas.
  function refresh() {
    if (root.hidden) return;
    const plan = host.plan();
    const { room, item } = scopeTargets(plan, host.selection());
    const options = scopeSelect.options;
    options[1].disabled = !room;
    options[1].textContent = room ? `Room: ${room.name}` : "Selected room";
    options[2].disabled = !item;
    options[2].textContent = item ? `Item: ${itemName(item)}` : "Selected item";
    if (scopeSelect.selectedOptions[0]?.disabled) scopeSelect.value = "project";
    const scope = currentScope();
    let text;
    if (scope.kind === "object") {
      text = `${itemName(item)} · ${cm(item.w)} × ${cm(item.d)}${room ? ` · in ${room.name}` : ""}`;
    } else if (scope.kind === "room") {
      const rect = P.roomBox(plan, room.id);
      const inside = plan.furniture.filter((candidate) => roomOf(plan, candidate)?.id === room.id).length;
      text = `${room.name} · ${rect ? `${P.metres(rect.w)} × ${P.metres(rect.h)} m · ` : ""}${inside} furniture ${inside === 1 ? "item" : "items"}`;
    } else {
      text = `${plan.rooms.length} ${plan.rooms.length === 1 ? "room" : "rooms"} · ${plan.furniture.length} furniture ${plan.furniture.length === 1 ? "item" : "items"}`;
    }
    $("#copilot-context", root).textContent = `Analysing: ${text}`;
    refreshComposer();
  }

  function refreshComposer() {
    const { counter, canSend } = messageState(box.value);
    $("#copilot-counter", root).textContent = counter;
    $("#copilot-send", root).disabled = !canSend || busy;
  }

  function endPreview() {
    if (!previewing) return;
    previewing = null;
    for (const button of root.querySelectorAll("[data-preview]")) button.setAttribute("aria-pressed", "false");
    host.endPreview();
  }

  function recommendationCard(rec, key) {
    const actions = rec.actions ?? [];
    const card = h("article", { class: `rec${rec.applicable ? "" : " blocked"}`, "data-key": key });
    const plan = host.plan();
    const buttons = [];
    if (actions.length) {
      const preview = h("button", { type: "button", "data-preview": key, "aria-pressed": "false" }, h("span", { class: "icon", "aria-hidden": "true" }, "visibility"), "Preview");
      preview.addEventListener("click", () => {
        if (previewing === key) return endPreview();
        endPreview();
        previewing = key;
        preview.setAttribute("aria-pressed", "true");
        host.preview(P.applyActions(host.plan(), actions), new Set(actions.map((action) => action.object_id)), rec.title);
      });
      buttons.push(preview);
    }
    if (host.canApply && rec.applicable) {
      const apply = h("button", { type: "button", class: "primary" }, h("span", { class: "icon", "aria-hidden": "true" }, "check"), "Apply");
      apply.addEventListener("click", async () => {
        apply.disabled = true;
        $("#copilot-error", root).textContent = "";
        try {
          endPreview();
          const version = await api(`${base}/apply`, {
            method: "POST",
            body: { base_version_no: host.baseVersionNo(), label: `Copilot: ${rec.title}`.slice(0, 80), actions, geometry: host.plan() },
          });
          dismissed.add(key);
          remember();
          card.remove();
          host.applied(version);
        } catch (error) {
          $("#copilot-error", root).textContent = error.message;
          apply.disabled = false;
        }
      });
      buttons.push(apply);
    }
    const ask = (text) => {
      box.value = text;
      refreshComposer();
      box.focus();
    };
    buttons.push(
      h("button", { type: "button", onclick: () => ask(`About "${rec.title}": `) }, "Ask about this"),
      h("button", { type: "button", onclick: () => send(`Suggest a different alternative to "${rec.title}".`) }, "Alternative"),
      h("button", {
        type: "button",
        "aria-label": `Dismiss ${rec.title}`,
        onclick: () => {
          if (previewing === key) endPreview();
          dismissed.add(key);
          remember();
          card.remove();
        },
      }, "Dismiss"),
    );
    const title = h("h3", {});
    title.textContent = rec.title;
    const description = h("p", {});
    description.textContent = rec.description;
    const changes = actions.length ? h("ul", { class: "rec-actions" }, actions.map((action) => h("li", { class: "code" }, describeAction(plan, action)))) : null;
    const status = rec.applicable
      ? h("span", { class: "chip ok" }, "Action · checked")
      : actions.length
        ? h("span", { class: "chip caution" }, "Needs review")
        : h("span", { class: "chip" }, "Recommendation");
    const problems = (rec.problems ?? []).length ? h("ul", { class: "rec-problems" }, rec.problems.map((text) => h("li", {}, text))) : null;
    card.append(h("div", { class: "rec-head" }, status), title, description, changes, problems, h("div", { class: "rec-buttons" }, buttons));
    return card;
  }

  function turnNode(message) {
    const when = h("time", { class: "code" });
    when.dateTime = message.created_at ?? "";
    when.textContent = message.created_at ? formatDate(message.created_at) : "";
    if (message.role === "user") {
      const text = h("p", { class: "msg-text" });
      text.textContent = message.content;
      const scope = message.payload?.scope?.kind ?? "project";
      return h("li", { class: "turn user" }, h("div", { class: "msg-head" }, h("span", { class: "chip" }, SCOPE_LABEL[scope] ?? "Project"), when), text);
    }
    const reply = message.payload ?? { summary: message.content, observations: [], recommendations: [] };
    const summary = h("p", { class: "msg-text" });
    summary.textContent = reply.summary || message.content;
    const observations = (reply.observations ?? []).map((obs) => {
      const title = h("strong", {});
      title.textContent = obs.title;
      const text = h("p", {});
      text.textContent = obs.description;
      const tag = obs.type === "issue" ? h("span", { class: `chip ${obs.severity === "high" ? "accent" : "caution"}` }, `Issue · ${obs.severity}`) : h("span", { class: "chip ok" }, "Insight");
      return h("li", { class: `obs ${obs.type}` }, tag, title, text);
    });
    const recs = (reply.recommendations ?? [])
      .map((rec, index) => [rec, `${message.created_at}:${rec.id ?? index}`])
      .filter(([, key]) => !dismissed.has(key))
      .map(([rec, key]) => recommendationCard(rec, key));
    return h("li", { class: "turn assistant" },
      h("div", { class: "msg-head" }, h("span", { class: "who" }, "Copilot"), when),
      summary,
      observations.length ? h("ul", { class: "obs-list", "aria-label": "Observations" }, observations) : null,
      recs,
    );
  }

  function append(messages) {
    const thread = $("#copilot-thread", root);
    thread.append(...messages.map(turnNode));
    $("#copilot-empty", root).hidden = thread.children.length > 0;
    thread.lastElementChild?.scrollIntoView({ block: "nearest" });
  }

  async function send(text = box.value) {
    const message = text.trim();
    if (busy || !messageState(message).canSend) return;
    busy = true;
    refreshComposer();
    $("#copilot-error", root).textContent = "";
    $("#copilot-status", root).textContent = "Reviewing the plan…";
    try {
      append(await api(`${base}/messages`, { method: "POST", body: { message, scope: currentScope(), geometry: host.plan() } }));
      if (text === box.value) box.value = "";
    } catch (error) {
      $("#copilot-error", root).textContent = error.message || "Something went wrong.";
      // After a failed answer the question is already stored (it may have been billed): show it, do not resend.
      if (error.status === 502) await reload().catch(() => {});
      if (error.status === 502 && text === box.value) box.value = "";
    } finally {
      busy = false;
      $("#copilot-status", root).textContent = "";
      refreshComposer();
    }
  }

  async function reload() {
    const messages = await api(`${base}/messages`);
    $("#copilot-thread", root).replaceChildren();
    append(messages);
  }

  $("#copilot-quick", root).replaceChildren(...QUICK.map((text) => h("button", { type: "button", onclick: () => send(text) }, text)));
  box.addEventListener("input", refreshComposer);
  box.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    send();
  });
  $("#copilot-form", root).addEventListener("submit", (event) => {
    event.preventDefault();
    send();
  });
  scopeSelect.addEventListener("change", refresh);
  if (!host.canApply) $("#copilot-note", root).textContent = "Suggestions can be previewed here. Only the studio's designers can apply them.";

  return {
    refresh,
    endPreview,
    async open() {
      root.hidden = false;
      refresh();
      if (!loaded) {
        loaded = true;
        await reload().catch((error) => {
          loaded = false;
          $("#copilot-error", root).textContent = error.message;
        });
      }
      box.focus();
    },
    close() {
      endPreview();
      root.hidden = true;
    },
  };
}
