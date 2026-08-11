import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyRepo } from "../src/classify.js";
import { resolveRepo } from "../src/resolve.js";
import {
  git as fxGit,
  makeRepo,
  withActiveBranch,
  withGoneUnpushedCommits,
  withGoneUpstream,
  withMergedBranch,
  withNoDefault,
  withNoUpstreamBranch,
  withPatchEquivalentBranch,
  withProtectedBranches,
  withSquashMergedBranch,
  withStaleBranch,
  withUnpushedAhead,
} from "./fixtures.js";

async function commitFile(repo, name, content, msg) {
  writeFileSync(join(repo, name), content);
  await fxGit(["add", name], { cwd: repo });
  await fxGit(["commit", "-m", msg], { cwd: repo });
}

// gone AND ancestor of main → deletion-eligible
async function withGoneMergedBranch(repo) {
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
  return repo;
}

async function classify(repo, opts = {}) {
  const resolved = await resolveRepo(repo, opts);
  return classifyRepo(repo, { resolved, staleDays: 30, ...opts });
}

function byName(branches, name) {
  const b = branches.find((x) => x.name === name);
  if (!b) throw new Error(`branch ${name} not classified`);
  return b;
}

describe("classifyRepo truth table", () => {
  test("merged branch → merged, eligible", async () => {
    const repo = await withMergedBranch(await makeRepo());
    const b = byName(await classify(repo), "merged-branch");
    expect(b.class).toBe("merged");
    expect(b.eligible).toBe(true);
  });

  test("default branch itself → default, never eligible", async () => {
    const repo = await makeRepo();
    const b = byName(await classify(repo), "main");
    expect(b.class).toBe("default");
    expect(b.eligible).toBe(false);
  });

  test("protected names → protected, never eligible (release/* one level)", async () => {
    const repo = await withProtectedBranches(await makeRepo());
    const branches = await classify(repo);
    expect(byName(branches, "develop").class).toBe("protected");
    expect(byName(branches, "release/1.0").class).toBe("protected");
    expect(byName(branches, "develop").eligible).toBe(false);
  });

  test("stale branch → stale, shown but not eligible", async () => {
    const repo = await withStaleBranch(await makeRepo(), 45);
    const b = byName(await classify(repo), "stale-branch");
    expect(b.class).toBe("stale");
    expect(b.eligible).toBe(false);
    expect(b.ageDays).toBeGreaterThanOrEqual(45);
  });

  test("active branch → active", async () => {
    const repo = await withActiveBranch(await makeRepo());
    expect(byName(await classify(repo), "active-branch").class).toBe("active");
  });

  test("gone without proof → gone, NOT eligible", async () => {
    const repo = await withGoneUpstream(await makeRepo());
    const b = byName(await classify(repo), "gone-branch");
    expect(b.class).toBe("gone");
    expect(b.eligible).toBe(false);
  });

  test("gone with unpushed local commits → gone, NOT eligible", async () => {
    const repo = await withGoneUnpushedCommits(await makeRepo());
    const b = byName(await classify(repo), "gone-unpushed");
    expect(b.class).toBe("gone");
    expect(b.eligible).toBe(false);
  });

  test("gone + ancestor proof → gone, eligible", async () => {
    const repo = await withGoneMergedBranch(await makeRepo());
    const b = byName(await classify(repo), "gone-merged");
    expect(b.class).toBe("gone");
    expect(b.eligible).toBe(true);
    expect(b.evidence.kind).toBe("ancestor");
  });

  test("gone + host-verified merged PR → eligible", async () => {
    const repo = await withGoneUpstream(await makeRepo());
    const branches = await classify(repo, {
      hostVerdicts: { "gone-branch": { verdict: "merged", evidence: { prId: 42 } } },
    });
    const b = byName(branches, "gone-branch");
    expect(b.eligible).toBe(true);
    expect(b.evidence.kind).toBe("host");
  });

  test("no-upstream branch → active (not gone)", async () => {
    const repo = await withNoUpstreamBranch(await makeRepo());
    expect(byName(await classify(repo), "no-upstream").class).toBe("active");
  });

  test("unpushed-ahead branch → active", async () => {
    const repo = await withUnpushedAhead(await makeRepo());
    expect(byName(await classify(repo), "ahead-branch").class).toBe("active");
  });

  test("single-commit squash → patch-equivalent offline (advisory, not eligible)", async () => {
    const repo = await withSquashMergedBranch(await makeRepo());
    const b = byName(await classify(repo), "squash-merged");
    expect(b.class).toBe("patch-equivalent");
    expect(b.eligible).toBe(false);
  });

  test("multi-commit squash → NOT caught offline (active), proving API need", async () => {
    const repo = await makeRepo();
    await fxGit(["checkout", "-b", "multi-squash"], { cwd: repo });
    await commitFile(repo, "s1.txt", "one\n", "squash part 1");
    await commitFile(repo, "s2.txt", "two\n", "squash part 2");
    await fxGit(["checkout", "main"], { cwd: repo });
    await fxGit(["merge", "--squash", "multi-squash"], { cwd: repo });
    await fxGit(["commit", "-m", "squash: multi-squash (#1)"], { cwd: repo });
    const b = byName(await classify(repo), "multi-squash");
    expect(b.class).toBe("active");
    expect(b.eligible).toBe(false);
  });

  test("squash-merged + host verdict → squash-merged, eligible", async () => {
    const repo = await withSquashMergedBranch(await makeRepo());
    const branches = await classify(repo, {
      hostVerdicts: { "squash-merged": { verdict: "merged", evidence: { prId: 7 } } },
    });
    const b = byName(branches, "squash-merged");
    expect(b.class).toBe("squash-merged");
    expect(b.eligible).toBe(true);
  });

  test("closed-unmerged PR → first-class, never eligible", async () => {
    const repo = await withActiveBranch(await makeRepo());
    const branches = await classify(repo, {
      hostVerdicts: { "active-branch": { verdict: "closed", evidence: { prId: 9 } } },
    });
    const b = byName(branches, "active-branch");
    expect(b.class).toBe("closed-unmerged");
    expect(b.eligible).toBe(false);
  });

  test("cherry-picked branch → patch-equivalent, advisory only", async () => {
    const repo = await withPatchEquivalentBranch(await makeRepo());
    const b = byName(await classify(repo), "patch-equiv");
    expect(b.class).toBe("patch-equivalent");
    expect(b.eligible).toBe(false);
  });

  test("no-default repo → merged/stale checks blocked, everything safe", async () => {
    const repo = await withNoDefault(await withStaleBranch(await makeRepo(), 60));
    const branches = await classify(repo);
    // stale-branch would be stale with a default; without one it must NOT
    // be classified stale/merged — conservative active
    for (const b of branches) {
      expect(["active", "default", "protected"]).toContain(b.class);
      expect(b.eligible).toBe(false);
    }
  });
});
