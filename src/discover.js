// Repo discovery: walk roots, detect .git (dirs AND files),
// dedupe by git common-dir, enumerate worktrees via plumbing, skip bare
// repos and junk dirs, never follow directory symlinks, depth-limited.

import { existsSync } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { git, gitRaw, listWorktrees } from "./git.js";

const JUNK_DIRS = new Set([
  "node_modules",
  ".cache",
  "target",
  "dist",
  "build",
  "out",
  ".next",
  "vendor",
  ".svn",
  ".hg",
  // heavy tool/cache dotdirs: never contain work repos, always expensive
  // to walk. ".config", ".dotfiles" and other state dirs are deliberately
  // NOT here — real repos can live in them (e.g. ~/.config/notes,
  // ~/.dotfiles/home/projects/*).
  ".local",
  ".npm",
  ".nvm",
  ".bun",
  ".cargo",
  ".rustup",
  ".pyenv",
  ".rbenv",
  ".vscode",
  ".vscode-server",
  ".cursor-server",
  ".docker",
  ".ollama",
  ".gradle",
  ".m2",
  ".mozilla",
  ".pki",
  ".gnupg",
  ".ssh",
  ".aws",
  ".azure",
  ".android",
  ".dotnet",
]);

function expandHome(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** All worktree paths of the repo at `repoPath` (main worktree first);
 * falls back to the repo itself when enumeration fails. */
async function worktreePaths(repoPath) {
  const wts = await listWorktrees(repoPath);
  return wts === null ? [repoPath] : wts.map((w) => w.path);
}

/**
 * discoverRepos(roots, { maxDepth, crossFilesystems }) →
 *   { repos: [{ path, commonDir, worktrees, bare:false }], skipped: [{ path, reason }] }
 * `path` is the MAIN worktree path; `worktrees` includes every worktree.
 * Default: do not cross filesystem boundaries (find -xdev semantics) —
 * network mounts (sshfs/NFS) would otherwise dominate scan time.
 */
export async function discoverRepos(roots, { maxDepth = 6, crossFilesystems = false } = {}) {
  const candidates = [];
  const skipped = [];

  async function walk(dir, depth, rootDev) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      skipped.push({ path: dir, reason: "unreadable" });
      return;
    }
    const hasDotGit = entries.some((e) => e.name === ".git");
    const looksBare =
      !hasDotGit &&
      entries.some((e) => e.name === "HEAD") &&
      entries.some((e) => e.name === "objects") &&
      entries.some((e) => e.name === "refs");
    if (hasDotGit || looksBare) candidates.push(dir);
    if (looksBare) return; // never descend into a bare repo's internals
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (e.name === ".git" || JUNK_DIRS.has(e.name)) continue;
      const child = join(dir, e.name);
      if (!crossFilesystems) {
        const st = await lstat(child).catch(() => null);
        if (st && st.dev !== rootDev) {
          skipped.push({ path: child, reason: "filesystem-boundary" });
          continue;
        }
      }
      await walk(child, depth + 1, rootDev);
    }
  }

  for (const root of roots) {
    const r = resolve(expandHome(root));
    if (!existsSync(r)) {
      skipped.push({ path: root, reason: "missing" });
      continue;
    }
    const rootDev = crossFilesystems ? null : (await lstat(r)).dev;
    await walk(r, 0, rootDev);
  }

  const byCommonDir = new Map();
  const validate = async (c) => {
    const bareCheck = await gitRaw(c, ["rev-parse", "--is-bare-repository"]);
    if (bareCheck.code !== 0) return { skip: { path: c, reason: "invalid" } };
    if (bareCheck.stdout.trim() === "true") return { skip: { path: c, reason: "bare" } };
    const commonRaw = await git(c, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]).catch(() => null);
    if (!commonRaw) return { skip: { path: c, reason: "invalid" } };
    const commonDir = await realpath(commonRaw).catch(() => commonRaw);
    const worktrees = await worktreePaths(c);
    // git quirk: for submodule checkouts, `worktree list` reports the GITDIR
    // (.git/modules/<name>) as the worktree path. Never surface a path inside
    // .git — fall back to the directory we actually found.
    const main = worktrees[0] ?? c; // git lists the main worktree first
    return {
      repo: {
        key: commonDir,
        path: main.includes("/.git/") ? c : main,
        commonDir,
        worktrees,
        bare: false,
      },
    };
  };
  // validate candidates through a small concurrency pool (git spawns are
  // the slow part of discovery on large trees)
  const POOL = 8;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(POOL, candidates.length) }, async () => {
      while (cursor < candidates.length) {
        const c = candidates[cursor++];
        const r = await validate(c);
        if (r.skip) {
          skipped.push(r.skip);
        } else if (!byCommonDir.has(r.repo.key)) {
          byCommonDir.set(r.repo.key, r.repo);
        }
      }
    }),
  );

  return { repos: [...byCommonDir.values()], skipped };
}
