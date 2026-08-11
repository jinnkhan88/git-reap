// First-run intro screen: what git-reap is, why it is safe, and how to
// start. Shows a small ASCII animation (branches grow on a line, a sweep
// eats them left-to-right, loop) so the screen feels alive. The same
// BranchArt is reused in the main app header. Shown once (seen marker in
// the data dir) or on demand with `--intro`. Any key except q starts the
// app.

import { useKeyboard, useRenderer } from "@opentui/react";
import { useEffect, useState } from "react";
import { markIntroSeen } from "../intro-state.js";
import { THEME } from "./theme.js";

// --- ASCII animation frames -------------------------------------------
// the story: dead branches grow on a line to the right, a sweep eats them
// left-to-right, reset, repeat. The sweep glyph (═) is a separate span so
// it can take the warn color while surviving branches stay accent.
export const REAP_FRAMES = [
  "●",
  "●──●",
  "●──●──●",
  "●──●──●──●",
  "═●──●──●",
  "══●──●",
  "═══●",
  "══════",
  "●",
];

export const SPINNER = ["|", "/", "-", "\\"];

export function useLoop(frames, ms) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => (x + 1) % frames.length), ms);
    return () => clearInterval(t);
  }, [frames.length, ms]);
  return i;
}

/**
 * The animated branch sweep, as inline spans (embeddable inside any
 * <text>). Reused in the intro and the main header. `frame` pins the
 * index (tests); otherwise it loops.
 */
export function BranchArt({ frame = null, intervalMs = 600 }) {
  const artIdx = useLoop(REAP_FRAMES, intervalMs);
  const idx = frame ?? artIdx;
  const art = REAP_FRAMES[idx];
  const i = art.indexOf("═");
  const sweep = i === -1 ? "" : art.slice(0, i + 1);
  const rest = i === -1 ? art : art.slice(i + 1);
  return (
    <>
      <span fg={THEME.warn} attributes={1}>
        {sweep}
      </span>
      <span fg={THEME.accent}>{rest}</span>
    </>
  );
}

// every row centered: full-width wrapper + centered text (the outer box's
// alignItems centers the wrapper, and the wrapper centers the text — two
// levels so variable-width lines all center on their own content)
function Center({ children }) {
  return (
    <box width="100%" alignItems="center">
      {children}
    </box>
  );
}

function Section({ title, lines }) {
  return (
    <box flexDirection="column" width="100%" alignItems="center">
      <Center>
        <text fg={THEME.sub} attributes={1}>
          {title}
        </text>
      </Center>
      {lines.map((l) => (
        <Center key={l}>
          <text fg={THEME.text}>{l}</text>
        </Center>
      ))}
      <Center>
        <text> </text>
      </Center>
    </box>
  );
}

/**
 * @param frame  optional fixed frame index (tests); defaults to auto-loop
 * @param intervalMs  animation cadence (default 600ms)
 */
export function Intro({ dataDir, onStart, frame = null, intervalMs = 600, renderer = null }) {
  const spinIdx = useLoop(SPINNER, 120);
  const ctxRenderer = useRenderer();
  const r = renderer ?? ctxRenderer;

  const quit = () => {
    try {
      r?.destroy();
    } catch {
      // exit guard in tui/index.js covers us
    }
    process.exit(0);
  };

  useKeyboard((e) => {
    if (e.name === "q") {
      quit();
    }
    // any other key starts the app; remember the dismissal
    markIntroSeen(dataDir);
    onStart();
  });

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      backgroundColor={THEME.base}
    >
      <Center>
        <text>
          <BranchArt frame={frame} intervalMs={intervalMs} />
        </text>
      </Center>
      <Center>
        <text fg={THEME.accent} attributes={1}>
          {`${SPINNER[spinIdx]} git-reap`}
        </text>
      </Center>
      <Center>
        <text fg={THEME.dim} attributes={0}>
          dead branches, swept safely across all your repos
        </text>
      </Center>
      <Center>
        <text> </text>
      </Center>
      <Section
        title="what it does"
        lines={[
          "scans every repo under your roots in one pass",
          "classifies each branch: merged · gone · stale · active",
          "marks only provably-safe branches as selectable",
        ]}
      />
      <Section
        title="why it is safe"
        lines={[
          "dry-run plan first: nothing executes until you confirm",
          "guards re-check every branch at delete time",
          "every delete gets an undo ref + ledger (90-day retention)",
        ]}
      />
      <Section
        title="how to start"
        lines={[
          "↑↓ move · tab switch pane · space select · enter plan",
          "/ search · r rescan · ? help · [ ] resize",
        ]}
      />
      <Center>
        <text fg={THEME.dim}>press any key to start (q quits)</text>
      </Center>
    </box>
  );
}
