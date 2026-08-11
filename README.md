# git-reap

Sweep every repo on your machine in one TUI. git-reap finds local branches
whose upstream is gone or that were merged (including squash merges) on
GitHub/GitLab, shows why each one is safe to delete, and makes every
deletion reversible for 90 days.

![demo](demo/git-reap-demo.gif)

## Why

Branches pile up. The remote branch is deleted when a PR merges, but the
local branch stays forever. `git branch --merged` misses squash merges (the
GitHub default), so dead branches hide for months.

git-reap scans every repo under your roots, classifies every local branch
against its real PR/MR state on the host, and only marks branches it can
prove are disposable:

- **merged**: the branch is an ancestor of the default branch
- **squash-merged**: host API finds a merged PR whose head SHA matches the
  branch tip exactly (GitHub/GitLab)
- **gone + proven**: upstream deleted and the work is provably disposable

Everything else is shown with a reason and left alone: unpushed commits,
dirty worktrees, active branches, closed-unmerged PRs, ambiguous names.

## Install

```bash
# with bun (recommended)
bunx git-reap

# or install globally
bun install -g git-reap

# or a standalone binary (no bun needed) from GitHub Releases
curl -fsSL https://github.com/jinnkhan88/git-reap/releases/latest/download/git-reap-linux-x64 -o git-reap
chmod +x git-reap
./git-reap
```

> Note: the `bunx` and global-install paths require the npm package to be
> published. Until then, use the standalone binary or run from a checkout
> with `bun run src/bin.js`.

Compiled binaries are built per release for Linux x64, plus the targets
that build successfully in CI. The Linux binary links against glibc;
musl/Alpine users should use `bunx` or run from source.

## Usage

```bash
git-reap                 interactive TUI (default)
git-reap scan            table report of every branch + class
git-reap scan --json     machine-readable report with PR evidence
git-reap run --yes       delete eligible branches (guards apply)
git-reap undo            restore the last committed batch
```

### TUI keys

| Key | Action |
|-----|--------|
| `tab` | switch pane |
| `↑↓` / `j` / `k` | move the cursor |
| `space` | toggle a branch (ineligible branches show why) |
| `a` | select all eligible in the repo |
| `enter` | open the deletion plan, `enter` again to execute |
| `u` | undo the last batch (90-day retention) |
| `d` | recently deleted: list with restore countdown |
| `r` | rescan |
| `/` | filter |
| `?` | help |
| `[` / `]` | resize panes |
| `q` | quit |

### Safety

- Tri-state guards: anything uncertain blocks deletion; the tool never guesses
- Revalidation at delete time: the tip is re-read and every guard re-runs in
  the same transaction; a moved tip aborts that branch only
- Every delete gets a hidden undo ref plus a JSONL write-ahead ledger, fsynced
  before any ref deletion; `undo` restores for 90 days
- Local-only: remote branches are never touched
- Fully offline by default: no GitHub/GitLab API calls unless you opt in with
  `--host` (PR-state checks for squash-merged branches); verdicts are cached
  and requests are paced so even the opt-in path stays polite

## Config

`~/.config/git-reap/config.toml` (XDG), or `%APPDATA%\git-reap\config.toml`
on Windows.

```toml
roots = ["~/projects", "~/work"]
stale_days = 30
fetch = true
default_branch = "trunk"            # global default override
protected = ["hotfix/*", "release/*"]

[hosts.github]                      # optional: override token discovery
# token = "gho_..."                # default: env → gh hosts.yml → gh CLI
# base_url = "https://api.github.com"

# per-repo overrides
[repos."/home/you/projects/special"]
default_branch = "develop"
protected = ["experiment/*"]
```

Host tokens are read-only: `GH_TOKEN`/`GITHUB_TOKEN` environment variables,
the `gh` CLI auth, or `~/.config/gh/hosts.yml` for GitHub; `GITLAB_TOKEN`/
`GLAB_TOKEN` or the glab config for GitLab. git-reap never writes or prompts
for credentials.

## Development

```bash
bun install
bun test        # full suite
bun run src/bin.js --intro
```

Built with [bun](https://bun.sh) + [OpenTUI](https://github.com/opentui),
plain JavaScript ESM.

## License

MIT
