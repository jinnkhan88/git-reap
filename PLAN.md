# git-reap — PLAN

Build order for v1. Each phase lands green (`bun test` + biome) before the
next starts. TDD: failing test first, then implementation.

Amended 2026-08-10 after the two-reviewer design gate: config/fetch pulled
forward, offline classification completed in Phase 1, tri-state guards +
race-safe execution + durable undo redesigned in Phase 2, Phase 3 rewritten
in JS terms, platform spikes added to Phase 0.

## Phase 0 — scaffold + spikes
- 0.1 Bun package init, layout per SPEC §6, CLI skeleton (`--help` prints
  the full surface; stubs exit "not implemented"), OpenTUI pinned dep,
  biome lint/format config.
- 0.2 `config.js`: minimal TOML loading + precedence (flag > env > config >
  default) for roots/stale_days/fetch/protected — pulled forward from
  Phase 5 because Phases 1-3 depend on it.
- 0.3 **OpenTUI compile spike:** a minimal OpenTUI React app compiled with
  `bun build --compile` for every release target (linux x64 baseline,
  linux arm64, macOS arm64/x64, windows x64) and RUN on a clean machine
  without Bun. Also prove the pinned OpenTUI version's test approach
  (snapshot or state-level). If the native-core packaging fails on a
  target, that target drops to "npm/bunx only" NOW, not in Phase 5.
- 0.4 CI: `bun test` + biome on linux/mac/**windows**.
- 0.5 Fixture harness: `test/fixtures.js` builds throwaway repos in tmpdir
  covering every state in SPEC §7 (gone, gone-with-unpushed, merged, stale,
  active, protected, non-standard default, no-default, no-upstream,
  unpushed-ahead, dirty-worktree, linked-worktree, bare, reused-PR-name,
  branch-moved-mid-confirm).

## Phase 1 — discovery + offline classification (complete offline core)
- 1.1 `discover.js`: walk configured roots, find `.git` (dirs AND files for
  worktrees/submodules), dedupe by `--git-common-dir`, keep worktrees for
  guards, skip bare (report skipped), no symlink following, depth limit,
  parallel walk with per-repo timeout.
- 1.2 `git.js`: async wrapper over the `git` CLI using NUL-delimited
  porcelain (`for-each-ref -z`, `worktree list --porcelain -z`,
  `status --porcelain=v2 -z`), arg arrays, `LC_ALL=C`, timeouts.
- 1.3 `resolve.js`: default-branch + selected-remote resolution per
  SPEC §3.0 with freshness reporting and no-default safe failure.
- 1.4 `--fetch`: explicit opt-in fetch/prune unit before classification,
  per-remote errors, scan output marks refreshed vs stale refs.
- 1.5 `classify.js`: SPEC §3.1 rules 1, 2, 4, 5, 6 — INCLUDING the offline
  `patch-equivalent` detection (advisory, never pre-selected) — plus §3.2
  gone-branch evidence logic. Truth-table tests per rule.
- 1.6 `reap scan --json` end-to-end offline on the fixture suite; scan
  progress callback wired for the TUI's 500+-repo indicator.

## Phase 2 — safety engine + race-safe deletion + durable undo
Lands BEFORE any real deletion command is exposed.
- 2.1 `guards.js`: tri-state guards per SPEC §4.1 (unknown blocks),
  including implicit default-branch protection; matrix-tested.
- 2.2 `ledger.js`: hidden undo refs + write-ahead batch ledger with
  begin/commit markers, file locking, fsync, crash recovery, per-entry
  results, restore-refuses-overwrite.
- 2.3 `execute.js`: the §4.2 transaction (re-read tip → re-run guards →
  write undo anchor → compare-and-delete via `update-ref -d <ref> <sha>`);
  `git branch -d` only for `merged`; flag policy message on confirm output.
- 2.4 Adversarial tests: delete attempt on current branch / default branch /
  dirty worktree / unpushed / gone-unproven must be refused; moved-tip
  between scan and delete must abort that branch only; interrupted batch
  restores cleanly.

## Phase 3 — host API sync (JS modules)
- 3.1 `hosts/mod.js`: the `findPrState(repoInfo, branch)` duck-typed
  contract + token discovery (gh hosts.yml, glab config, env; read-only).
- 3.2 `hosts/github.js`: remote-URL-derived owner/repo (fork-aware), PR
  lookup, head-SHA binding per SPEC §3.3, ambiguity/multiple/stale-name →
  `unknown`. Mocked with a local `node:http` server.
- 3.3 `hosts/gitlab.js`: same for MRs with source-project identity.
- 3.4 Classification integration: API verdicts with evidence recorded in
  JSON/report; rule 4 fallback fires whenever no API verdict; no-network
  run still passes the full offline suite.
- 3.5 Rate-limit/auth-failure/timeout degradation tests.

## Phase 4 — TUI
- 4.0 Early spike check: large-list (1000+ branches) render performance on
  the pinned OpenTUI before building the screens.
- 4.1 App state on immutable scan snapshots; repo/branch tables, badges
  (classification + evidence confidence), sort/filter, scan progress.
- 4.2 Checkbox selection (blocked rows visible with reason, not checkable),
  select-all scopes, confirm screen with exact operations + flag-policy
  note, execution with per-branch progress, result summary.
- 4.3 Undo key, rescan, help overlay, dry-run toggle.
- 4.4 Screen tests using the approach proven in 0.3.

## Phase 5 — polish + packaging
- 5.1 Config surface completed (per-repo default_branch, hosts section),
  docs.
- 5.2 README with demo GIF, install instructions, compiled-binary update
  note.
- 5.3 Release workflow: `bun build --compile` per 0.3's proven matrix,
  npm publish, checksums; installed-npm vs bunx vs clean-machine-binary
  tested separately.
- 5.4 Soak: run against a real home directory (dry-run), sanity-check
  classification on ~20 real repos.

## Out of scope for v1
- VS Code extension (v2, separate surface)
- auto-reap on fetch / background daemon
- remote (server-side) branch cleanup
- Gitea/Bitbucket hosts (contract leaves room)
- Pre-selecting `patch-equivalent` (advisory only until real-world accuracy
  data exists)

## Risks / open questions
- ~~offline squash false-positives~~ → resolved: renamed `patch-equivalent`,
  advisory only, never pre-selected (design gate 2026-08-10).
- gh/glab token discovery varies by version → degrade to `unknown` with a
  scan warning; never block the offline path.
- OpenTUI native-core packaging per target → Phase 0 spike PASSED on
  linux-x64 (2026-08-10): `@opentui/core` renderer compiles into a
  `bun build --compile` binary and runs standalone (137MB glibc-dynamically-
  linked ELF; runs without Bun installed; not musl/Alpine-compatible).
  Remaining targets (mac x64/arm64, windows x64, linux arm64, baseline x64
  flags) get compile-verified in the release workflow; runtime-verified on
  CI runners where possible.
