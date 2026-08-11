// Fixture harness for git-reap tests.
//
// Every helper builds REAL git repositories in fresh tmpdirs by spawning the
// `git` binary with argument arrays (never shell strings), LC_ALL=C,
// GIT_CONFIG_NOSYSTEM=1, an isolated GIT_CONFIG_GLOBAL, and per-invocation
// `-c user.name/user.email` so nothing ever touches the developer's git
// config. All helpers are idempotent within their own fresh tmpdir and every
// created directory is registered for cleanup via cleanup()/cleanupAll().

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE_IDENTITY = [
  "-c",
  "user.name=git-reap-fixture",
  "-c",
  "user.email=fixture@git-reap.invalid",
];

const createdDirs = new Set();

function run(cmd, args, { cwd, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: {
        ...process.env,
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        // Isolate from the developer's global gitconfig (init.defaultBranch,
        // insteadOf rewrites, etc.) without touching it on disk.
        GIT_CONFIG_GLOBAL: devNull,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        const err = new Error(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

// Spawn git with the fixture identity baked in. Exported so tests can assert
// fixture state with the exact same plumbing the harness uses.
export function git(args, opts = {}) {
  return run("git", [...FIXTURE_IDENTITY, ...args], opts);
}

function tmpDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.add(dir);
  return dir;
}

// Remove one fixture-created directory (repo, worktree, remote, or sandbox
// root). Safe to call on an already-removed path.
export function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
  createdDirs.delete(path);
}

// Remove everything the harness has created so far.
export function cleanupAll() {
  for (const dir of [...createdDirs]) {
    cleanup(dir);
  }
}

async function commitFile(repo, name, content, message, { env } = {}) {
  writeFileSync(join(repo, name), content);
  await git(["add", name], { cwd: repo, env });
  await git(["commit", "-m", message], { cwd: repo, env });
}

// A bare-minimum normal repo on default branch `main` with one commit.
export async function makeRepo({ defaultBranch = "main", dir } = {}) {
  const repo = dir ?? tmpDir("reap-fix-repo-");
  mkdirSync(repo, { recursive: true });
  await git(["init", "-b", defaultBranch, repo]);
  await commitFile(repo, "README.md", "# git-reap fixture\n", "initial commit");
  return repo;
}

// A bare repo (git init --bare) in a fresh tmpdir. Discovery must skip these.
export async function makeBareRepo({ dir } = {}) {
  const bare = dir ?? tmpDir("reap-fix-bare-");
  mkdirSync(bare, { recursive: true });
  await git(["init", "--bare", bare]);
  return bare;
}

async function makeRemote() {
  return makeBareRepo({ dir: tmpDir("reap-fix-remote-") });
}

async function ensureOrigin(repo) {
  const { stdout } = await git(["remote"], { cwd: repo });
  if (stdout.split("\n").includes("origin")) {
    return;
  }
  const remote = await makeRemote();
  await git(["remote", "add", "origin", remote], { cwd: repo });
}

// Branch whose tip is an ancestor of main (committed, then merged --no-ff,
// branch kept). Classification: merged, deletion-eligible.
export async function withMergedBranch(repo, branch = "merged-branch") {
  await git(["checkout", "-b", branch], { cwd: repo });
  await commitFile(repo, "merged.txt", "merged work\n", "merged branch commit");
  await git(["checkout", "main"], { cwd: repo });
  await git(["merge", "--no-ff", "-m", `merge ${branch}`, branch], { cwd: repo });
  return repo;
}

// Branch with a tip commit dated `daysOld` in the past (author + committer).
// Not merged into main. Classification: stale when daysOld > stale_days.
export async function withStaleBranch(repo, daysOld = 90, branch = "stale-branch") {
  await git(["checkout", "-b", branch], { cwd: repo });
  const when = new Date(Date.now() - daysOld * 86_400_000).toISOString();
  await commitFile(repo, "stale.txt", `stale for ${daysOld} days\n`, "old commit", {
    env: { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
  });
  await git(["checkout", "main"], { cwd: repo });
  return repo;
}

// Recent branch, not merged. Classification: active.
export async function withActiveBranch(repo, branch = "active-branch") {
  await git(["checkout", "-b", branch], { cwd: repo });
  await commitFile(repo, "active.txt", "fresh work\n", "active branch commit");
  await git(["checkout", "main"], { cwd: repo });
  return repo;
}

// Branch that HAD an upstream which was deleted on the remote; the fixture
// performs `git fetch --prune` itself so the branch's upstream track is
// [gone]. Uses a local bare repo as the remote (no network).
export async function withGoneUpstream(repo, branch = "gone-branch") {
  await ensureOrigin(repo);
  await git(["checkout", "-b", branch], { cwd: repo });
  await commitFile(repo, "gone.txt", "work that was pushed once\n", "gone branch commit");
  await git(["push", "-u", "origin", branch], { cwd: repo });
  await git(["checkout", "main"], { cwd: repo });
  // Delete the branch on the remote, then prune the tracking ref.
  const { stdout: remotePath } = await git(["remote", "get-url", "origin"], { cwd: repo });
  await git(["update-ref", "-d", `refs/heads/${branch}`], { cwd: remotePath.trim() });
  await git(["fetch", "--prune", "origin"], { cwd: repo });
  return repo;
}

// Like withGoneUpstream, plus an extra local commit added AFTER the remote
// branch was deleted. Tip is not an ancestor of main, so per the
// gone-without-proof rule the branch is not disposable:
// branch is `gone (unproven)` and must be BLOCKED from deletion.
export async function withGoneUnpushedCommits(repo, branch = "gone-unpushed") {
  await withGoneUpstream(repo, branch);
  await git(["checkout", branch], { cwd: repo });
  await commitFile(repo, "unpushed.txt", "local-only work\n", "unpushed local commit");
  await git(["checkout", "main"], { cwd: repo });
  return repo;
}

// Local branch that was never pushed and has no upstream configured.
export async function withNoUpstreamBranch(repo, branch = "no-upstream") {
  await git(["checkout", "-b", branch], { cwd: repo });
  await commitFile(repo, "local.txt", "never pushed\n", "local-only commit");
  await git(["checkout", "main"], { cwd: repo });
  return repo;
}

// Branch with a resolvable upstream, ahead by one unpushed commit.
// SPEC: never delete a branch with known-unpushed commits.
export async function withUnpushedAhead(repo, branch = "ahead-branch") {
  await ensureOrigin(repo);
  await git(["checkout", "-b", branch], { cwd: repo });
  await commitFile(repo, "ahead.txt", "pushed work\n", "pushed commit");
  await git(["push", "-u", "origin", branch], { cwd: repo });
  await commitFile(repo, "ahead2.txt", "unpushed work\n", "unpushed commit");
  await git(["checkout", "main"], { cwd: repo });
  return repo;
}

// `branch` checked out in a linked worktree with uncommitted changes.
// Returns the WORKTREE path (not the repo path).
export async function withDirtyWorktree(repo, branch = "dirty-branch") {
  await git(["branch", branch], { cwd: repo });
  const worktree = tmpDir("reap-fix-wt-dirty-");
  await git(["worktree", "add", worktree, branch], { cwd: repo });
  writeFileSync(join(worktree, "dirty.txt"), "uncommitted changes\n");
  return worktree;
}

// A second worktree of the same repo. Returns { repo, worktree }.
export async function withLinkedWorktree(repo, branch = "linked-branch") {
  await git(["branch", branch], { cwd: repo });
  const worktree = tmpDir("reap-fix-wt-linked-");
  await git(["worktree", "add", worktree, branch], { cwd: repo });
  return { repo, worktree };
}

// Rename the repo's default branch to a non-standard name (default `trunk`).
export async function withNonStandardDefault(repo, name = "trunk") {
  await git(["branch", "-m", name], { cwd: repo });
  return repo;
}

// Leave the repo with no main/master/trunk and no origin/HEAD: default-branch
// resolution must fail safely to `no-default`.
export async function withNoDefault(repo) {
  await git(["branch", "-m", "topic-only"], { cwd: repo });
  return repo;
}

// Protected-by-name branches (built-in patterns): develop, release/*.
export async function withProtectedBranches(repo, names = ["develop", "release/1.0"]) {
  for (const name of names) {
    await git(["branch", name], { cwd: repo });
  }
  return repo;
}

// Branch whose commits landed on main via `git merge --squash` + commit, so
// the branch tip is NOT an ancestor of main even though the content is there.
export async function withSquashMergedBranch(repo, branch = "squash-merged") {
  await git(["checkout", "-b", branch], { cwd: repo });
  await commitFile(repo, "squash.txt", "squashed work\n", "squash branch commit");
  await git(["checkout", "main"], { cwd: repo });
  await git(["merge", "--squash", branch], { cwd: repo });
  await git(["commit", "-m", `squash merge ${branch}`], { cwd: repo });
  return repo;
}

// Branch whose commit was cherry-picked onto main: patch-equivalent per
// `git cherry` but not an ancestor (rule 4, advisory only).
export async function withPatchEquivalentBranch(repo, branch = "patch-equiv") {
  await git(["checkout", "-b", branch], { cwd: repo });
  await commitFile(repo, "cherry.txt", "cherry-picked work\n", "cherry branch commit");
  const { stdout } = await git(["rev-parse", branch], { cwd: repo });
  await git(["checkout", "main"], { cwd: repo });
  // `-x` appends a "(cherry picked from commit ...)" line to the message so
  // the cherry-picked commit can never be bit-identical to the branch tip
  // (same tree/parent/identity/second-resolution timestamps would otherwise
  // collapse them into one SHA on a fast fixture run, making the branch an
  // ancestor of main).
  await git(["cherry-pick", "-x", stdout.trim()], { cwd: repo });
  // Move main past the cherry-pick as a second guard against the collapse.
  await commitFile(repo, "after-cherry.txt", "main moved on\n", "post cherry-pick commit");
  return repo;
}

// A root directory containing several repos in assorted states, for
// discovery tests. Returns { root, repos: { normal, gone, noDefault, bare, deep } }.
export async function makeSandbox() {
  const root = tmpDir("reap-fix-sandbox-");

  const normal = await makeRepo({ dir: join(root, "repo-normal") });
  await withMergedBranch(normal);
  await withStaleBranch(normal, 45);

  const gone = await makeRepo({ dir: join(root, "repo-gone") });
  await withGoneUpstream(gone);

  const noDefault = await makeRepo({ dir: join(root, "repo-no-default") });
  await withNoDefault(noDefault);

  const bare = await makeBareRepo({ dir: join(root, "repo-bare.git") });

  const deep = await makeRepo({ dir: join(root, "nested", "repo-deep") });
  await withUnpushedAhead(deep);

  return { root, repos: { normal, gone, noDefault, bare, deep } };
}
