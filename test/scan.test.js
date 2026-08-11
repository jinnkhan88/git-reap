import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scan } from "../src/scan.js";
import { git as fxGit, makeRepo, makeSandbox, withGoneUpstream } from "./fixtures.js";

async function commitFile(repo, name, content, msg) {
  writeFileSync(join(repo, name), content);
  await fxGit(["add", name], { cwd: repo });
  await fxGit(["commit", "-m", msg], { cwd: repo });
}

// gone-upstream WITHOUT the prune: local tracking ref lingers until --fetch
async function withUnprunedGone(repo, branch = "unpruned-gone") {
  const bare = `${repo}-up-remote.git`;
  await fxGit(["init", "--bare", "-b", "main", bare]);
  await fxGit(["remote", "add", "origin", bare], { cwd: repo });
  await fxGit(["push", "-u", "origin", "main"], { cwd: repo });
  await fxGit(["checkout", "-b", branch], { cwd: repo });
  await commitFile(repo, "up.txt", "work\n", `${branch} work`);
  await fxGit(["push", "-u", "origin", branch], { cwd: repo });
  await fxGit(["checkout", "main"], { cwd: repo });
  await fxGit(["update-ref", "-d", `refs/heads/${branch}`], { cwd: bare });
  return repo; // no fetch --prune
}

describe("scan", () => {
  test("end-to-end over the sandbox: classification per repo, bare skipped", async () => {
    const sandbox = await makeSandbox();
    const r = await scan({ roots: [sandbox.root], staleDays: 30 });
    const byPath = Object.fromEntries(r.repos.map((x) => [x.path, x]));

    const normal = byPath[sandbox.repos.normal];
    const classes = Object.fromEntries(normal.branches.map((b) => [b.name, b.class]));
    expect(classes["merged-branch"]).toBe("merged");
    expect(classes["stale-branch"]).toBe("stale");
    expect(normal.defaultBranch).toBe("main");

    const gone = byPath[sandbox.repos.gone];
    expect(gone.branches.find((b) => b.name === "gone-branch").class).toBe("gone");

    const noDefault = byPath[sandbox.repos.noDefault];
    expect(noDefault.status).toBe("no-default");
    expect(noDefault.branches.every((b) => !b.eligible)).toBe(true);

    expect(r.skipped.some((s) => s.reason === "bare")).toBe(true);
    expect(r.fetched).toBe(false);
  });

  test("single-repo mode", async () => {
    const repo = await withGoneUpstream(await makeRepo());
    const r = await scan({ repo });
    expect(r.repos).toHaveLength(1);
    expect(r.repos[0].branches.find((b) => b.name === "gone-branch").class).toBe("gone");
  });

  test("--fetch prunes before classifying; without it the branch is not gone", async () => {
    const repoA = await withUnprunedGone(await makeRepo());
    const noFetch = await scan({ repo: repoA });
    expect(noFetch.repos[0].branches.find((b) => b.name === "unpruned-gone").class).not.toBe(
      "gone",
    );
    expect(noFetch.fetched).toBe(false);

    const repoB = await withUnprunedGone(await makeRepo());
    const withFetch = await scan({ repo: repoB, fetch: true });
    expect(withFetch.repos[0].branches.find((b) => b.name === "unpruned-gone").class).toBe("gone");
    expect(withFetch.fetched).toBe(true);
  });

  test("fetch failure is a warning, not fatal", async () => {
    const repo = await withUnprunedGone(await makeRepo());
    // break the remote
    await fxGit(["remote", "set-url", "origin", "/nonexistent/remote.git"], { cwd: repo });
    const r = await scan({ repo, fetch: true });
    expect(r.repos).toHaveLength(1);
    expect(r.repos[0].warnings.some((w) => w.includes("fetch"))).toBe(true);
  });
});
