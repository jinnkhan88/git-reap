import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CLASS_STYLE, EVIDENCE_FG, THEME } from "../src/tui/theme.js";

// Palette discipline lock: every color in the TUI comes from theme.js.
// Raw ANSI names ("red", "yellow", ...) remap per terminal palette and would
// make the app look different (and often unreadable) on every machine;
// arbitrary hexes bypass the one-palette rule.

const appSrc = readFileSync(new URL("../src/tui/app.jsx", import.meta.url), "utf8");

describe("theme discipline", () => {
  test("app.jsx contains no raw ANSI color names", () => {
    expect(appSrc).not.toMatch(/fg="(?:red|yellow|green|blue|magenta|cyan|white|gray)"/);
    expect(appSrc).not.toMatch(/bg="(?:red|yellow|green|blue|magenta|cyan|white|gray)"/);
    expect(appSrc).not.toMatch(/borderColor="(?:red|yellow|green|blue|magenta|cyan|white|gray)"/);
  });

  test("app.jsx contains no ad-hoc hex colors outside the theme", () => {
    expect(appSrc).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  test("every theme token and badge color is a true-color hex", () => {
    for (const [name, value] of Object.entries(THEME)) {
      expect(value, `THEME.${name}`).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(EVIDENCE_FG).toMatch(/^#[0-9a-f]{6}$/);
    for (const [name, style] of Object.entries(CLASS_STYLE)) {
      expect(style.fg, `CLASS_STYLE.${name}.fg`).toMatch(/^#[0-9a-f]{6}$/);
      expect(style.label.length, `CLASS_STYLE.${name}.label`).toBeGreaterThan(0);
    }
  });

  test("badge hues are distinct per meaning family", () => {
    const hue = (cls) => CLASS_STYLE[cls].fg;
    // the four primary states must be visually distinguishable
    const primary = [hue("gone"), hue("merged"), hue("active"), hue("stale")];
    expect(new Set(primary).size).toBe(4);
    // destructive family shares the danger hue (gone + closed-unmerged)
    expect(hue("closed-unmerged")).toBe(THEME.danger);
    expect(hue("gone")).toBe(THEME.danger);
    // the default branch badge matches the chrome accent
    expect(hue("default")).toBe(THEME.accent);
  });
});
