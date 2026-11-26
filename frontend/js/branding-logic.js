// Pure helpers for studio branding: logo checks, colour parsing, contrast and the derived theme. No DOM, no network.

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MIN_CONTRAST = 4.5; // WCAG AA for normal text

export const DEFAULT_COLORS = { primary: "#9f3c16", background: "#fbf9f6", text: "#1b1c1a" };

export const PRESETS = [
  { id: "nordic", name: "Nordic Warmth", colors: DEFAULT_COLORS },
  { id: "brutalist", name: "Brutalist Mono", colors: { primary: "#2f2f2d", background: "#f2f1ef", text: "#171717" } },
  { id: "kyoto", name: "Kyoto Minimal", colors: { primary: "#7d5a1e", background: "#fbf7ee", text: "#23201a" } },
  { id: "milano", name: "Milano Heritage", colors: { primary: "#3f624d", background: "#f7f6f2", text: "#1d221f" } },
];

export function parseHex(value) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value ?? "").trim());
  return match ? `#${match[1].toLowerCase()}` : null;
}

const channels = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));

// `amount` of `other` blended into `base` (0 to 1).
const mix = (base, other, amount) => {
  const to = channels(other);
  return `#${channels(base).map((from, i) => Math.round(from + (to[i] - from) * amount).toString(16).padStart(2, "0")).join("")}`;
};

function luminance(hex) {
  const [r, g, b] = channels(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
}

// The app's CSS variables for a studio's three colours (all must be valid hex).
export function themeTokens({ primary, background, text }) {
  const lightLabel = contrast(primary, "#ffffff") >= contrast(primary, "#000000");
  const onPrimary = lightLabel ? "#ffffff" : "#000000";
  const darkPage = contrast(background, "#ffffff") > contrast(background, "#000000");
  return {
    "--primary": primary,
    "--primary-bright": mix(primary, lightLabel ? "#000000" : "#ffffff", 0.15), // hover moves away from the label colour
    "--on-primary": onPrimary,
    "--primary-tint": mix(background, primary, 0.15),
    "--surface": background,
    "--surface-low": mix(background, text, 0.03),
    "--panel": mix(background, "#ffffff", darkPage ? 0.05 : 0.7),
    "--ink": text,
    "--ink-soft": mix(text, background, 0.2),
  };
}

export function checkColors(colors) {
  const tokens = themeTokens(colors);
  const surfaces = [tokens["--surface"], tokens["--surface-low"], tokens["--panel"]];
  const worst = (color) => Math.min(...surfaces.map((surface) => contrast(color, surface)));
  const problems = [];
  if (worst(colors.text) < MIN_CONTRAST) problems.push("Text colour is too close to the background.");
  if (worst(colors.primary) < MIN_CONTRAST) problems.push("Primary colour is too close to the background for links.");
  return { ok: problems.length === 0, textRatio: worst(colors.text), problems };
}

// Returns a message for the user, or null when the file may be used.
export function validateLogoFile(file) {
  if (!file) return "Choose an image first.";
  if (!LOGO_TYPES.includes(file.type)) return "Only PNG, JPG and WebP images are accepted.";
  if (file.size === 0) return "The file is empty.";
  if (file.size > MAX_LOGO_BYTES) return "The logo can be at most 2 MB.";
  return null;
}
