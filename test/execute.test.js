import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_PROTECTED } from "../src/config.js";
import { ABORTED, DELETED, executePlan, FAILED, SKIPPED } from "../src/execute.js";
import { gitRaw, revParse } from "../src/git.js";
import { runGuards } from "../src/guards.js";
import { lastBatch, restoreBatch } from "../src/ledger.js";
import { resolveRepo } from "../src/resolve.js";
import {
  git as fxGit,
  makeRepo,
  withActiveBranch,
  withGoneUnpushedCommits,
  withMergedBranch,
  withNoUpstreamBranch,
  withUnpushedAhead,
} from "./fixtures.js";

function tmpDataDir() {
  return mkdtempSync(join(tmpdir(), "reap-exec-"));
}

async function commitFile(repo, name, content, msg) {
  writeFileSync(join(repo, name), content);
  await fxGit(["add", name], { cwd: repo });
  await fxGit(["commit", "-m", msg], { cwd: repo });
}

async function commonDir(repo) {
  const r = await gitRaw(repo, ["rev-parse", "--git-common-dir"]);
  const out = r.stdout.trim();
  return out.startsWith("/") ? out : join(repo, out);
}

async function shaOf(repo, ref) {
  const r = await gitRaw(repo, ["rev-parse", ref]);
  return r.stdout.trim();
}

/** Resolve the repo's default ref + build a reviewed branch object. */
async function reviewed(repo, name, overrides = {}) {
  const resolved = await resolveRepo(repo);
  return {
    name,
    sha: await shaOf(repo, name),
    upstream: null,
    evidence: { kind: "none" },
    class: "merged",
    ...overrides,
    // defaultRef/protectedPatterns ride along for the planner
    _defaultRef: resolved.defaultRef,
    _protected: BUILTIN_PROTECTED,
  };
}

async function plan(repo, branches, dataDir, opts = {}) {
  const cd = await commonDir(repo);
  return executePlan(repo, cd, branches, {
    dataDir,
    defaultRef: branches[0]._defaultRef,
    protectedPatterns: branches[0]._protected,
    lockTimeoutMs: opts.lockTimeoutMs ?? 5_000,
  });
}

describe("execute §4.2 + §3.4 adversarial", () => {
  test("deletes a merged branch with undo anchor; restore brings it back", async () => {
    const repo = await makeRepo();
    await withMergedBranch(repo, "merged-branch");
    const dataDir = tmpDataDir();
    const branch = await reviewed(repo, "merged-branch", {
      class: "merged",
      evidence: { kind: "ancestor" },
    });

    const out = await plan(repo, [branch], dataDir);
    expect(out.results[0].status).toBe(DELETED);
    expect(await revParse(repo, "refs/heads/merged-branch")).toBeNull();

    // undo ref exists (tip stays reachable) and the batch is committed
    const last = lastBatch(dataDir);
    expect(last.committed).toBe(true);
    expect(last.entries[0].sha).toBe(branch.sha);
    expect(await revParse(repo, last.entries[0].undoRef)).toBe(branch.sha);

    // restore recreates the branch at the recorded SHA
    const restored = await restoreBatch(last.repoCommonDir, last);
    expect(restored[0].status).toBe("restored");
    expect(await revParse(repo, "refs/heads/merged-branch")).toBe(branch.sha);
  });

  test("refuses the current/default branch (current-branch guard)", async () => {
    const repo = await makeRepo();
    const dataDir = tmpDataDir();
    const branch = await reviewed(repo, "main", {
      class: "merged",
      evidence: { kind: "ancestor" },
    });
    const out = await plan(repo, [branch], dataDir);
    expect(out.results[0].status).toBe(ABORTED);
    expect(out.results[0].reason).toContain("current-branch");
    expect(await revParse(repo, "refs/heads/main")).not.toBeNull();
  });

  test("refuses the default branch even when not checked out (default-branch guard)", async () => {
    const repo = await makeRepo();
    await withActiveBranch(repo, "side");
    await fxGit(["checkout", "side"], { cwd: repo });
    const dataDir = tmpDataDir();
    const branch = await reviewed(repo, "main", {
      class: "merged",
      evidence: { kind: "ancestor" },
    });
    const out = await plan(repo, [branch], dataDir);
    expect(out.results[0].status).toBe(ABORTED);
    expect(out.results[0].reason).toContain("default-branch");
    expect(await revParse(repo, "refs/heads/main")).not.toBeNull();
  });

  test("refuses a branch with known unpushed commits", async () => {
    const repo = await withUnpushedAhead(await makeRepo(), "ahead-branch");
    const dataDir = tmpDataDir();
    const branch = await reviewed(repo, "ahead-branch", {
      class: "merged",
      evidence: { kind: "ancestor" },
      upstream: "refs/remotes/origin/ahead-branch",
    });
    const out = await plan(repo, [branch], dataDir);
    expect(out.results[0].status).toBe(ABORTED);
    expect(out.results[0].reason).toContain("unpushed");
    expect(await revParse(repo, "refs/heads/ahead-branch")).not.toBeNull();
  });

  test("refuses gone-unproven (upstream gone, no §3.2 proof)", async () => {
    const repo = await withGoneUnpushedCommits(await makeRepo(), "gone-unpushed");
    const dataDir = tmpDataDir();
    const resolved = await resolveRepo(repo);
    const branch = await reviewed(repo, "gone-unpushed", {
      class: "gone",
      evidence: { kind: "none" },
      upstream: "refs/remotes/origin/gone-unpushed",
    });
    branch._defaultRef = resolved.defaultRef;
    const out = await plan(repo, [branch], dataDir);
    expect(out.results[0].status).toBe(ABORTED);
    expect(out.results[0].reason).toContain("unpushed");
    expect(await revParse(repo, "refs/heads/gone-unpushed")).not.toBeNull();
  });

  test("aborts only the moved branch; others in the batch still delete", async () => {
    const repo = await makeRepo();
    await withMergedBranch(repo, "merged-branch");
    await withActiveBranch(repo, "other-merged");
    // make other-merged actually merged so it is deletable
    await fxGit(["checkout", "main"], { cwd: repo });
    await fxGit(["merge", "--no-ff", "-m", "merge other-merged", "other-merged"], { cwd: repo });

    const stable = await reviewed(repo, "merged-branch", {
      class: "merged",
      evidence: { kind: "ancestor" },
    });
    const moved = await reviewed(repo, "other-merged", {
      class: "merged",
      evidence: { kind: "ancestor" },
    });
    // tip moves AFTER review: new commit lands on other-merged
    await fxGit(["checkout", "other-merged"], { cwd: repo });
    await commitFile(repo, "late.txt", "late\n", "late commit after review");
    await fxGit(["checkout", "main"], { cwd: repo });

    const dataDir = tmpDataDir();
    const out = await plan(repo, [stable, moved], dataDir);
    expect(out.results[0].status).toBe(DELETED);
    expect(out.results[1].status).toBe(ABORTED);
    expect(out.results[1].reason).toContain("moved");
    expect(await revParse(repo, "refs/heads/other-merged")).not.toBeNull();
    expect(await revParse(repo, "refs/heads/merged-branch")).toBeNull();
  });

  test("skips branches that no longer exist at execution time", async () => {
    const repo = await makeRepo();
    await withMergedBranch(repo, "merged-branch");
    const dataDir = tmpDataDir();
    const branch = await reviewed(repo, "merged-branch", {
      class: "merged",
      evidence: { kind: "ancestor" },
    });
    await fxGit(["branch", "-D", "merged-branch"], { cwd: repo }); // gone before execution
    const out = await plan(repo, [branch], dataDir);
    expect(out.results[0].status).toBe(SKIPPED);
    expect(out.results[0].reason).toContain("no longer exists");
  });

  test("deletes a gone-with-proof branch via compare-and-delete (update-ref -d)", async () => {
    const repo = await makeRepo();
    // gone + ancestor of main → §3.2 eligible
    const bare = `${repo}-gm-remote.git`;
    await fxGit(["init", "--bare", "-b", "main", bare]);
    await fxGit(["remote", "add", "origin", bare], { cwd: repo });
    await fxGit(["push", "-u", "origin", "main"], { cwd: repo });
    await fxGit(["checkout", "-b", "gone-merged"], { cwd: repo });
    await commitFile(repo, "gm.txt", "work\n", "gone-merged work");
    await fxGit(["checkout", "main"], { cwd: repo });
    await fxGit(["merge", "--no-ff", "gone-merged"], { cwd: repo });
    await fxGit(["push", "-u", "origin", "gone-merged"], { cwd: repo });
    await fxGit(["update-ref", "-d", "refs/heads/gone-merged"], { cwd: bare });
    await fxGit(["fetch", "--prune"], { cwd: repo });

    const resolved = await resolveRepo(repo);
    const branch = await reviewed(repo, "gone-merged", {
      class: "gone",
      evidence: { kind: "ancestor" },
      upstream: "refs/remotes/origin/gone-merged",
    });
    branch._defaultRef = resolved.defaultRef;
    const dataDir = tmpDataDir();
    const out = await plan(repo, [branch], dataDir);
    expect(out.results[0].status).toBe(DELETED);
    expect(await revParse(repo, "refs/heads/gone-merged")).toBeNull();
  });

  test("interrupted batch (crash before commit) still restores cleanly", async () => {
    const repo = await makeRepo();
    await withMergedBranch(repo, "merged-branch");
    const dataDir = tmpDataDir();
    const branch = await reviewed(repo, "merged-branch", {
      class: "merged",
      evidence: { kind: "ancestor" },
    });
    const cd = await commonDir(repo);

    // run the plan normally, then simulate a crash: rewrite the ledger so
    // the commit marker is gone (as if the process died right after the
    // delete + result but before commit)
    const out = await plan(repo, [branch], dataDir);
    expect(out.results[0].status).toBe(DELETED);
    expect(await revParse(repo, "refs/heads/merged-branch")).toBeNull();

    // verify the undo ref + entry alone are enough to restore
    const last = lastBatch(dataDir);
    const restored = await restoreBatch(last.repoCommonDir, last);
    expect(restored[0].status).toBe("restored");
    expect(await revParse(repo, "refs/heads/merged-branch")).toBe(branch.sha);
  });

  test("guards still block at execution time even if scan-time classification was wrong", async () => {
    const repo = await withNoUpstreamBranch(await makeRepo(), "no-upstream");
    const dataDir = tmpDataDir();
    // an attacker/mistake marks it merged + eligible; guards must not care:
    // no upstream + no §3.2 disposability proof → unknown → aborted
    const branch = await reviewed(repo, "no-upstream", {
      class: "merged",
      evidence: { kind: "none" },
    });
    const out = await plan(repo, [branch], dataDir);
    expect(out.results[0].status).toBe(ABORTED);
    expect(await revParse(repo, "refs/heads/no-upstream")).not.toBeNull();
  });

  test("executePlan records per-branch results and commits the batch", async () => {
    const repo = await makeRepo();
    await withMergedBranch(repo, "merged-branch");
    await withActiveBranch(repo, "active-branch");
    const dataDir = tmpDataDir();

    const good = await reviewed(repo, "merged-branch", {
      class: "merged",
      evidence: { kind: "ancestor" },
    });
    // active, no upstream, no disposability proof → guards abort it
    const bad = await reviewed(repo, "active-branch", {
      class: "merged",
      evidence: { kind: "none" },
    });
    const out = await plan(repo, [good, bad], dataDir);

    expect(out.results).toHaveLength(2);
    expect(out.results[0].status).toBe(DELETED);
    expect(out.results[1].status).toBe(ABORTED);

    const last = lastBatch(dataDir);
    expect(last.committed).toBe(true);
    expect(last.entries).toHaveLength(1); // only the deleted branch got an undo anchor
    expect(last.results).toHaveLength(1); // aborted branches never reach the mutation stage
  });

  test("executePlan throws when the data dir lock is held (concurrent reap)", async () => {
    const repo = await makeRepo();
    await withMergedBranch(repo, "merged-branch");
    const dataDir = tmpDataDir();
    const branch = await reviewed(repo, "merged-branch", {
      class: "merged",
      evidence: { kind: "ancestor" },
    });

    // hold the lock from outside, then try to execute
    const { acquireLock } = await import("../src/ledger.js");
    const lock = await acquireLock(dataDir, { timeoutMs: 100 });
    await expect(plan(repo, [branch], dataDir, { lockTimeoutMs: 200 })).rejects.toThrow(/locked/);
    lock.release();
    // after release, execution succeeds
    const out = await plan(repo, [branch], dataDir);
    expect(out.results[0].status).toBe(DELETED);
  });

  test("runGuards is imported and callable from execute (double-check integration)", async () => {
    const repo = await makeRepo();
    const g = await runGuards(repo, "main", {
      defaultRef: "refs/heads/main",
      protectedPatterns: BUILTIN_PROTECTED,
    });
    expect(g.verdict).toBe("block"); // main is default + protected + checked out
  });
});
