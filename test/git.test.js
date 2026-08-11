import { describe, expect, test } from "bun:test";
import { git, gitOk } from "../src/git.js";
import { cleanupAll, makeRepo, withMergedBranch, withStaleBranch } from "./fixtures.js";

describe("git wrapper", () => {
  test("runs with arg array, returns trimmed stdout", async () => {
    const repo = await makeRepo();
    const sha = await git(repo, ["rev-parse", "HEAD"]);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("gitOk reports exit status without throwing", async () => {
    const repo = await makeRepo();
    expect(await gitOk(repo, ["rev-parse", "--verify", "nonexistent-ref"])).toBe(false);
    expect(await gitOk(repo, ["rev-parse", "--verify", "HEAD"])).toBe(true);
  });

  test("throws GitError with stderr on failure", async () => {
    const repo = await makeRepo();
    const err = await git(repo, ["definitely-not-a-command"]).catch((e) => e);
    expect(err.name).toBe("GitError");
    expect(err.message.length).toBeGreaterThan(0);
  });

  test("forEachRef parses NUL-delimited records", async () => {
    const repo = await makeRepo();
    await withMergedBranch(repo);
    await withStaleBranch(repo, 45);
    const { forEachRef } = await import("../src/git.js");
    const refs = await forEachRef(repo, ["refname", "objectname", "upstream", "upstream:track"]);
    const names = refs.map((r) => r.refname);
    expect(names).toContain("refs/heads/main");
    expect(names).toContain("refs/heads/merged-branch");
    expect(names).toContain("refs/heads/stale-branch");
    const main = refs.find((r) => r.refname === "refs/heads/main");
    expect(main.objectname).toMatch(/^[0-9a-f]{40}$/);
  });

  test("revParse returns sha or null", async () => {
    const repo = await makeRepo();
    const { revParse } = await import("../src/git.js");
    expect(await revParse(repo, "HEAD")).toMatch(/^[0-9a-f]{40}$/);
    expect(await revParse(repo, "refs/heads/nope")).toBeNull();
  });

  test("isAncestor reflects merge topology", async () => {
    const repo = await makeRepo();
    await withMergedBranch(repo);
    const { isAncestor } = await import("../src/git.js");
    expect(await isAncestor(repo, "merged-branch", "main")).toBe(true);
    expect(await isAncestor(repo, "main", "merged-branch")).toBe(false);
  });
});
