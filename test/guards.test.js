import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_PROTECTED } from "../src/config.js";
import { runGuards } from "../src/guards.js";
import { resolveRepo } from "../src/resolve.js";
import {
  git as fxGit,
  makeRepo,
  withActiveBranch,
  withDirtyWorktree,
  withGoneUnpushedCommits,
  withGoneUpstream,
  withLinkedWorktree,
  withMergedBranch,
  withNoDefault,
  withNoUpstreamBranch,
  withProtectedBranches,
  withStaleBranch,
  withUnpushedAhead,
} from "./fixtures.js";

async function commitFile(repo, name, content, msg) {
  writeFileSync(join(repo, name), content);
  await fxGit(["add", name], { cwd: repo });
  await fxGit(["commit", "-m", msg], { cwd: repo });
}

async function guards(repo, branch, overrides = {}) {
  const resolved = await resolveRepo(repo);
  return runGuards(repo, branch, {
    defaultRef: resolved.defaultRef,
    protectedPatterns: BUILTIN_PROTECTED,
    ...overrides,
  });
}

describe("guards §4.1", () => {
  test("current-branch: blocks when the branch is checked out", async () => {
    const repo = await makeRepo();
    await fxGit(["checkout", "-b", "feat/current"], { cwd: repo });
    const r = await guards(repo, "feat/current");
    const g = r.guards.find((x) => x.name === "current-branch");
    expect(g.verdict).toBe("block");
    expect(r.verdict).toBe("block");

    await fxGit(["checkout", "main"], { cwd: repo });
    const r2 = await guards(repo, "feat/current");
    expect(r2.guards.find((x) => x.name === "current-branch").verdict).toBe("pass");
  });

  test("current-branch: blocks a branch checked out in a LINKED worktree", async () => {
    const repo = await makeRepo();
    await withLinkedWorktree(repo, "linked/active");
    const r = await guards(repo, "linked/active");
    expect(r.guards.find((x) => x.name === "current-branch").verdict).toBe("block");
  });

  test("dirty-worktree: blocks a branch whose linked worktree has uncommitted changes", async () => {
    const repo = await makeRepo();
    const wt = await withDirtyWorktree(repo, "dirty-branch");
    const r = await guards(repo, "dirty-branch");
    expect(r.guards.find((x) => x.name === "dirty-worktree").verdict).toBe("block");
    expect(r.verdict).toBe("block");

    // clean worktree → dirty guard passes (current-branch still blocks)
    const { repo: repo2 } = await withLinkedWorktree(await makeRepo(), "clean-branch");
    const r2 = await guards(repo2, "clean-branch");
    expect(r2.guards.find((x) => x.name === "dirty-worktree").verdict).toBe("pass");
  });

  test("default-branch: blocks the resolved default under any name", async () => {
    const repo = await makeRepo({ defaultBranch: "trunk" });
    const resolved = await resolveRepo(repo);
    expect(resolved.defaultBranch).toBe("trunk");
    const r = await guards(repo, "trunk");
    expect(r.guards.find((x) => x.name === "default-branch").verdict).toBe("block");
    expect(r.verdict).toBe("block");

    // side branch: not checked out (HEAD stays on trunk), default passes
    await fxGit(["checkout", "-b", "side"], { cwd: repo });
    await commitFile(repo, "side.txt", "s\n", "side commit");
    await fxGit(["checkout", "trunk"], { cwd: repo });
    const r2 = await guards(repo, "side");
    expect(r2.guards.find((x) => x.name === "default-branch").verdict).toBe("pass");
  });

  test("default-branch: unknown (blocks) when no default resolves", async () => {
    const repo = await withNoDefault(await makeRepo());
    // topic-only is checked out, so create a second branch that isn't, then
    // assert the default-branch guard verdict in isolation
    await fxGit(["branch", "other"], { cwd: repo });
    const r = await guards(repo, "other");
    expect(r.guards.find((x) => x.name === "default-branch").verdict).toBe("unknown");
    expect(r.verdict).toBe("unknown");
  });

  test("protected: blocks built-in and configured patterns", async () => {
    const repo = await withProtectedBranches(await makeRepo(), [
      "develop",
      "release/1.0",
      "hotfix/urgent",
    ]);
    for (const name of ["develop", "release/1.0"]) {
      const r = await guards(repo, name);
      expect(r.guards.find((x) => x.name === "protected").verdict).toBe("block");
    }
    // hotfix/* only blocks when configured
    const rExt = await guards(repo, "hotfix/urgent", {
      protectedPatterns: [...BUILTIN_PROTECTED, "hotfix/*"],
    });
    expect(rExt.guards.find((x) => x.name === "protected").verdict).toBe("block");
    const rUnprotected = await guards(repo, "hotfix/urgent");
    expect(rUnprotected.guards.find((x) => x.name === "protected").verdict).toBe("pass");
  });

  test("unpushed: blocks known-ahead branches; passes at zero ahead", async () => {
    const ahead = await withUnpushedAhead(await makeRepo(), "ahead-branch");
    const r = await guards(ahead, "ahead-branch", {
      upstream: "refs/remotes/origin/ahead-branch",
    });
    const g = r.guards.find((x) => x.name === "unpushed");
    expect(g.verdict).toBe("block");
    expect(g.reason).toContain("unpushed");
    expect(r.verdict).toBe("block");

    // pushed, zero ahead → pass
    const repo = await makeRepo();
    const bare = `${repo}-remote.git`;
    await fxGit(["init", "--bare", "-b", "main", bare]);
    await fxGit(["remote", "add", "origin", bare], { cwd: repo });
    await fxGit(["push", "-u", "origin", "main"], { cwd: repo });
    await fxGit(["checkout", "-b", "pushed-clean"], { cwd: repo });
    await commitFile(repo, "p.txt", "p\n", "pushed commit");
    await fxGit(["push", "-u", "origin", "pushed-clean"], { cwd: repo });
    await fxGit(["checkout", "main"], { cwd: repo });
    const r2 = await guards(repo, "pushed-clean", {
      upstream: "refs/remotes/origin/pushed-clean",
    });
    const g2 = r2.guards.find((x) => x.name === "unpushed");
    expect(g2.verdict).toBe("pass");
  });

  test("unpushed: unknown when upstream is gone and disposability unproven", async () => {
    const repo = await withGoneUnpushedCommits(await makeRepo(), "gone-unpushed");
    const r = await guards(repo, "gone-unpushed", { evidence: { kind: "none" } });
    const g = r.guards.find((x) => x.name === "unpushed");
    expect(g.verdict).toBe("unknown");
    expect(r.verdict).toBe("unknown"); // unknown blocks
  });

  test("unpushed: passes when upstream gone but commits proven disposable (§3.2)", async () => {
    const repo = await withGoneUpstream(await makeRepo(), "gone-branch");
    const r = await guards(repo, "gone-branch", { evidence: { kind: "ancestor" } });
    const g = r.guards.find((x) => x.name === "unpushed");
    expect(g.verdict).toBe("pass");
  });

  test("unpushed: merged local branch with no upstream is disposable (§3.2)", async () => {
    const repo = await withMergedBranch(await makeRepo(), "merged-branch");
    const r = await guards(repo, "merged-branch", { evidence: { kind: "ancestor" } });
    const g = r.guards.find((x) => x.name === "unpushed");
    expect(g.verdict).toBe("pass");
    expect(r.verdict).toBe("pass");
  });

  test("unpushed: plain no-upstream branch is unknown (blocks) without proof", async () => {
    const repo = await withNoUpstreamBranch(await makeRepo(), "no-upstream");
    const r = await guards(repo, "no-upstream", { evidence: { kind: "none" } });
    expect(r.guards.find((x) => x.name === "unpushed").verdict).toBe("unknown");
  });

  test("combined verdict: any block wins over unknown, unknown wins over pass", async () => {
    // protected + gone-unproven → block (protected wins)
    const repo = await withProtectedBranches(await makeRepo(), ["develop"]);
    const r = await guards(repo, "develop");
    expect(r.verdict).toBe("block");

    // stale no-upstream unproven → unknown
    const repo2 = await withStaleBranch(await makeRepo(), 45, "stale-branch");
    const r2 = await guards(repo2, "stale-branch", { evidence: { kind: "none" } });
    expect(r2.verdict).toBe("unknown");

    // merged + default + protected all pass → pass
    const repo3 = await withMergedBranch(await makeRepo(), "merged-branch");
    const r3 = await guards(repo3, "merged-branch", { evidence: { kind: "ancestor" } });
    expect(r3.verdict).toBe("pass");
  });
});
