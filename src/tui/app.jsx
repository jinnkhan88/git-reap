// git-reap TUI: viewer/selector over scan
// snapshots. Selection → confirm → execute through the safety engine;
// `u` undoes the last batch, `d` browses recently deleted.

import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { kindIcon } from "../kind.js";
import { defaultDataDir } from "../ledger.js";
import { scan } from "../scan.js";
import { BranchArt, Intro } from "./intro.jsx";
import { CLASS_STYLE, EVIDENCE_FG, THEME } from "./theme.js";

function shortPath(p, max = 30) {
  const home = process.env.HOME ?? "";
  const s = home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  return s.length > max ? `…${s.slice(-(max - 1))}` : s;
}

// full path (never truncated) for the branches pane header; ~ stands in for home
function fullPath(p) {
  const home = process.env.HOME ?? "";
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

// Why a branch can't be selected — shown when space is pressed on it
function blockReason(b) {
  switch (b.class) {
    case "default":
      return "default branch: protected";
    case "protected":
      return "protected by pattern";
    case "gone":
      return "gone (unproven): needs proof its commits are disposable (§3.2)";
    case "stale":
      return "stale is advisory: disposability unproven";
    case "active":
      return "active branch";
    case "patch-equivalent":
      return "patch-equivalent is advisory";
    case "closed-unmerged":
      return "PR closed, not merged";
    default:
      return `not eligible (${b.class})`;
  }
}

function visibleWindow(items, cursor, maxRows) {
  if (items.length <= maxRows) return { rows: items, offset: 0 };
  const start = Math.max(0, Math.min(cursor - Math.floor(maxRows / 2), items.length - maxRows));
  return { rows: items.slice(start, start + maxRows), offset: start };
}

export function App({ options, initialSnapshot = null, onReady, renderer = null }) {
  const [introDone, setIntroDone] = useState(!options.showIntro);
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [scanning, setScanning] = useState(!initialSnapshot);
  const [scanNote, setScanNote] = useState("");
  const [pane, setPane] = useState("repos"); // repos | branches | deleted
  const [repoIdx, setRepoIdx] = useState(0);
  const [branchIdx, setBranchIdx] = useState(0);
  const [checked, setChecked] = useState(() => new Set());
  const [mode, setMode] = useState("normal"); // normal | filter | help | confirm | results | deleted
  const [executing, setExecuting] = useState(false);
  const [execResults, setExecResults] = useState(null); // { batchId, perRepo: [{path, results}] }
  const [undoNote, setUndoNote] = useState(null);
  const [filter, setFilter] = useState("");
  const [blockNote, setBlockNote] = useState(null); // transient "why blocked" hint
  const [reposWidth, setReposWidth] = useState(36);
  const [resizing, setResizing] = useState(false);
  const { width, height } = useTerminalDimensions();
  const ctxRenderer = useRenderer();
  const r = renderer ?? ctxRenderer;

  // Graceful quit: destroy() is what disables terminal mouse tracking and
  // restores the alternate screen. process.exit() alone skips it and leaks
  // raw mouse escape sequences onto the console after exit.
  const quit = () => {
    try {
      r?.destroy();
    } catch {
      // destroy may already have run; the exit guard in tui/index.js covers us
    }
    process.exit(0);
  };

  // repos pane keeps >= 18 cols; branches pane always keeps >= 34
  const clampPane = (w) => Math.max(18, Math.min(Math.max(28, (width ?? 100) - 34), w));

  // The divider is 1 col wide, so a drag leaves it on the first move; the
  // renderer then captures whichever pane the pointer drifts onto. We track
  // whether the drag STARTED on the divider and forward drag events from the
  // panes too, so the resize follows the pointer no matter what it's over.
  const dragStartedOnDivider = useRef(false);
  const startPaneDrag = (e) => {
    dragStartedOnDivider.current = false;
  };
  const startDividerDrag = (e) => {
    dragStartedOnDivider.current = true;
    e.preventDefault();
    setResizing(true);
  };
  const dragPane = (e) => {
    if (dragStartedOnDivider.current) setReposWidth(clampPane(e.x));
  };
  const endPaneDrag = () => {
    dragStartedOnDivider.current = false;
    setResizing(false);
  };

  // Re-scan from disk; keeps the stats line and branches pane in sync after
  // execute/undo/restore mutate the working trees.
  const runScan = useCallback(async () => {
    setScanning(true);
    setScanNote("scanning…");
    try {
      const result = await scan({ ...options, onRepo: (p) => setScanNote(shortPath(p)) });
      setSnapshot(result);
    } catch (err) {
      setScanNote(`scan failed: ${err.message}`);
    }
    setScanning(false);
  }, [options]);

  // Recently-deleted section: a third pane listing restorable branches with
  // a per-branch 90-day countdown; enter/r restores the selected row. The
  // pane auto-hides when the list is empty (nothing to restore).
  const [deleted, setDeleted] = useState([]); // listDeleted() rows
  const [deletedIdx, setDeletedIdx] = useState(0);
  const [deletedNote, setDeletedNote] = useState(null);

  const refreshDeleted = useCallback(async () => {
    try {
      const { listDeleted } = await import("../ledger.js");
      const dataDir = options.dataDir ?? defaultDataDir();
      const rows = listDeleted(dataDir);
      setDeleted(rows);
      setDeletedIdx((i) => Math.min(i, Math.max(0, rows.length - 1)));
      return rows;
    } catch (err) {
      setDeletedNote(`deleted list failed: ${err.message}`);
      return [];
    }
  }, [options]);

  const openDeleted = useCallback(async () => {
    setDeletedNote(null);
    await refreshDeleted();
    setPane("deleted"); // pane is always visible; empty state shows inside
  }, [refreshDeleted]);

  const restoreOne = useCallback(
    async (row) => {
      setDeletedNote(null);
      try {
        const { restoreBatch } = await import("../ledger.js");
        const results = await restoreBatch(row.repoPath, {
          batchId: row.batchId,
          repoCommonDir: row.repoPath,
          entries: [{ branch: row.branch, sha: row.sha, undoRef: row.undoRef }],
        });
        const restored = results.filter(
          (r) => r.status === "restored" || r.status === "already",
        ).length;
        setDeletedNote(`restored ${row.branch} (${restored}/${results.length})`);
        // restored branches leave the list; the pane stays put (no layout jump)
        await refreshDeleted();
        await runScan(); // stats line + branches pane reflect the restored branch
      } catch (err) {
        setDeletedNote(`restore failed: ${err.message}`);
      }
    },
    [refreshDeleted, runScan],
  );

  // execute the checked plan through the race-safe safety engine.
  const runPlan = useCallback(async () => {
    setExecuting(true);
    setExecResults(null);
    try {
      const { executePlan } = await import("../execute.js");
      const byPath = new Map();
      for (const k of checked) {
        const [path, name] = k.split("::");
        if (!byPath.has(path)) byPath.set(path, []);
        byPath.get(path).push(name);
      }
      const perRepo = [];
      for (const repo of snapshot?.repos ?? []) {
        const names = byPath.get(repo.path);
        if (!names?.length) continue;
        // pass the FULL reviewed branch objects (sha + evidence) — the safety
        // engine revalidates the tip against the reviewed SHA
        const branches = (repo.branches ?? []).filter((b) => names.includes(b.name));
        const { batchId, results } = await executePlan(repo.path, repo.commonDir, branches, {
          dataDir: options.dataDir,
          defaultRef: repo.defaultRef,
          protectedPatterns: options.protected ?? [],
        });
        perRepo.push({ path: repo.path, batchId, results });
      }
      setExecResults({ perRepo });
      setMode("results");
      setChecked(new Set());
      await refreshDeleted(); // deleted branches now appear in the pane
      await runScan(); // stats line + branches pane reflect the deletions
    } catch (err) {
      setExecResults({ error: err.message });
      setMode("results");
    }
    setExecuting(false);
  }, [checked, snapshot, options, refreshDeleted, runScan]);

  // `u` undoes the last committed batch from the ledger.
  const undoLast = useCallback(async () => {
    setUndoNote(null);
    try {
      const { lastBatch, restoreBatch } = await import("../ledger.js");
      const dataDir = options.dataDir ?? defaultDataDir();
      const batch = lastBatch(dataDir);
      if (!batch) {
        setUndoNote("nothing to undo: no committed batch");
        return;
      }
      const results = await restoreBatch(batch.repoCommonDir, batch);
      const restored = results.filter(
        (r) => r.status === "restored" || r.status === "already",
      ).length;
      setUndoNote(`undo: restored ${restored}/${results.length} from batch ${batch.batchId}`);
      await refreshDeleted(); // restored branches leave the pane
      await runScan(); // stats line + branches pane reflect the restored branch
    } catch (err) {
      setUndoNote(`undo failed: ${err.message}`);
    }
  }, [options, refreshDeleted, runScan]);

  useEffect(() => {
    if (!initialSnapshot) runScan();
    refreshDeleted(); // populate the deleted pane on launch
  }, [runScan, refreshDeleted, initialSnapshot]);

  const repos = useMemo(() => {
    const all = snapshot?.repos ?? [];
    if (!filter) return all;
    const f = filter.toLowerCase();
    return all.filter(
      (r) =>
        r.path.toLowerCase().includes(f) ||
        r.branches.some((b) => b.name.toLowerCase().includes(f)),
    );
  }, [snapshot, filter]);

  const repo = repos[Math.min(repoIdx, Math.max(0, repos.length - 1))];
  const branches = repo?.branches ?? [];
  // the deleted pane follows the selected repo, like the branches pane
  const repoDeleted = deleted.filter((row) => row.repoPath === repo?.commonDir);
  const candidates = (snapshot?.repos ?? []).reduce(
    (n, r) => n + r.branches.filter((b) => b.eligible).length,
    0,
  );
  const key = (r, b) => `${r}::${b}`;

  const toggle = (r, b) => {
    if (!b.eligible) return;
    setChecked((prev) => {
      const next = new Set(prev);
      const k = key(r.path, b.name);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const toggleAllInRepo = (r) => {
    const eligible = r.branches.filter((b) => b.eligible);
    setChecked((prev) => {
      const next = new Set(prev);
      const allOn = eligible.every((b) => next.has(key(r.path, b.name)));
      for (const b of eligible) {
        if (allOn) next.delete(key(r.path, b.name));
        else next.add(key(r.path, b.name));
      }
      return next;
    });
  };

  useKeyboard((e) => {
    if (mode === "deleted") {
      if (e.name === "escape" || e.name === "n") setMode("normal");
      return;
    }
    if (mode === "help") {
      setMode("normal");
      return;
    }
    if (mode === "confirm") {
      if (e.name === "escape" || e.name === "n") setMode("normal");
      else if (e.name === "return" && !executing) runPlan(); // real, guarded execution
      return;
    }
    if (mode === "results") {
      if (e.name === "escape" || e.name === "n" || e.name === "return") setMode("normal");
      return;
    }
    if (mode === "filter") {
      if (e.name === "escape" || e.name === "return") setMode("normal");
      else if (e.name === "backspace") setFilter((f) => f.slice(0, -1));
      else if (e.name?.length === 1 && !e.ctrl && !e.meta) setFilter((f) => f + e.name);
      return;
    }
    switch (e.name) {
      case "q":
        quit();
        break;
      case "tab":
        setPane((p) => {
          if (p === "repos") return "branches";
          if (p === "branches") return "deleted";
          return "repos";
        });
        setBlockNote(null);
        break;
      case "up":
      case "k":
        if (pane === "repos") {
          setRepoIdx((i) => Math.max(0, i - 1));
          setBranchIdx(0);
          setDeletedIdx(0);
        } else if (pane === "deleted") setDeletedIdx((i) => Math.max(0, i - 1));
        else setBranchIdx((i) => Math.max(0, i - 1));
        setBlockNote(null);
        break;
      case "down":
      case "j":
        if (pane === "repos") {
          setRepoIdx((i) => Math.min(repos.length - 1, i + 1));
          setBranchIdx(0);
          setDeletedIdx(0);
        } else if (pane === "deleted")
          setDeletedIdx((i) => Math.min(repoDeleted.length - 1, i + 1));
        else setBranchIdx((i) => Math.min(branches.length - 1, i + 1));
        setBlockNote(null);
        break;
      case "space":
        if (pane === "branches" && branches[branchIdx]) {
          const b = branches[branchIdx];
          if (b.eligible) {
            toggle(repo, b);
            setBlockNote(null);
          } else {
            setBlockNote(blockReason(b)); // explain why it can't be selected
          }
        }
        break;
      case "a":
        if (pane === "repos" && repo) {
          toggleAllInRepo(repo);
          setBlockNote(null);
        }
        break;
      case "r":
        if (pane === "deleted" && repoDeleted[deletedIdx]) {
          restoreOne(repoDeleted[deletedIdx]);
        } else {
          setChecked(new Set());
          runScan();
        }
        break;
      case "return":
        if (pane === "deleted" && repoDeleted[deletedIdx]) restoreOne(repoDeleted[deletedIdx]);
        else if (checked.size > 0) setMode("confirm");
        break;
      case "/":
        setMode("filter");
        break;
      case "?":
        setMode("help");
        break;
      case "[":
        setReposWidth((w) => clampPane(w - 4));
        break;
      case "]":
        setReposWidth((w) => clampPane(w + 4));
        break;
      case "u":
        undoLast();
        break;
      case "d":
        openDeleted();
        break;
    }
  });

  useEffect(() => {
    onReady?.();
  }, [onReady]);

  const skippedAll = snapshot?.skipped ?? [];
  const skipRows = skippedAll.slice(0, 3);
  const skipRowCount = skipRows.length + (skippedAll.length > 3 ? 1 : 0);
  // header is 3 rows now (animation line + title + stats line) → -9
  const bodyRows = Math.max(3, (height ?? 24) - 9 - skipRowCount - (blockNote ? 1 : 0));
  // centered overlay geometry: help is fixed-height, confirm grows with items
  const helpW = Math.min(68, Math.max(40, (width ?? 100) - 8));
  const helpLeft = Math.max(2, Math.floor(((width ?? 100) - helpW) / 2));
  const helpTop = Math.max(1, Math.floor(((height ?? 24) - 22) / 2));
  const confirmW = Math.min(72, Math.max(50, (width ?? 100) - 10));
  // content rows = 1 title + N items + 1 blank + 3 notes + 1 esc = N + 6;
  // + border(2) + padding(2) → N + 10. Never below 11 (one item).
  const confirmH = Math.max(
    11,
    Math.min((height ?? 24) - 4, 10 + Math.min(checked.size, bodyRows - 6)),
  );
  const confirmLeft = Math.max(2, Math.floor(((width ?? 100) - confirmW) / 2));
  const confirmTop = Math.max(1, Math.floor(((height ?? 24) - confirmH) / 2));
  // branches pane inner width; the branch-name column flexes with it so rows
  // (sel 5 + name + class 10 + age 6 + src 5 + " via PR" 7 = 34 fixed) never wrap.
  // The deleted pane is always present (fixed layout, no jumping), so it and
  // its divider are subtracted here too.
  const deletedPaneW = Math.max(38, Math.min(46, Math.floor((width ?? 100) / 5)));
  const branchInner = (width ?? 100) - clampPane(reposWidth) - 3 - deletedPaneW - 1;
  const branchNameW = Math.max(12, branchInner - 34);
  const repoWin = visibleWindow(repos, repoIdx, bodyRows);
  const branchWin = visibleWindow(branches, branchIdx, bodyRows);

  if (!introDone) {
    return (
      <Intro dataDir={options.dataDir ?? defaultDataDir()} onStart={() => setIntroDone(true)} />
    );
  }

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box width="100%" alignItems="center" flexDirection="column">
        <text>
          <BranchArt />
        </text>
        <text>
          <span fg={THEME.accent} attributes={1}>
            git-reap
          </span>
        </text>
        <text fg={THEME.dim}>
          {snapshot ? `${snapshot.repos.length} repos` : "…"} · {candidates} candidates ·{" "}
          {checked.size} selected
          {snapshot ? (snapshot.fetched ? " · refs refreshed" : " · refs not refreshed") : ""}
          {scanning ? ` · ${scanNote}` : ""}
        </text>
      </box>
      <box flexDirection="row" flexGrow={1}>
        <box
          width={clampPane(reposWidth)}
          border
          borderStyle="rounded"
          borderColor={pane === "repos" ? THEME.accent : THEME.line}
          flexDirection="column"
          onMouseDown={startPaneDrag}
          onMouseDrag={dragPane}
          onMouseUp={endPaneDrag}
          onMouseDragEnd={endPaneDrag}
        >
          <text
            fg={pane === "repos" ? THEME.accent : THEME.dim}
            attributes={pane === "repos" ? 1 : undefined}
          >
            <span> repos</span>
            <span fg={THEME.dim} attributes={0}>
              {mode === "filter" ? `  /${filter}▍` : filter ? `  /${filter}` : "  / search"}
            </span>
          </text>
          {repoWin.rows.map((r, i) => {
            const idx = repoWin.offset + i;
            const n = r.branches.filter((b) => b.eligible).length;
            const active = pane === "repos" && idx === repoIdx;
            // marker(1) + icon(2) + spaces(2) + count(~2) + no-default badge(11)
            const badgeCols = r.status === "no-default" ? 11 : 0;
            const pathMax = Math.max(8, clampPane(reposWidth) - 8 - badgeCols);
            return (
              <text key={r.path} bg={active ? THEME.select : undefined}>
                <span fg={n > 0 ? THEME.text : THEME.dim} attributes={active ? 1 : undefined}>
                  {active ? "▸" : " "}
                  {kindIcon(r.kind)} {shortPath(r.path, pathMax)}
                </span>
                <span fg={n > 0 ? THEME.accent : THEME.dim}> {n > 0 ? n : ""}</span>
                {r.status === "no-default" && <span fg={THEME.danger}> no-default</span>}
              </text>
            );
          })}
          {skipRows.map((s) => (
            <text key={s.path} fg={THEME.dim}>
              {" "}
              + {shortPath(s.path, Math.max(8, clampPane(reposWidth) - 9 - s.reason.length))} (
              {s.reason})
            </text>
          ))}
          {skippedAll.length > 3 && (
            <text fg={THEME.dim}> +{skippedAll.length - 3} more skipped</text>
          )}
        </box>
        <box
          width={1}
          alignItems="center"
          justifyContent="center"
          bg={resizing ? THEME.surface : undefined}
          onMouseDown={startDividerDrag}
          onMouseDrag={dragPane}
          onMouseUp={endPaneDrag}
          onMouseDragEnd={endPaneDrag}
        >
          <text fg={resizing ? THEME.accent : THEME.dim} attributes={resizing ? 1 : undefined}>
            ║
          </text>
        </box>
        <box
          flexGrow={1}
          border
          borderStyle="rounded"
          borderColor={pane === "branches" ? THEME.accent : THEME.line}
          flexDirection="column"
          onMouseDown={startPaneDrag}
          onMouseDrag={dragPane}
          onMouseUp={endPaneDrag}
          onMouseDragEnd={endPaneDrag}
        >
          <text
            fg={pane === "branches" ? THEME.accent : THEME.dim}
            attributes={pane === "branches" ? 1 : undefined}
          >
            <span> branches</span>
            <span fg={THEME.dim} attributes={0}>
              {repo ? `: ${fullPath(repo.path)}` : ""}
            </span>
          </text>
          {repo && (
            <text fg={THEME.sub} attributes={1}>
              {" sel "}
              {"branch".padEnd(branchNameW + 1)}
              {"class".padEnd(10)}
              {" age  "}
              {"src"}
            </text>
          )}
          {branchWin.rows.map((b, i) => {
            const idx = branchWin.offset + i;
            const style = CLASS_STYLE[b.class] ?? { fg: THEME.text, label: b.class };
            const active = pane === "branches" && idx === branchIdx;
            const isChecked = repo && checked.has(key(repo.path, b.name));
            return (
              <text key={b.name} bg={active ? THEME.select : undefined}>
                <span fg={b.eligible ? THEME.accent : THEME.dim}>
                  {`${active ? "▸" : " "}${isChecked ? "[x]" : "[ ]"} `}
                </span>
                <span fg={THEME.text} attributes={active ? 1 : undefined}>
                  {b.name.padEnd(branchNameW).slice(0, branchNameW)}{" "}
                </span>
                <span fg={style.fg}>{style.label.padEnd(10)}</span>
                <span fg={THEME.dim}> {`${b.ageDays}d`.padEnd(5)}</span>
                <span fg={b.upstream ? EVIDENCE_FG : THEME.dim}>
                  {b.upstream ? "cloud" : "local"}
                </span>
                {b.evidence?.kind === "host" && <span fg={EVIDENCE_FG}> via PR</span>}
              </text>
            );
          })}
          {!repo && <text fg={THEME.dim}> (no repos found)</text>}
        </box>
        <box
          width={1}
          alignItems="center"
          justifyContent="center"
          bg={resizing ? THEME.surface : undefined}
          onMouseDown={startDividerDrag}
          onMouseDrag={dragPane}
          onMouseUp={endPaneDrag}
          onMouseDragEnd={endPaneDrag}
        >
          <text fg={resizing ? THEME.accent : THEME.dim} attributes={resizing ? 1 : undefined}>
            ║
          </text>
        </box>
        <box
          width={deletedPaneW}
          border
          borderStyle="rounded"
          borderColor={pane === "deleted" ? THEME.accent : THEME.line}
          flexDirection="column"
          onMouseDown={startPaneDrag}
          onMouseDrag={dragPane}
          onMouseUp={endPaneDrag}
          onMouseDragEnd={endPaneDrag}
        >
          <text
            fg={pane === "deleted" ? THEME.accent : THEME.dim}
            attributes={pane === "deleted" ? 1 : undefined}
          >
            <span> deleted</span>
            <span fg={THEME.dim} attributes={0}>
              {" "}
              {repoDeleted.length}
            </span>
          </text>
          {repoDeleted.length === 0 && <text fg={THEME.dim}> nothing deleted yet</text>}
          {repoDeleted.slice(0, bodyRows - 2).map((row, i) => (
            <text
              key={`${row.batchId}::${row.branch}`}
              bg={pane === "deleted" && i === deletedIdx ? THEME.select : undefined}
            >
              <span fg={pane === "deleted" && i === deletedIdx ? THEME.accent : THEME.dim}>
                {pane === "deleted" && i === deletedIdx ? "▸" : " "}
              </span>{" "}
              <span fg={row.restorable ? THEME.text : THEME.dim}>{row.branch.slice(0, 18)}</span>
              <span fg={row.restorable ? THEME.warn : THEME.dim}>
                {" "}
                {row.restorable ? `${row.daysLeft}d` : "expired"}
              </span>
            </text>
          ))}
          {repoDeleted.length > bodyRows - 2 && (
            <text fg={THEME.dim}> +{repoDeleted.length - (bodyRows - 2)} more</text>
          )}
          {repoDeleted.length > 0 && <text fg={THEME.dim}> enter/r restore</text>}
        </box>
      </box>
      {undoNote && (
        <box paddingLeft={1}>
          <text fg={THEME.accent} attributes={1} bg={THEME.surface}>
            {` ✓ ${undoNote}`.padEnd(Math.max(0, (width ?? 100) - 1))}
          </text>
        </box>
      )}
      {deletedNote && !undoNote && (
        <box paddingLeft={1}>
          <text fg={THEME.warn} attributes={1} bg={THEME.surface}>
            {` ${deletedNote}`.padEnd(Math.max(0, (width ?? 100) - 1))}
          </text>
        </box>
      )}
      {blockNote && (
        <box paddingLeft={1}>
          <text fg={THEME.warn} attributes={1} bg={THEME.surface}>
            {` ⚠ ${blockNote}`.padEnd(Math.max(0, (width ?? 100) - 1))}
          </text>
        </box>
      )}
      <box paddingLeft={1}>
        <text fg={THEME.dim}>
          {
            " q quit · tab pane · ↑↓ move · space select · a all-in-repo · enter plan · u undo · d deleted · r rescan · / search · ? help · ║ drag or [ ] resize"
          }
        </text>
      </box>
      {mode === "help" && (
        <box
          position="absolute"
          left={helpLeft}
          top={helpTop}
          width={helpW}
          border
          borderStyle="rounded"
          borderColor={THEME.line}
          backgroundColor={THEME.base}
          flexDirection="column"
          padding={1}
        >
          <text fg={THEME.accent} attributes={1}>
            git-reap help
          </text>
          <text> </text>
          <box flexDirection="row">
            <box flexDirection="column" width={34}>
              <text fg={THEME.sub} attributes={1}>
                navigation
              </text>
              <text>
                <span fg={THEME.accent}>{"tab".padEnd(10)}</span>
                <span fg={THEME.text}>switch pane</span>
              </text>
              <text>
                <span fg={THEME.accent}>{"↑↓ / j k".padEnd(10)}</span>
                <span fg={THEME.text}>move cursor</span>
              </text>
              <text> </text>
              <text fg={THEME.sub} attributes={1}>
                selection
              </text>
              <text>
                <span fg={THEME.accent}>{"space".padEnd(10)}</span>
                <span fg={THEME.text}>toggle branch</span>
              </text>
              <text>
                <span fg={THEME.accent}>{"a".padEnd(10)}</span>
                <span fg={THEME.text}>select all in repo</span>
              </text>
              <text>
                <span fg={THEME.accent}>{"enter".padEnd(10)}</span>
                <span fg={THEME.text}>deletion plan → execute</span>
              </text>
            </box>
            <box flexDirection="column" width={30}>
              <text fg={THEME.sub} attributes={1}>
                actions
              </text>
              <text>
                <span fg={THEME.accent}>{"/".padEnd(10)}</span>
                <span fg={THEME.text}>search repos</span>
              </text>
              <text>
                <span fg={THEME.accent}>{"r".padEnd(10)}</span>
                <span fg={THEME.text}>rescan</span>
              </text>
              <text>
                <span fg={THEME.accent}>{"u".padEnd(10)}</span>
                <span fg={THEME.text}>undo last batch</span>
              </text>
              <text>
                <span fg={THEME.accent}>{"d".padEnd(10)}</span>
                <span fg={THEME.text}>recently deleted (restore)</span>
              </text>
              <text>
                <span fg={THEME.accent}>{"?".padEnd(10)}</span>
                <span fg={THEME.text}>this help</span>
              </text>
              <text>
                <span fg={THEME.accent}>{"[ ] ║".padEnd(10)}</span>
                <span fg={THEME.text}>resize panes</span>
              </text>
              <text>
                <span fg={THEME.accent}>{"q".padEnd(10)}</span>
                <span fg={THEME.text}>quit</span>
              </text>
            </box>
          </box>
          <text fg={THEME.sub} attributes={1}>
            branch classes
          </text>
          <text>
            <span fg={CLASS_STYLE.gone.fg}>gone</span>
            <span fg={THEME.dim}> · </span>
            <span fg={CLASS_STYLE.stale.fg}>stale</span>
            <span fg={THEME.dim}> · </span>
            <span fg={CLASS_STYLE.active.fg}>active</span>
            <span fg={THEME.dim}> · </span>
            <span fg={CLASS_STYLE.merged.fg}>merged</span>
            <span fg={THEME.dim}> · </span>
            <span fg={CLASS_STYLE["squash-merged"].fg}>squash</span>
          </text>
          <text>
            <span fg={CLASS_STYLE.protected.fg}>protected</span>
            <span fg={THEME.dim}> · </span>
            <span fg={CLASS_STYLE.default.fg}>default</span>
            <span fg={THEME.dim}> · </span>
            <span fg={CLASS_STYLE["patch-equivalent"].fg}>patch≡</span>
          </text>
          <text fg={THEME.sub} attributes={1}>
            notes
          </text>
          <text>
            <span fg={THEME.accent}>[x]</span>
            <span fg={THEME.text}> only eligible branches can be selected</span>
          </text>
          <text>
            <span fg={THEME.accent}>src</span>
            <span fg={THEME.text}> cloud = tracked on remote · local = local-only</span>
          </text>
          <text>
            <span fg={THEME.accent}>+path</span>
            <span fg={THEME.text}> skipped repos (bare · unreadable · boundary)</span>
          </text>
          <text> </text>
          <text fg={THEME.warn}>local-only: remote branches are never touched</text>
          <text fg={THEME.dim}>guards re-check every branch at delete time</text>
          <text fg={THEME.dim}>undo restores deleted branches for 90 days</text>
          <text fg={THEME.dim}>press any key to close</text>
        </box>
      )}
      {mode === "confirm" && (
        <box
          position="absolute"
          left={confirmLeft}
          top={confirmTop}
          width={confirmW}
          height={confirmH}
          border
          borderStyle="rounded"
          borderColor={THEME.line}
          backgroundColor={THEME.base}
          flexDirection="column"
          padding={1}
        >
          <text fg={THEME.warn} attributes={1}>
            {executing ? "Executing plan…" : "Deletion plan"}
          </text>
          {[...checked].slice(0, bodyRows - 6).map((k) => (
            <text key={k}> ✂ {k}</text>
          ))}
          {checked.size > bodyRows - 6 && (
            <text fg={THEME.dim}> …and {checked.size - (bodyRows - 6)} more</text>
          )}
          <text> </text>
          {executing ? (
            <text fg={THEME.warn}>guards re-check every branch before deleting…</text>
          ) : (
            <text fg={THEME.warn} attributes={1}>
              enter to execute · esc to cancel
            </text>
          )}
          <text fg={THEME.dim}>undo restores deleted branches for 90 days</text>
          <text fg={THEME.dim}>local-only: remote branches are never touched</text>
        </box>
      )}
      {mode === "results" && (
        <box
          position="absolute"
          left={confirmLeft}
          top={confirmTop}
          width={confirmW}
          height={confirmH}
          border
          borderStyle="rounded"
          borderColor={THEME.line}
          backgroundColor={THEME.base}
          flexDirection="column"
          padding={1}
        >
          <text fg={THEME.accent} attributes={1}>
            Execution results
          </text>
          {execResults?.error ? (
            <text fg={THEME.danger}> ✗ {execResults.error}</text>
          ) : (
            (execResults?.perRepo ?? []).flatMap((r) =>
              r.results.map((o) => (
                <text key={`${r.path}::${o.branch}`}>
                  {" "}
                  <span fg={o.status === "deleted" ? THEME.accent : THEME.warn}>
                    {o.status === "deleted" ? "✓" : "⚠"}
                  </span>{" "}
                  <span fg={THEME.text}>{shortPath(r.path)}</span>
                  <span fg={THEME.dim}>::{o.branch}</span>
                  <span fg={o.status === "deleted" ? THEME.text : THEME.warn}>
                    {" "}
                    {o.status}
                    {o.reason ? ` (${o.reason})` : ""}
                  </span>
                </text>
              )),
            )
          )}
          <text> </text>
          <text fg={THEME.dim}>u undoes this batch · esc to close</text>
        </box>
      )}
    </box>
  );
}
