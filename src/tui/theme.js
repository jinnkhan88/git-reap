// git-reap TUI palette — the single source of truth for color.
//
// Derived from Catppuccin Mocha: muted pastels designed for dark terminals,
// softer than raw ANSI primaries so dense rows stay readable. One accent
// (teal) is locked for all chrome: title, focused borders, checkboxes,
// divider-active. Class badges get muted semantic hues because hue IS the
// information there. Never put raw ANSI color names back into app.jsx —
// test/tui-theme.test.js locks that.

export const THEME = {
  accent: "#94e2d5", // teal — title, focused border, checked box, divider drag
  text: "#cdd6f4", // primary text (repo names, branch names)
  sub: "#a6adc8", // secondary text (pane titles, column header)
  dim: "#6c7086", // meta text (footer, hints, empty states)
  surface: "#313244", // note strips (undo/blocked) + divider while dragging
  select: "#2e4a46", // active-row background: teal-tinted, visible, badge-safe
  line: "#45475a", // unfocused borders, idle divider
  base: "#1e1e2e", // overlay background
  warn: "#f9e2af", // attention (scanning note, dry-run title)
  danger: "#f38ba8", // destructive classes (gone, closed-unmerged, no-default)
};

// Semantic class badges. Two families share hues deliberately:
// gone/closed = danger family, stale/patch≡ = caution family.
export const CLASS_STYLE = {
  gone: { fg: THEME.danger, label: "gone" },
  merged: { fg: "#89b4fa", label: "merged" },
  "squash-merged": { fg: "#cba6f7", label: "squash" },
  stale: { fg: THEME.warn, label: "stale" },
  active: { fg: "#a6e3a1", label: "active" },
  protected: { fg: THEME.dim, label: "protected" },
  default: { fg: THEME.accent, label: "default" },
  "patch-equivalent": { fg: THEME.warn, label: "patch≡" },
  "closed-unmerged": { fg: THEME.danger, label: "closed" },
};

export const EVIDENCE_FG = "#89dceb"; // sky — "via PR" host-evidence marker
