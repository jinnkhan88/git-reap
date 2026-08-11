#!/usr/bin/env bun
// git-reap CLI entry. Full command surface.

import { loadConfig } from "./config.js";
import { introSeen } from "./intro-state.js";
import { scan } from "./scan.js";

const USAGE = `git-reap: sweep dead local branches across all your repos

usage:
  git-reap                 interactive TUI (default)
  git-reap scan            non-interactive report (table or --json)
  git-reap run --yes       delete pre-selected candidates (guards apply)
  git-reap undo            restore last committed batch

flags:
  --root <path>            scan root (repeatable; overrides config)
  --repo <path>            single-repo mode
  --fetch                  fetch/prune before classifying (opt-in)
  --dry-run                print the plan, change nothing
  --stale-days <n>         stale threshold in days (default 30)
  --json                   machine-readable output
  --intro                  show the intro screen (seen once by default)
  --host                   check GitHub/GitLab PR state (opt-in; off by default)
  -h, --help               show this help
`;

export function parseArgs(argv) {
  const args = {
    command: "tui",
    roots: [],
    repo: null,
    fetch: false,
    dryRun: false,
    staleDays: null,
    json: false,
    intro: false,
    crossFilesystems: false,
    host: false,
    yes: false,
    help: false,
  };
  const rest = [...argv];
  while (rest.length) {
    const a = rest.shift();
    switch (a) {
      case "scan":
      case "run":
      case "undo":
        args.command = a;
        break;
      case "--root":
        args.roots.push(rest.shift());
        break;
      case "--repo":
        args.repo = rest.shift();
        break;
      case "--fetch":
        args.fetch = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--stale-days":
        args.staleDays = Number.parseInt(rest.shift(), 10);
        break;
      case "--json":
        args.json = true;
        break;
      case "--intro":
        args.intro = true;
        break;
      case "--cross-filesystems":
        args.crossFilesystems = true;
        break;
      case "--host":
        args.host = true;
        break;
      case "--no-host":
        args.host = false;
        break;
      case "--yes":
        args.yes = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`git-reap: ${err.message}\n`);
    console.error(USAGE);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.command === "scan") {
    const config = await loadConfig({ flags: args });
    const roots = resolveRoots(args, config);
    if (!args.repo && !roots.length) {
      console.error("git-reap: no roots configured. Pass --root <path> or set roots in config.");
      process.exit(2);
    }
    const result = await scan({
      roots,
      repo: args.repo,
      fetch: args.fetch || config.fetch,
      staleDays: config.staleDays,
      crossFilesystems: args.crossFilesystems,
      host: args.host,
      config,
    });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    printTable(result);
    return;
  }
  if (args.command === "run") {
    const config = await loadConfig({ flags: args });
    const roots = resolveRoots(args, config);
    if (!args.repo && !roots.length) {
      console.error("git-reap: no roots configured. Pass --root <path> or set roots in config.");
      process.exit(2);
    }
    if (!args.yes) {
      console.error("git-reap: 'run' deletes branches. Re-run with --yes to confirm.");
      process.exit(2);
    }
    const result = await scan({
      roots,
      repo: args.repo,
      fetch: args.fetch || config.fetch,
      staleDays: config.staleDays,
      crossFilesystems: args.crossFilesystems,
      host: args.host,
      config,
    });
    const { executePlan } = await import("./execute.js");
    const protectedPatterns = config.protected ?? [];
    const dataDir = config.dataDir;
    let totalDeleted = 0;
    let totalFailed = 0;
    for (const repo of result.repos) {
      if (repo.status !== "ok" && repo.status !== "no-default") continue;
      const eligible = (repo.branches ?? []).filter((b) => b.eligible);
      if (!eligible.length) continue;
      console.log(`\n${repo.path}  (default: ${repo.defaultBranch})`);
      const { batchId, results } = await executePlan(repo.path, repo.commonDir, eligible, {
        dataDir,
        defaultRef: repo.defaultRef,
        protectedPatterns,
      });
      for (const o of results) {
        const mark = o.status === "deleted" ? "x" : "!";
        console.log(`  [${mark}] ${o.branch}  ${o.status}${o.reason ? `  (${o.reason})` : ""}`);
        if (o.status === "deleted") totalDeleted++;
        else totalFailed++;
      }
      console.log(`  batch ${batchId}`);
    }
    console.log(
      `\n${totalDeleted} deleted, ${totalFailed} blocked/failed. Undo: git-reap undo (90-day retention)`,
    );
    return;
  }
  if (args.command === "undo") {
    const config = await loadConfig({ flags: args });
    const dataDir = config.dataDir;
    const { lastBatch, restoreBatch } = await import("./ledger.js");
    const batch = lastBatch(dataDir);
    if (!batch) {
      console.error("git-reap: no committed batch to undo.");
      process.exit(1);
    }
    const commonDir = batch.repoCommonDir;
    if (!commonDir) {
      console.error(`git-reap: cannot locate common-dir for batch ${batch.batchId}`);
      process.exit(1);
    }
    const results = await restoreBatch(commonDir, batch);
    let restored = 0;
    for (const r of results) {
      console.log(
        `  ${r.status === "restored" || r.status === "already" ? "✓" : "!"} ${r.branch}  ${r.status}${r.reason ? `  (${r.reason})` : ""}`,
      );
      if (r.status === "restored" || r.status === "already") restored++;
    }
    console.log(`\n${restored}/${results.length} branches restored from batch ${batch.batchId}`);
    return;
  }
  if (args.command === "tui") {
    const config = await loadConfig({ flags: args });
    const roots = resolveRoots(args, config);
    const { startTui } = await import("./tui/index.js");
    await startTui({
      roots,
      repo: args.repo,
      fetch: args.fetch || config.fetch,
      staleDays: config.staleDays,
      dataDir: config.dataDir,
      protected: config.protected ?? [],
      host: args.host,
      config,
      showIntro: args.intro || !introSeen(config.dataDir),
    });
    return;
  }
}

/** Effective roots: CLI flag wins, else config; TUI defaults to home. */
function resolveRoots(args, config) {
  if (args.roots.length) return args.roots;
  if (config.roots.length) return config.roots;
  return args.command === "tui" ? ["~"] : [];
}

function printTable(result) {
  for (const repo of result.repos) {
    const name = repo.path;
    if (repo.status === "no-default") {
      console.log(`\n${name}  (no default branch: inventory only)`);
    } else {
      console.log(`\n${name}  (default: ${repo.defaultBranch})`);
    }
    for (const b of repo.branches) {
      const mark = b.eligible ? "x" : " ";
      console.log(
        `  [${mark}] ${b.name}  ${b.class}  ${b.ageDays}d old${b.upstream ? "" : "  (no upstream)"}`,
      );
    }
    for (const w of repo.warnings) console.log(`  ! ${w}`);
  }
  for (const s of result.skipped) console.log(`\nskipped ${s.path} (${s.reason})`);
  const eligible = result.repos.reduce(
    (n, r) => n + r.branches.filter((b) => b.eligible).length,
    0,
  );
  console.log(
    `\n${result.repos.length} repos, ${eligible} deletion candidates${result.fetched ? " (refs refreshed)" : " (refs NOT refreshed: pass --fetch to prune)"}`,
  );
}

if (import.meta.main) {
  main();
}
