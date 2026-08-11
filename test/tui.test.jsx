import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyCodes } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act, createElement as h } from "react";
import { App } from "../src/tui/app.jsx";

async function press(setup, key) {
  await act(async () => {
    await setup.mockInput.pressKey(key);
  });
  await setup.renderOnce();
}

// column of the ║ pane divider in the rendered frame (body rows come before
// the footer, which also mentions ║, so top-down scan finds the real divider)
function dividerCol(frame) {
  for (const line of frame.split("\n")) {
    const i = line.indexOf("║");
    if (i !== -1) return i;
  }
  return -1;
}

const SNAPSHOT = {
  fetched: false,
  skipped: [{ path: "/x/bare.git", reason: "bare" }],
  repos: [
    {
      path: "/home/u/projects/alpha",
      commonDir: "/home/u/projects/alpha/.git",
      status: "ok",
      defaultBranch: "main",
      branches: [
        { name: "main", class: "default", eligible: false, ageDays: 1, evidence: { kind: "none" } },
        {
          name: "feat/old-pr",
          class: "gone",
          eligible: true,
          ageDays: 40,
          evidence: { kind: "ancestor" },
        },
        {
          name: "fix/wip",
          class: "active",
          eligible: false,
          ageDays: 2,
          evidence: { kind: "none" },
        },
      ],
      warnings: [],
    },
    {
      path: "/home/u/projects/beta",
      status: "no-default",
      defaultBranch: null,
      branches: [
        {
          name: "topic",
          class: "active",
          eligible: false,
          ageDays: 9,
          evidence: { kind: "none" },
        },
      ],
      warnings: [],
    },
  ],
};

describe("TUI screens", () => {
  test("main screen shows repos, branches, badges, footer", async () => {
    const setup = await testRender(h(App, { options: {}, initialSnapshot: SNAPSHOT }), {
      width: 100,
      height: 30,
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("git-reap");
    expect(frame).toContain("2 repos");
    expect(frame).toContain("1 candidates");
    expect(frame).toContain("projects/alpha");
    expect(frame).toContain("feat/old-pr");
    expect(frame).toContain("gone");
    expect(frame).toContain("active");
    expect(frame).toContain("no-default");
    expect(frame).toContain("q quit");
    expect(frame).toContain("refs not refreshed");
    setup.renderer.destroy();
  });

  test("main header is centered in the terminal width", async () => {
    const setup = await testRender(h(App, { options: {}, initialSnapshot: SNAPSHOT }), {
      width: 100,
      height: 30,
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    const lines = frame.split("\n");
    // git-reap sits on its own row below the animation line; the title
    // row must be centered (leading spaces before the brand), not left-aligned
    const titleLine = lines[1];
    const col = titleLine.indexOf("git-reap");
    expect(col).toBeGreaterThanOrEqual(35);
    expect(col).toBeLessThan(60);
    setup.renderer.destroy();
  });

  test("main header shows one animation line on top of git-reap + stats", async () => {
    const setup = await testRender(h(App, { options: {}, initialSnapshot: SNAPSHOT }), {
      width: 100,
      height: 30,
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    const lines = frame.split("\n");
    // ONE art row on top carrying a branch glyph, no text
    expect(lines[0]).toContain("●");
    expect(lines[0]).not.toContain("git-reap");
    // git-reap + stats below
    expect(lines[1]).toContain("git-reap");
    expect(lines[2]).toContain("1 candidates");
    expect(lines[2]).toContain("refs not refreshed");
    setup.renderer.destroy();
  });

  test("intro ASCII animation frames cycle (grow → sweep)", async () => {
    const setup = await testRender(
      h(App, {
        options: { showIntro: true, dataDir: "/tmp/reap-test-intro" },
        initialSnapshot: SNAPSHOT,
      }),
      { width: 100, height: 30 },
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    // branch art present; the sweep frame uses ═
    expect(frame).toContain("●");
    expect(frame).toContain("git-reap");
    expect(frame).toContain("press any key to start");
    setup.renderer.destroy();
  });

  test("intro copy has zero em-dashes and no AI-tell phrasing", async () => {
    const setup = await testRender(
      h(App, {
        options: { showIntro: true, dataDir: "/tmp/reap-test-intro" },
        initialSnapshot: SNAPSHOT,
      }),
      { width: 100, height: 30 },
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("—"); // taste skill 9.G: em-dash ban
    expect(frame).not.toContain("elevate");
    expect(frame).not.toContain("seamless");
    expect(frame).not.toContain("unleash");
    setup.renderer.destroy();
  });

  test("branches header shows the full, untruncated repo path", async () => {
    const LONG = "/home/u/projects/some-really-long-nested/path/my-repo";
    const snap = { ...SNAPSHOT, repos: [{ ...SNAPSHOT.repos[0], path: LONG }] };
    const setup = await testRender(h(App, { options: {}, initialSnapshot: snap }), {
      width: 170, // wide enough that the header fits with the deleted pane present
      height: 30,
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain(`branches: ${LONG}`);
    setup.renderer.destroy();
  });

  test("branches pane shows a column header aligned to the rows", async () => {
    const setup = await testRender(h(App, { options: {}, initialSnapshot: SNAPSHOT }), {
      width: 120,
      height: 30,
    });
    await setup.renderOnce();
    // branch column flexes: name width = terminal - repos pane - divider/borders
    // - deleted pane (always present, fixed width) - its divider - fixed cols
    const deletedPaneW = Math.max(38, Math.min(46, Math.floor(120 / 5)));
    const branchNameW = Math.max(12, 120 - 36 - 3 - deletedPaneW - 1 - 34);
    const headerLine =
      " sel " + "branch".padEnd(branchNameW + 1) + "class".padEnd(10) + " age  " + "src";
    expect(setup.captureCharFrame()).toContain(headerLine);
    setup.renderer.destroy();
  });

  test("▸ cursor marks the focused pane's row and moves with arrows", async () => {
    const setup = await testRender(h(App, { options: {}, initialSnapshot: SNAPSHOT }), {
      width: 100,
      height: 30,
    });
    await setup.renderOnce();
    // frame lines span BOTH panes; the repos pane occupies cols 0..36, so
    // only inspect that slice when checking the repos cursor marker
    const reposMarked = (frame, name) =>
      frame.split("\n").some((l) => l.slice(0, 37).includes(name) && l.slice(0, 37).includes("▸"));
    expect(reposMarked(setup.captureCharFrame(), "alpha")).toBe(true); // repos pane, first row
    expect(reposMarked(setup.captureCharFrame(), "beta")).toBe(false);
    await press(setup, KeyCodes.ARROW_DOWN);
    expect(reposMarked(setup.captureCharFrame(), "alpha")).toBe(false);
    expect(reposMarked(setup.captureCharFrame(), "beta")).toBe(true); // moved down
    await press(setup, KeyCodes.TAB); // switch to branches pane: repos marker hides
    expect(reposMarked(setup.captureCharFrame(), "beta")).toBe(false);
    setup.renderer.destroy();
  });

  test("search is discoverable: / search hint, live cursor while typing", async () => {
    const setup = await testRender(h(App, { options: {}, initialSnapshot: SNAPSHOT }), {
      width: 100,
      height: 30,
    });
    await setup.renderOnce();
    const idle = setup.captureCharFrame();
    expect(idle).toContain("/ search"); // repos title hint
    expect(idle).not.toContain("/ filter"); // old footer label is gone
    await press(setup, "/");
    await press(setup, "b");
    expect(setup.captureCharFrame()).toContain("/b▍"); // live filter cursor
    setup.renderer.destroy();
  });

  test("repos pane shows a stack icon per repo", async () => {
    const snap = {
      ...SNAPSHOT,
      repos: SNAPSHOT.repos.map((r, i) => ({ ...r, kind: i === 0 ? "rust" : "js" })),
    };
    const setup = await testRender(h(App, { options: {}, initialSnapshot: snap }), {
      width: 100,
      height: 30,
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("🦀");
    expect(frame).toContain("🟨");
    setup.renderer.destroy();
  });

  test("branches show cloud/local from upstream tracking", async () => {
    const snap = {
      ...SNAPSHOT,
      repos: [
        {
          ...SNAPSHOT.repos[0],
          branches: [
            {
              name: "main",
              class: "default",
              eligible: false,
              ageDays: 1,
              upstream: "origin/main",
            },
            { name: "feat/local-only", class: "active", eligible: false, ageDays: 2 },
          ],
        },
      ],
    };
    const setup = await testRender(h(App, { options: {}, initialSnapshot: snap }), {
      width: 120,
      height: 30,
    });
    await setup.renderOnce();
    const lines = setup.captureCharFrame().split("\n");
    // branch names truncate at branchNameW (the deleted pane is always present)
    expect(lines.find((l) => l.includes("main"))).toContain("cloud");
    expect(lines.find((l) => l.includes("feat/local-o"))).toContain("local");
    setup.renderer.destroy();
  });

  test("skipped entries are listed inline, not hidden behind a count", async () => {
    const setup = await testRender(h(App, { options: {}, initialSnapshot: SNAPSHOT }), {
      width: 100,
      height: 30,
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("+ /x/bare.git (bare)");
    setup.renderer.destroy();
  });

  test("help overlay opens and closes", async () => {
    const setup = await testRender(h(App, { options: {}, initialSnapshot: SNAPSHOT }), {
      width: 100,
      height: 30,
    });
    await setup.renderOnce();
    await press(setup, "?");
    const helpFrame = setup.captureCharFrame();
    expect(helpFrame).toContain("git-reap help");
    expect(helpFrame).toContain("navigation");
    expect(helpFrame).toContain("switch pane");
    expect(helpFrame).toContain("select all in repo");
    expect(helpFrame).toContain("search repos");
    expect(helpFrame).toContain("resize panes");
    expect(helpFrame).toContain("branch classes");
    expect(helpFrame).toContain("squash");
    expect(helpFrame).toContain("cloud = tracked on remote · local = local-only");
    expect(helpFrame).toContain("skipped repos (bare · unreadable · boundary)");
    expect(helpFrame).toContain("undo last batch");
    expect(helpFrame).toContain("local-only: remote branches are never touched");
    expect(helpFrame).toContain("undo restores deleted branches for 90 days");
    await press(setup, "x"); // help closes on any key
    expect(setup.captureCharFrame()).not.toContain("git-reap help");
    setup.renderer.destroy();
  });

  test("space selects only eligible branches; enter opens the deletion plan", async () => {
    const setup = await testRender(h(App, { options: {}, initialSnapshot: SNAPSHOT }), {
      width: 100,
      height: 30,
    });
    await setup.renderOnce();
    await press(setup, KeyCodes.TAB); // focus branches
    await press(setup, KeyCodes.ARROW_DOWN); // move to feat/old-pr (gone, eligible)
    await press(setup, " ");
    expect(setup.captureCharFrame()).toContain("1 selected");
    await press(setup, KeyCodes.RETURN);
    const plan = setup.captureCharFrame();
    expect(plan).toContain("Deletion plan");
    // keys are repo-path qualified, never "[object Object]" (regression: toggle
    // used to key on the repo object, so the plan showed [object Object]::branch)
    expect(plan).toContain("feat/old-pr");
    expect(plan).not.toContain("[object Object]");
    expect(plan).toContain("enter to execute · esc to cancel");
    expect(plan).toContain("undo restores deleted branches for 90 days");
    expect(plan).toContain("local-only: remote branches are never touched");
    // centered: the "Deletion plan" title line starts well right of col 0
    // (width 100, box 72 → left 14; col 0 would mean the old left=4/not centered)
    const planLine = plan.split("\n").find((l) => l.includes("Deletion plan"));
    const titleCol = planLine?.indexOf("Deletion plan") ?? -1;
    expect(titleCol).toBeGreaterThanOrEqual(14);
    setup.renderer.destroy();
  });

  test("u key shows undo note (no committed batch)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "reap-tui-"));
    const setup = await testRender(h(App, { options: { dataDir }, initialSnapshot: SNAPSHOT }), {
      width: 100,
      height: 30,
    });
    await setup.renderOnce();
    await press(setup, "u");
    await setup.waitFor(() => setup.captureCharFrame().includes("nothing to undo"));
    expect(setup.captureCharFrame()).toContain("nothing to undo");
    setup.renderer.destroy();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("deleted pane is always visible; empty state shows when nothing deleted", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "reap-tui-"));
    const setup = await testRender(h(App, { options: { dataDir }, initialSnapshot: SNAPSHOT }), {
      width: 100,
      height: 30,
    });
    await setup.renderOnce();
    // pane is always rendered (fixed layout, no jump): header with 0 count
    let frame = setup.captureCharFrame();
    expect(frame).toMatch(/ deleted 0/);
    expect(frame).toContain("nothing deleted yet");
    // d focuses the pane; empty state still shows
    await press(setup, "d");
    await setup.waitFor(() => setup.captureCharFrame().includes("nothing deleted yet"));
    frame = setup.captureCharFrame();
    expect(frame).toMatch(/ deleted 0/);
    setup.renderer.destroy();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("deleted pane shows the selected repo's countdown rows", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "reap-tui-"));
    const { beginBatch, undoRefFor } = await import("../src/ledger.js");
    // ledger identity = the repo's commonDir, exactly like a real scan
    const commonDir = "/home/u/projects/alpha/.git";
    // write a fake committed batch straight into the ledger
    const batch = await beginBatch(dataDir, commonDir, { batchId: "deleted-b1" });
    batch.entry("feat/dead", "abc1234", undoRefFor("deleted-b1", "feat/dead"));
    batch.result("feat/dead", "deleted");
    batch.commit();
    const setup = await testRender(h(App, { options: { dataDir }, initialSnapshot: SNAPSHOT }), {
      width: 100,
      height: 30,
    });
    await setup.renderOnce();
    // d refreshes the ledger and focuses the pane (act-wrapped, like the u test)
    await press(setup, "d");
    await setup.waitFor(() => / deleted 1/.test(setup.captureCharFrame()));
    const frame = setup.captureCharFrame();
    expect(frame).toMatch(/ deleted 1/); // pane header counts the selected repo's rows
    expect(frame).toContain("feat/dead");
    expect(frame).toContain("90d"); // countdown marker on the row
    setup.renderer.destroy();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("deleted pane only shows the selected repo's rows, not other repos'", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "reap-tui-"));
    const { beginBatch, undoRefFor } = await import("../src/ledger.js");
    // batch for a DIFFERENT repo (beta) — must not appear for alpha
    const other = await beginBatch(dataDir, "/home/u/projects/beta/.git", {
      batchId: "deleted-b2",
    });
    other.entry("feat/beta-only", "deadbeef", undoRefFor("deleted-b2", "feat/beta-only"));
    other.result("feat/beta-only", "deleted");
    other.commit();
    const setup = await testRender(h(App, { options: { dataDir }, initialSnapshot: SNAPSHOT }), {
      width: 100,
      height: 30,
    });
    await setup.renderOnce();
    await press(setup, "d");
    await setup.waitFor(() => / deleted 0/.test(setup.captureCharFrame()));
    const frame = setup.captureCharFrame();
    expect(frame).toMatch(/ deleted 0/); // selected repo (alpha) has nothing
    expect(frame).toContain("nothing deleted yet");
    expect(frame).not.toContain("beta-only");
    setup.renderer.destroy();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("intro screen shows first when showIntro, then any key starts the app", async () => {
    const setup = await testRender(
      h(App, { options: { showIntro: true }, initialSnapshot: SNAPSHOT }),
      { width: 100, height: 30 },
    );
    await setup.renderOnce();
    const intro = setup.captureCharFrame();
    expect(intro).toContain("git-reap");
    expect(intro).toContain("dead branches, swept safely across all your repos");
    expect(intro).toContain("what it does");
    expect(intro).toContain("why it is safe");
    expect(intro).toContain("press any key to start");
    expect(intro).not.toContain("repos / search"); // main screen not shown yet

    await press(setup, "x"); // any key starts
    expect(setup.captureCharFrame()).toContain("branches:"); // main screen
    setup.renderer.destroy();
  });

  test("intro is skipped when showIntro is not set", async () => {
    const setup = await testRender(h(App, { options: {}, initialSnapshot: SNAPSHOT }), {
      width: 100,
      height: 30,
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("branches:");
    expect(setup.captureCharFrame()).not.toContain("why it is safe");
    setup.renderer.destroy();
  });

  test("space on an ineligible branch shows why it is blocked", async () => {
    const setup = await testRender(h(App, { options: {}, initialSnapshot: SNAPSHOT }), {
      width: 100,
      height: 30,
    });
    await setup.renderOnce();
    await press(setup, KeyCodes.TAB); // focus branches
    await press(setup, KeyCodes.ARROW_DOWN); // feat/old-pr (eligible)
    await press(setup, KeyCodes.ARROW_DOWN); // fix/wip (active, blocked)
    await press(setup, " ");
    const frame = setup.captureCharFrame();
    expect(frame).toContain("active branch");
    expect(frame).not.toContain("1 selected"); // nothing selected

    // moving clears the note
    await press(setup, KeyCodes.ARROW_UP);
    expect(setup.captureCharFrame()).not.toContain("active branch");
    setup.renderer.destroy();
  });

  test("[ and ] resize the repos pane (clamped)", async () => {
    const setup = await testRender(h(App, { options: {}, initialSnapshot: SNAPSHOT }), {
      width: 100,
      height: 30,
    });
    await setup.renderOnce();
    expect(dividerCol(setup.captureCharFrame())).toBe(36);
    await press(setup, "]");
    await press(setup, "]");
    expect(dividerCol(setup.captureCharFrame())).toBe(44);
    await press(setup, "[");
    await press(setup, "[");
    await press(setup, "[");
    expect(dividerCol(setup.captureCharFrame())).toBe(32);
    for (let i = 0; i < 30; i++) await press(setup, "["); // clamp at min 18
    expect(dividerCol(setup.captureCharFrame())).toBe(18);
    for (let i = 0; i < 60; i++) await press(setup, "]"); // clamp at width-34=66
    expect(dividerCol(setup.captureCharFrame())).toBe(66);
    setup.renderer.destroy();
  });

  test("mouse drag on the ║ divider resizes panes", async () => {
    const setup = await testRender(h(App, { options: {}, initialSnapshot: SNAPSHOT }), {
      width: 100,
      height: 30,
    });
    await setup.renderOnce();
    expect(dividerCol(setup.captureCharFrame())).toBe(36);
    const y = 6; // a body row
    await act(async () => {
      await setup.mockMouse.emitMouseEvent("down", 36, y);
    });
    await setup.renderOnce();
    for (let x = 38; x <= 50; x += 2) {
      await act(async () => {
        await setup.mockMouse.emitMouseEvent("drag", x, y);
      });
      await setup.renderOnce();
    }
    await act(async () => {
      await setup.mockMouse.emitMouseEvent("up", 50, y);
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(dividerCol(frame)).toBe(50);
    expect(frame).toContain("║"); // divider still visible after drag
    setup.renderer.destroy();
  });
});
