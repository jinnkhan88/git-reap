// Repo kind detection: which stack lives in a repo, from marker files in its
// root. Drives the repo-pane icon in the TUI.
//
// Icon mode: emoji by default (renders anywhere an emoji font exists). A TUI
// cannot ship a font — the terminal emulator rasterizes glyphs from system
// fonts — so Nerd Font devicons are opt-in: GIT_REAP_ICONS=nerd. Use it only
// where a Nerd Font is installed (on SSH sessions that means the CLIENT
// machine's terminal, not the host).

import { existsSync } from "node:fs";
import { join } from "node:path";

const ICON_MODE = process.env.GIT_REAP_ICONS === "nerd" ? "nerd" : "emoji";

const KIND_META = {
  rust: { emoji: "🦀", nerd: "\ue7a8" }, // nf-dev-rust
  ts: { emoji: "🟦", nerd: "\ue628" }, // nf-seti-typescript
  js: { emoji: "🟨", nerd: "\ue74e" }, // nf-dev-javascript
  python: { emoji: "🐍", nerd: "\ue73c" }, // nf-dev-python
  go: { emoji: "🐹", nerd: "\ue724" }, // nf-dev-go
  ruby: { emoji: "💎", nerd: "\ue739" }, // nf-dev-ruby
  php: { emoji: "🐘", nerd: "\ue73d" }, // nf-dev-php
  jvm: { emoji: "☕", nerd: "\ue738" }, // nf-dev-java
  elixir: { emoji: "💧", nerd: "\ue62d" }, // nf-seti-elixir
  repo: { emoji: "📁", nerd: "\uf07b" }, // nf-fa-folder
};

export function kindIcon(kind, mode = ICON_MODE) {
  return (KIND_META[kind] ?? KIND_META.repo)[mode];
}

const has = (dir, name) => existsSync(join(dir, name));

/** Best-guess primary stack of the repo at `dir`. */
export function detectRepoKind(dir) {
  if (has(dir, "Cargo.toml")) return "rust";
  if (has(dir, "go.mod")) return "go";
  if (has(dir, "pyproject.toml") || has(dir, "setup.py") || has(dir, "requirements.txt"))
    return "python";
  if (has(dir, "Gemfile")) return "ruby";
  if (has(dir, "composer.json")) return "php";
  if (has(dir, "pom.xml") || has(dir, "build.gradle") || has(dir, "build.gradle.kts")) return "jvm";
  if (has(dir, "mix.exs")) return "elixir";
  if (has(dir, "package.json")) return has(dir, "tsconfig.json") ? "ts" : "js";
  return "repo";
}
