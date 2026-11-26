// Studio branding preview: logo and colours applied to a sample client page. Nothing is saved or uploaded.
import { DEFAULT_COLORS, PRESETS, checkColors, parseHex, themeTokens, validateLogoFile } from "../branding-logic.js";
import { $, h } from "../ui.js";

const FIELDS = [["primary", "Primary colour"], ["background", "Background colour"], ["text", "Text colour"]];
let colors = { ...DEFAULT_COLORS };
let logoUrl = null;
let logoRequest = 0;

const preview = $("#theme-preview");

function render() {
  for (const [name, value] of Object.entries(themeTokens(colors))) preview.style.setProperty(name, value);
  for (const [key] of FIELDS) {
    $(`#pick-${key}`).value = colors[key];
    $(`#hex-${key}`).value = colors[key];
    $(`#hex-${key}`).removeAttribute("aria-invalid");
  }
  for (const preset of PRESETS) {
    const active = FIELDS.every(([key]) => preset.colors[key] === colors[key]);
    $(`#preset-${preset.id}`).setAttribute("aria-pressed", String(active));
  }
  const { ok, textRatio, problems } = checkColors(colors);
  const status = $("#contrast");
  status.classList.toggle("error", !ok);
  status.textContent = ok ? `Readable. Text contrast ${textRatio}:1.` : `${problems.join(" ")} This combination would not be saved.`;
}

const setColor = (key, value) => {
  colors = { ...colors, [key]: value };
  render();
};

$("#presets").append(
  ...PRESETS.map((preset) =>
    h(
      "button",
      { type: "button", id: `preset-${preset.id}`, class: "preset", onclick: () => { colors = { ...preset.colors }; render(); } },
      h("span", {}, preset.name),
      h("span", { class: "preset-swatches", "aria-hidden": "true" }, FIELDS.map(([key]) => {
        const swatch = h("span", { class: "swatch-dot" });
        swatch.style.background = preset.colors[key];
        return swatch;
      })),
    ),
  ),
);

$("#colors").append(
  ...FIELDS.map(([key, label]) =>
    h(
      "fieldset",
      {},
      h("legend", {}, label),
      h(
        "div",
        { class: "linkbox" },
        h("input", { type: "color", id: `pick-${key}`, "aria-label": `${label} picker`, oninput: (event) => setColor(key, event.target.value) }),
        h("input", {
          type: "text", id: `hex-${key}`, "aria-label": `${label} hex code`, maxLength: 7, spellcheck: false,
          onchange: (event) => {
            const value = parseHex(event.target.value);
            if (value) return setColor(key, value);
            event.target.setAttribute("aria-invalid", "true");
            $("#contrast").classList.add("error");
            $("#contrast").textContent = `${label}: enter a six-digit hex code such as #9f3c16.`;
          },
        }),
      ),
    ),
  ),
);

function showLogo(url) {
  if (logoUrl) URL.revokeObjectURL(logoUrl);
  logoUrl = url;
  const image = $("#preview-logo");
  if (url) image.src = url;
  else image.removeAttribute("src");
  image.hidden = !url;
  $("#preview-name").hidden = Boolean(url); // without a logo the studio name is shown, as today
  $("#logo-remove").disabled = !url;
}

$("#logo-file").addEventListener("change", async (event) => {
  const request = ++logoRequest;
  const file = event.target.files[0];
  event.target.value = ""; // the same file can be chosen again
  if (!file) return;
  const error = validateLogoFile(file);
  $("#logo-error").textContent = error ?? "";
  if (error) return;
  const url = URL.createObjectURL(file);
  const probe = new Image();
  probe.src = url;
  try {
    await probe.decode(); // a file that only claims to be an image is refused
  } catch {
    URL.revokeObjectURL(url);
    if (request === logoRequest) $("#logo-error").textContent = "This file could not be read as an image.";
    return;
  }
  if (request !== logoRequest) return URL.revokeObjectURL(url); // a newer choice or removal won
  showLogo(url);
});

$("#logo-remove").addEventListener("click", () => {
  logoRequest++;
  $("#logo-error").textContent = "";
  showLogo(null);
});

$("#reset").addEventListener("click", () => {
  colors = { ...DEFAULT_COLORS };
  render();
});

render();
