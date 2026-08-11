// First-run intro state (plain JS so bin.js can read it without JSX).
// The intro shows on first launch; `--intro` forces it back. Seen state
// lives in the platform data dir next to the ledger.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function introStatePath(dataDir) {
  return join(dataDir, "intro-seen.json");
}

/** Has the intro been dismissed before? */
export function introSeen(dataDir) {
  return existsSync(introStatePath(dataDir));
}

/** Record that the intro was dismissed. Idempotent. */
export function markIntroSeen(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(introStatePath(dataDir), JSON.stringify({ seen: true, at: Date.now() }));
}
