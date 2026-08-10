#!/usr/bin/env bun
// git-reap CLI entry. Full surface per SPEC §5; stubs until phases land.

const USAGE = `git-reap — sweep dead local branches across all your repos

usage:
  git reap                 interactive TUI (default)
  git reap scan            non-interactive report (table or --json)
  git reap run --yes       delete pre-selected candidates (guards apply)
  git reap undo            restore last committed batch

flags:
  --root <path>            scan root (repeatable; overrides config)
  --repo <path>            single-repo mode
  --fetch                  fetch/prune before classifying (opt-in)
  --dry-run                print the plan, change nothing
  --stale-days <n>         stale threshold in days (default 30)
  --json                   machine-readable output
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
  console.error(`git-reap: '${args.command}' is not implemented yet (Phase 0 scaffold)`);
  process.exit(1);
}

if (import.meta.main) {
  main();
}
