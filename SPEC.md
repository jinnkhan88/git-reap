# git-reap — SPEC

> Sweep every repo on your machine in one TUI. Branches dead on GitHub/GitLab
> (merged, squash-merged, or gone-upstream) flagged with dry-run and undo.

Design-gate: reviewed by two independent reviewers 2026-08-10; all P0/P1
findings folded into this revision (raw reviews: /tmp/reap-review-codex.md,
/tmp/reap-review-claude.md).

## 1. Problem

Remote branches are auto-deleted when PRs merge, but local clones accumulate
hundreds of dead branches. Existing tools clean ONE repo at a time and either
miss squash-merges (`git branch --merged` can't see them) or require the
GitHub CLI per-repo. Nobody does a safe, interactive, multi-repo sweep.

## 2. Product

A single binary/package, `git-reap` (also usable as `git reap`):

1. **Discover** all git repos under one or more roots (configurable list,
   e.g. `~/projects`, `~/code`).
2. **Classify** every local branch in every repo (see §3).
3. **Present** an interactive checkbox TUI grouped by repo, with
   classification badges, ahead/behind counts, last-commit age, and the
   evidence behind each verdict.
4. **Delete safely** — dry-run by default; tri-state guards; race-safe
   execution; durable undo.

### Explicit nevers (guardrails)

- NEVER delete the currently checked-out branch, in any worktree.
- NEVER delete the repo's resolved default branch `D`, whatever its name —
  `D` is implicitly protected independent of the pattern list.
- NEVER delete a branch with uncommitted changes in its worktree.
- NEVER delete a branch with known-unpushed commits. When push state is
  UNKNOWN (no upstream, upstream pruned), deletion is BLOCKED unless
  independent proof makes the commits disposable (see §3).
- NEVER delete protected branches: built-ins `main`, `master`, `develop`,
  `dev`, `release/*` (non-removable in v1) plus user-configured patterns
  (config EXTENDS built-ins, never replaces). Matching is case-sensitive
  git-ref globbing; `release/*` matches one path level.
- NEVER run `git fetch` without explicit opt-in (`--fetch` flag or config) —
  read-only by default. Scan output always marks whether refs were
  refreshed.
- NEVER require a network connection for core classification — API sync is
  an accuracy upgrade, not a dependency. A no-network run must be fully
  functional.
- NEVER store credentials — read tokens from the environment / existing CLI
  configs (`gh` hosts.yml, `glab` config) read-only.
- NEVER silently treat a bare/mirror repo as a normal clone — bare repos are
  excluded from discovery (reported as skipped).

## 3. Classification rules (the hard part)

### 3.0 Preliminaries: default branch resolution

Every rule needs a trustworthy default branch `D`. Resolution precedence:

1. Explicit per-repo config (`default_branch = "trunk"`).
2. Selected remote's symbolic HEAD (`refs/remotes/<remote>/HEAD`).
3. Local branch matching the remote HEAD name.
4. Safe failure: repo appears in inventory as `no-default` — merged /
   squash / stale classification is BLOCKED (gone-upstream still allowed,
   with §4 evidence rules). Scan output always includes D's identity and
   freshness (last commit date, behind-remote if known).

Multiple remotes: use the remote of the current branch's upstream, else
`origin` if present, else the first remote. Empty/unborn repos and bare
repos are skipped with a reason.

### 3.1 Rules

For each non-protected local branch B:

1. **upstream-gone**: B has a configured upstream whose remote-tracking ref
   is missing → candidate class `gone`. (Detection via
   `git for-each-ref --format=%(upstream:track)` etc., never by parsing
   `[gone]` text.) `gone` alone is NOT deletion-eligible — see §3.2.
2. **merged**: `git merge-base --is-ancestor B D` → `merged`.
   Deletion-eligible (pre-selected).
3. **host-verified squash-merge**: host API finds a PR/MR for B (see §3.3)
   with state merged AND evidence binds it to B's CURRENT tip →
   `squash-merged`. Deletion-eligible (pre-selected). A closed-unmerged
   PR/MR → `closed-unmerged` (first-class class, shown, NEVER pre-selected —
   "PR closed" does not mean the work is disposable).
4. **offline patch equivalence** (runs whenever rule 3 produced no verdict —
   API down, no match, rate-limited, or ambiguous): `git cherry D B` with an
   explicitly bounded range — all entries `-` → `patch-equivalent`. This is
   ADVISORY ONLY: shown with a low-confidence badge, NEVER pre-selected in
   v1. (git cherry detects cherry-pick/rebase equivalence; it does not prove
   a many-to-one squash merge — hence the name and the advisory status.)
5. **stale**: last commit older than `stale_days` (default 30) → `stale`
   (shown, not pre-selected).
6. Else → `active`.

Deletion candidates pre-selected: `merged`, `squash-merged` (host-verified),
and `gone` only when §3.2 proof exists. Shown but not pre-selected:
`patch-equivalent`, `closed-unmerged`, `stale`, unproven `gone`.

### 3.2 The gone-branch evidence rule

A `gone` (or no-upstream) branch becomes deletion-eligible ONLY with
independent proof its commits are disposable:

- B is an ancestor of D (rule 2), OR
- a host-verified merged PR/MR binds to B's current tip (rule 3).

Otherwise the branch is shown as `gone (unproven)` / `no-upstream` with push
state `unknown`, and is BLOCKED from deletion. Rationale: once the tracking
ref is gone, "was the tip ahead" is unreconstructable — unknown must block.

### 3.3 Host API correlation

- Repository identity comes from the remote URL of the SELECTED remote
  (parse `git remote get-url`, honoring insteadOf rewrites); fork workflows
  mean the PR head owner is the remote's owner, not necessarily the upstream
  repo's.
- GitHub: `GET /repos/{o}/{r}/pulls?head={owner}:{B}&state=all`
  GitLab: `GET /projects/:id/merge_requests?source_branch=B&state=all`
  (with source-project identity).
- Bind the verdict to content: prefer a PR whose recorded head SHA equals
  B's tip; else require the PR head to be an ancestor/equivalent of B's tip
  AND treat any commits after it as unpushed evidence (blocks). Branch names
  are reusable — a name-only match, multiple matches, or a stale-name match
  is `unknown`, NEVER squash-merged.
- Pagination, auth failure, rate limiting, and timeouts all degrade to
  `unknown` (and a scan warning), never to a positive verdict.
- Report/JSON output records the PR/MR id and the evidence used.

## 4. Safety engine

### 4.1 Tri-state guards

Every guard returns `pass` / `block` / `unknown`. **Unknown blocks.**

| Guard | Check |
|---|---|
| current-branch | not HEAD of any worktree (`git worktree list --porcelain -z` + HEADs) |
| default-branch | B != resolved D (implicit, any name) |
| protected | not matching protected patterns (built-ins + config) |
| dirty-worktree | worktree for B (if any) has clean `git status --porcelain=v2 -z` |
| unpushed | ahead-count == 0 when upstream resolves; `unknown` when it can't (gone / no upstream) — then §3.2 decides eligibility |

### 4.2 Race-safe execution (per branch, at deletion time)

Guards evaluated at scan time DO NOT protect the mutation. Execution is a
per-branch transaction:

1. Re-read B's tip SHA; abort this branch if it differs from the reviewed
   SHA shown at confirm time.
2. Re-run ALL guards; abort on any block/unknown.
3. Write undo anchor (§4.3) and flush it to disk.
4. Delete via compare-and-delete: `git update-ref -d refs/heads/B <old-sha>`
   — the delete fails if the ref moved between check and delete.

Explicit flag policy: we do NOT rely on `git branch -d`'s ancestor check.
For `gone`/`squash-merged` branches git would refuse `-d` by design; our
guards + evidence rules + compare-and-delete are the deliberate substitute,
and the confirm screen says so in plain language. `git branch -d` is used
only for `merged` branches where git's own check still applies as a bonus.

### 4.3 Durable undo

A SHA in JSON is not a reachability root — after deletion a tip can be gc'd
exactly when undo is needed. So:

- Before deleting B at tip S, create a hidden ref
  `refs/git-reap/undo/<batch-id>/<encoded-branch>` → S, kept for a retention
  period (default 90 days) or until `reap undo --purge`.
- Ledger `ledger.jsonl` (platform data dir) is write-ahead per batch:
  `begin {batch-id, repo-common-dir, ...}` → one entry per branch
  `{branch, sha, undo-ref, status}` → `commit {batch-id}` marker. File-locked
  during execution; fsync before any ref deletion.
- `reap undo` restores the last COMMITTED batch: `git branch <name> <sha>`
  per entry, refusing to overwrite an existing branch unless it already
  points at the recorded SHA. Per-entry results reported; partial restore is
  visible, not silent.
- Repo identity = git common-dir (not a movable worktree path).
- Concurrent git-reap processes on the same repo are serialized by the lock.

## 5. Interfaces

### TUI (primary)

- Left pane: repo list with candidate counts; right pane: branch table for
  focused repo (or flat all-repos view, toggle).
- Checkbox multi-select; `a` select-all-preselected-in-repo, `A` global.
  Blocked/unknown branches are visible with their reason and cannot be
  checked.
- Badges: classification, evidence confidence, ahead/behind, age.
- Sort by age/classification; `/` filter; `?` help.
- `enter` → confirm screen listing the exact operation per branch and the
  plain-language flag policy note; confirm executes with progress and a
  result summary.
- `u` undo last batch, `r` rescan, `d` toggle dry-run, `q` quit.
- Works on immutable scan snapshots; execution always revalidates (§4.2).
- Scan progress indicator for large repo sets (500+), per-repo timeouts.

### CLI (scriptable)

```
git reap                 # TUI
git reap scan            # non-interactive report (table or --json)
git reap run --yes       # delete pre-selected candidates (guards apply)
git reap undo            # restore last committed batch
flags: --root <path> (repeatable), --fetch, --dry-run, --stale-days N,
       --json, --repo <path> (single-repo mode)
```

### Config

Linux/mac: `~/.config/git-reap/config.toml`; Windows: `%APPDATA%\git-reap\`.
Ledger: `~/.local/share/git-reap/` resp. `%LOCALAPPDATA%\git-reap\`.
Precedence: flag > env > config > default.

```toml
roots = ["~/projects", "~/code"]
stale_days = 30
fetch = false
protected = ["hotfix/*"]      # extends built-ins, never replaces
[hosts]   # optional; otherwise gh/glab configs + env vars are used read-only
# github_token = "env:GITHUB_TOKEN"
# gitlab_token = "env:GITLAB_TOKEN"
```

## 6. Architecture

Single package, plain JavaScript ESM (no TypeScript), library + thin bin.
Bun-first dev and runtime; OpenTUI (@opentui/react, pinned) for the TUI.

```
src/
  discover.js    # repo discovery (walk roots, detect .git, worktrees/submodules)
  git.js         # porcelain-via-CLI wrapper (spawn git, parse -z output)
  resolve.js     # default-branch + remote resolution (SPEC §3.0)
  classify.js    # local classification (§3.1 rules 1,2,4,5,6 + §3.2)
  hosts/
    mod.js       # host interface: findPrState(repo, branch) duck-typed contract
    github.js    # REST via gh token or GITHUB_TOKEN
    gitlab.js    # REST via glab token or GITLAB_TOKEN
  guards.js      # tri-state safety engine (§4.1)
  execute.js     # race-safe deletion transaction (§4.2)
  ledger.js      # undo refs + write-ahead batch ledger (§4.3)
  config.js      # TOML config + precedence (§5)
  tui/           # @opentui/react components (.jsx)
  bin.js         # CLI entry
```

Decisions:
- **Plain JS, `.jsx` for components, bun-first.** Fast iteration, easy
  contributor on-ramp, `bunx git-reap` for users. The headless core
  (discover/classify/guards/execute/ledger/hosts) is UI-free — the TUI is a
  thin layer, so OpenTUI churn stays cheap. Pin the OpenTUI version.
- **Shell out to `git`** — matches the user's git config and worktrees. All
  invocations read-only except the final confirmed deletion.
- **Stable machine formats only:** `for-each-ref --format=... -z`,
  `worktree list --porcelain -z`, `status --porcelain=v2 -z`. Never parse
  human output (`branch -vv` `[gone]` text localizes). Spawn with arg
  arrays, `LC_ALL=C`, bounded output, per-command timeout, cancellation.
- **Discovery identity:** dedupe repos by `git rev-parse --git-common-dir`;
  keep all worktrees of a repo for guards. Don't follow directory symlinks.
  Skip bare repos (report as skipped). Depth-limited, permission-tolerant.
- **No app-owned state besides ledger + undo refs** — PR status is the
  database.
- **Concurrency:** promise pool (hand-rolled, p-limit style) over git
  spawns + API calls; per-repo timeouts.
- **Hosts contract:** `findPrState(repoInfo, branch)` →
  `{ verdict: 'merged'|'closed'|'unknown', evidence: {prId, headSha, ...} }`.
  Duck-typed; GitHub and GitLab modules conform.

## 7. Testing

- Runner: `bun test`. Lint/format: biome (picked in Phase 0).
- Unit: classification truth table per rule incl. tri-state outcomes; guard
  matrix (pass/block/unknown); ledger round-trip + crash-recovery
  (interrupted batch) tests.
- Integration: fixture repos in tmpdir covering: gone-upstream,
  gone-with-unpushed-local-commits, merged, stale, active, protected,
  non-standard default-branch name, no-default repo, no-upstream branch,
  unpushed-ahead, dirty-worktree, linked-worktree, bare repo, reused PR
  branch name, branch-moved-between-scan-and-delete. Squash fixture via
  `git commit-tree`.
- Host API: local `node:http` server serving canned GitHub/GitLab responses;
  offline tests must pass with network disabled.
- TUI: prove the pinned OpenTUI testing approach in the Phase 0 spike before
  promising snapshot tests; otherwise unit-test UI state and use PTY golden
  tests sparingly.
- TDD throughout: failing test before each implementation unit.

## 8. Distribution (post-v1)

- `bunx git-reap` / `npm i -g git-reap` (npm name verified free 2026-08-10)
- GitHub release binaries via `bun build --compile` (linux x64 baseline,
  linux arm64, macOS arm64/x64, windows x64) — baseline (not modern) x64
  CPU targets. Compiled binaries embed a pinned Bun runtime; runtime CVEs
  ship as new releases (note in docs).
- Homebrew tap; optionally `gh` extension shim.
- Later surface: VS Code extension (marketplace gap: leader has 35 installs).

## 9. Name

`git-reap` — verified free on crates.io and npm, no same-space GitHub
project (2026-08-10). Avoid `git-purge` (0-star same-product twin on npm).
