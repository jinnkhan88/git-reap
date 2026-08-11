// TUI entry: keeps JSX out of this file so plain .js stays untransformed.

import { writeSync } from "node:fs";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createElement } from "react";
import { App } from "./app.jsx";

// Safety net: process.exit() bypasses OpenTUI's signal/beforeExit cleanup
// (which is the only thing that disables terminal mouse tracking). Any
// direct exit leaves the terminal in mouse-reporting mode and raw
// ESC[<b>;<x>;<y>M sequences leak onto the console. This handler runs on
// EVERY exit path and force-disables every mouse mode we may have enabled.
export const MOUSE_DISABLE_SEQ =
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l" + "\x1b[?25h"; // show cursor again, just in case

let exitGuardInstalled = false;
function installExitGuard() {
  if (exitGuardInstalled) return;
  exitGuardInstalled = true;
  process.on("exit", () => {
    try {
      writeSync(1, MOUSE_DISABLE_SEQ);
    } catch {
      // stdout may already be gone; nothing sensible to do
    }
  });
}

export async function startTui(options) {
  installExitGuard();
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  createRoot(renderer).render(createElement(App, { options, renderer }));
}
