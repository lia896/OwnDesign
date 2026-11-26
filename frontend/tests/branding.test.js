import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_COLORS, MAX_LOGO_BYTES, PRESETS, checkColors, contrast, parseHex, themeTokens, validateLogoFile } from "../js/branding-logic.js";

test("parseHex normalises six-digit colours and rejects everything else", () => {
  assert.equal(parseHex(" #9F3C16 "), "#9f3c16");
  assert.equal(parseHex("9f3c16"), "#9f3c16");
  for (const bad of ["", "#fff", "#12345g", "#1234567", "red", "url(x)", null, undefined]) assert.equal(parseHex(bad), null);
});

test("contrast follows WCAG at its extremes and ignores order", () => {
  assert.equal(contrast("#000000", "#ffffff"), 21);
  assert.equal(contrast("#ffffff", "#000000"), 21);
  assert.equal(contrast("#777777", "#777777"), 1);
});

test("the default and every preset are readable", () => {
  assert.equal(PRESETS.length, 4);
  for (const colors of [DEFAULT_COLORS, ...PRESETS.map((preset) => preset.colors)]) {
    assert.deepEqual(checkColors(colors).problems, [], JSON.stringify(colors));
  }
});

test("unreadable text or primary colour is reported", () => {
  const faintText = checkColors({ ...DEFAULT_COLORS, text: "#dddddd" });
  assert.equal(faintText.ok, false);
  assert.match(faintText.problems.join(" "), /Text colour/);
  const faintPrimary = checkColors({ ...DEFAULT_COLORS, primary: "#ffee88" });
  assert.equal(faintPrimary.ok, false);
  assert.match(faintPrimary.problems.join(" "), /Primary colour/);
});

test("button labels stay readable on light and dark primaries, including hover", () => {
  for (const colors of [DEFAULT_COLORS, { primary: "#ffcc66", background: "#121212", text: "#f5f5f5" }]) {
    const tokens = themeTokens(colors);
    assert.ok(contrast(tokens["--on-primary"], tokens["--primary"]) >= 4.5);
    assert.ok(contrast(tokens["--on-primary"], tokens["--primary-bright"]) >= 4.5);
  }
});

test("a dark background keeps panels dark so the text stays readable", () => {
  const colors = { primary: "#ffcc66", background: "#121212", text: "#f5f5f5" };
  assert.deepEqual(checkColors(colors).problems, []);
  assert.ok(contrast(themeTokens(colors)["--panel"], colors.text) >= 4.5);
});

test("themeTokens only ever returns plain hex colours", () => {
  for (const value of Object.values(themeTokens(DEFAULT_COLORS))) assert.match(value, /^#[0-9a-f]{6}$/);
});

test("validateLogoFile checks presence, type and the 2 MB limit", () => {
  assert.match(validateLogoFile(undefined), /Choose/);
  assert.match(validateLogoFile({ type: "image/svg+xml", size: 10 }), /PNG, JPG and WebP/);
  assert.match(validateLogoFile({ type: "image/png", size: 0 }), /empty/);
  assert.match(validateLogoFile({ type: "image/png", size: MAX_LOGO_BYTES + 1 }), /2 MB/);
  assert.equal(validateLogoFile({ type: "image/webp", size: MAX_LOGO_BYTES }), null);
});
