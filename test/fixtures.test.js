// The harness validating itself: for every fixture, assert the state actually
// holds using git plumbing (merge-base exit codes, rev-parse, porcelain
// status, upstream:track), never human output.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupAll,
  git,
  makeBareRepo,
  makeRepo,
  makeSandbox,
  withActiveBranch,
  withDirtyWorktree,
  withGoneUnpushedCommits,
  withGoneUpstream,
  withLinkedWorktree,
  withMergedBranch,
  withNoDefault,
  withNonStandardDefault,
  withNoUpstreamBranch,
  withPatchEquivalentBranch,
  withProtectedBranches,
  withSquashMergedBranch,
  withStaleBranch,
  withUnpushedAhead,
} from "./fixtures.js";

afterAll(cleanupAll);

// Run a plumbing command and return its exit code instead of throwing.
async function exitCode(args, cwd) {
  try {
    await git(args, { cwd });
    return 0;
  } catch (err) {
    return err.code;
  }
}

async function upstreamTrack(repo, branch) {
  const { stdout } = await git(
    ["for-each-ref", "--format=%(upstream:track)", `refs/heads/${branch}`],
    { cwd: repo },
  );
  return stdout.trim();
}

describe("makeRepo", () => {
  test("is a normal repo on main with exactly one commit", async () => {
    const repo = await makeRepo();
    const { stdout: head } = await git(["symbolic-ref", "HEAD"], { cwd: repo });
    expect(head.trim()).toBe("refs/heads/main");
    const { stdout: count } = await git(["rev-list", "--count", "HEAD"], { cwd: repo });
    expect(count.trim()).toBe("1");
    const { stdout: bare } = await git(["rev-parse", "--is-bare-repository"], { cwd: repo });
    expect(bare.trim()).toBe("false");
  });
});

describe("makeBareRepo", () => {
  test("is a bare repository", async () => {
    const bare = await makeBareRepo();
    const { stdout } = await git(["rev-parse", "--is-bare-repository"], { cwd: bare });
    expect(stdout.trim()).toBe("true");
    expect(existsSync(join(bare, "HEAD"))).toBe(true);
  });
});

describe("withMergedBranch", () => {
  test("branch tip is an ancestor of main", async () => {
    const repo = await makeRepo();
    await withMergedBranch(repo);
    expect(await exitCode(["merge-base", "--is-ancestor", "merged-branch", "main"], repo)).toBe(0);
    // Branch still exists after the merge.
    expect(await exitCode(["rev-parse", "--verify", "refs/heads/merged-branch"], repo)).toBe(0);
  });
});

describe("withStaleBranch", () => {
  test("tip commit is really dated daysOld in the past", async () => {
    const repo = await makeRepo();
    await withStaleBranch(repo, 60);
    const { stdout } = await git(["log", "-1", "--format=%ct", "stale-branch"], { cwd: repo });
    const ageDays = (Date.now() / 1000 - Number(stdout.trim())) / 86_400;
    expect(ageDays).toBeGreaterThanOrEqual(60);
    // Stale but not merged.
    expect(await exitCode(["merge-base", "--is-ancestor", "stale-branch", "main"], repo)).toBe(1);
  });
});

describe("withActiveBranch", () => {
  test("recent commit, not merged into main", async () => {
    const repo = await makeRepo();
    await withActiveBranch(repo);
    expect(await exitCode(["merge-base", "--is-ancestor", "active-branch", "main"], repo)).toBe(1);
    const { stdout } = await git(["log", "-1", "--format=%ct", "active-branch"], { cwd: repo });
    const ageDays = (Date.now() / 1000 - Number(stdout.trim())) / 86_400;
    expect(ageDays).toBeLessThan(1);
  });
});

describe("withGoneUpstream", () => {
  test("upstream track is [gone] after the fixture's fetch --prune", async () => {
    const repo = await makeRepo();
    await withGoneUpstream(repo);
    expect(await upstreamTrack(repo, "gone-branch")).toBe("[gone]");
    // The remote-tracking ref is really pruned.
    expect(
      await exitCode(["rev-parse", "--verify", "refs/remotes/origin/gone-branch"], repo),
    ).not.toBe(0);
    // But the upstream is still configured on the branch.
    const { stdout } = await git(
      ["for-each-ref", "--format=%(upstream)", "refs/heads/gone-branch"],
      { cwd: repo },
    );
    expect(stdout.trim()).toBe("refs/remotes/origin/gone-branch");
  });
});

describe("withGoneUnpushedCommits", () => {
  test("gone upstream AND local commits that are not on main", async () => {
    const repo = await makeRepo();
    await withGoneUnpushedCommits(repo);
    expect(await upstreamTrack(repo, "gone-unpushed")).toBe("[gone]");
    expect(await exitCode(["merge-base", "--is-ancestor", "gone-unpushed", "main"], repo)).toBe(1);
  });
});

describe("withNoUpstreamBranch", () => {
  test("no upstream configured", async () => {
    const repo = await makeRepo();
    await withNoUpstreamBranch(repo);
    const { stdout } = await git(
      ["for-each-ref", "--format=%(upstream)", "refs/heads/no-upstream"],
      { cwd: repo },
    );
    expect(stdout.trim()).toBe("");
    expect(await exitCode(["rev-parse", "--abbrev-ref", "no-upstream@{upstream}"], repo)).not.toBe(
      0,
    );
  });
});

describe("withUnpushedAhead", () => {
  test("upstream resolves and branch is ahead by exactly 1", async () => {
    const repo = await makeRepo();
    await withUnpushedAhead(repo);
    expect(await upstreamTrack(repo, "ahead-branch")).toBe("[ahead 1]");
  });
});

describe("withDirtyWorktree", () => {
  test("worktree for the branch has uncommitted changes", async () => {
    const repo = await makeRepo();
    const worktree = await withDirtyWorktree(repo, "dirty-branch");
    const { stdout: status } = await git(["status", "--porcelain"], { cwd: worktree });
    expect(status.trim()).not.toBe("");
    // The worktree is registered and has dirty-branch checked out.
    const { stdout: list } = await git(["worktree", "list", "--porcelain"], { cwd: repo });
    expect(list).toContain(`worktree ${realpathSync(worktree)}`);
    const { stdout: head } = await git(["symbolic-ref", "HEAD"], { cwd: worktree });
    expect(head.trim()).toBe("refs/heads/dirty-branch");
  });
});

describe("withLinkedWorktree", () => {
  test("both paths are worktrees of the same repo", async () => {
    const repo = await makeRepo();
    const { worktree } = await withLinkedWorktree(repo);
    const { stdout: list } = await git(["worktree", "list", "--porcelain"], { cwd: repo });
    expect(list).toContain(`worktree ${realpathSync(repo)}`);
    expect(list).toContain(`worktree ${realpathSync(worktree)}`);
    // Same common dir (--path-format=absolute keeps it join-free).
    const { stdout: a } = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: repo,
    });
    const { stdout: b } = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: worktree,
    });
    expect(realpathSync(b.trim())).toBe(realpathSync(a.trim()));
  });
});

describe("withNonStandardDefault", () => {
  test("default branch is trunk, no main", async () => {
    const repo = await makeRepo();
    await withNonStandardDefault(repo);
    const { stdout: head } = await git(["symbolic-ref", "HEAD"], { cwd: repo });
    expect(head.trim()).toBe("refs/heads/trunk");
    expect(await exitCode(["rev-parse", "--verify", "refs/heads/main"], repo)).not.toBe(0);
  });
});

describe("withNoDefault", () => {
  test("no main/master/trunk and no remote refs", async () => {
    const repo = await makeRepo();
    await withNoDefault(repo);
    const { stdout: heads } = await git(
      ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
      { cwd: repo },
    );
    expect(heads.trim()).toBe("topic-only");
    const { stdout: remotes } = await git(
      ["for-each-ref", "--format=%(refname:short)", "refs/remotes"],
      { cwd: repo },
    );
    expect(remotes.trim()).toBe("");
    const { stdout: remoteList } = await git(["remote"], { cwd: repo });
    expect(remoteList.trim()).toBe("");
  });
});

describe("withProtectedBranches", () => {
  test("develop and release/1.0 exist", async () => {
    const repo = await makeRepo();
    await withProtectedBranches(repo);
    expect(await exitCode(["rev-parse", "--verify", "refs/heads/develop"], repo)).toBe(0);
    expect(await exitCode(["rev-parse", "--verify", "refs/heads/release/1.0"], repo)).toBe(0);
  });
});

describe("withSquashMergedBranch", () => {
  test("NOT an ancestor of main, but its content is on main", async () => {
    const repo = await makeRepo();
    await withSquashMergedBranch(repo);
    expect(await exitCode(["merge-base", "--is-ancestor", "squash-merged", "main"], repo)).toBe(1);
    expect(await exitCode(["cat-file", "-e", "main:squash.txt"], repo)).toBe(0);
  });
});

describe("withPatchEquivalentBranch", () => {
  test("NOT an ancestor of main, but git cherry reports patch equivalence", async () => {
    const repo = await makeRepo();
    await withPatchEquivalentBranch(repo);
    expect(await exitCode(["merge-base", "--is-ancestor", "patch-equiv", "main"], repo)).toBe(1);
    const { stdout } = await git(["cherry", "main", "patch-equiv"], { cwd: repo });
    const lines = stdout.trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.startsWith("-"))).toBe(true);
  });
});

describe("makeSandbox", () => {
  test("root contains repos in the advertised states", async () => {
    const { root, repos } = await makeSandbox();
    // Normal repo: merged + stale branches present.
    expect(existsSync(join(repos.normal, ".git"))).toBe(true);
    expect(
      await exitCode(["merge-base", "--is-ancestor", "merged-branch", "main"], repos.normal),
    ).toBe(0);
    // Gone repo: pruned upstream.
    expect(await upstreamTrack(repos.gone, "gone-branch")).toBe("[gone]");
    // No-default repo.
    const { stdout: head } = await git(["symbolic-ref", "HEAD"], { cwd: repos.noDefault });
    expect(head.trim()).toBe("refs/heads/topic-only");
    // Bare repo present under the root.
    const { stdout: bare } = await git(["rev-parse", "--is-bare-repository"], { cwd: repos.bare });
    expect(bare.trim()).toBe("true");
    // Nested repo: ahead of upstream.
    expect(repos.deep.startsWith(join(root, "nested"))).toBe(true);
    expect(await upstreamTrack(repos.deep, "ahead-branch")).toBe("[ahead 1]");
  });
});
