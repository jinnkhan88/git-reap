import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRepos } from "../src/discover.js";
import {
  git as fxGit,
  makeBareRepo,
  makeRepo,
  makeSandbox,
  withLinkedWorktree,
} from "./fixtures.js";

function tmpRoot() {
  // realpath so expectations match what git reports: on macOS the temp
  // dir lives under /var/folders, which git canonicalizes to
  // /private/var/folders.
  return realpathSync(mkdtempSync(join(tmpdir(), "reap-disc-")));
}

describe("discoverRepos", () => {
  test("finds repos under a root; bare repos reported as skipped", async () => {
    const sandbox = await makeSandbox();
    const { repos, skipped } = await discoverRepos([sandbox.root]);
    const names = repos.map((r) => r.path.split("/").pop());
    expect(names).toContain("repo-normal");
    expect(names).toContain("repo-gone");
    expect(names).toContain("repo-no-default");
    expect(names).toContain("repo-deep"); // nested/repo-deep
    expect(repos.every((r) => !r.bare)).toBe(true);
    expect(skipped.some((s) => s.reason === "bare")).toBe(true);
  });

  test("records linked worktrees via plumbing even outside the root", async () => {
    const root = tmpRoot();
    const repo = await makeRepo({ dir: join(root, "main-repo") });
    const { worktree } = await withLinkedWorktree(repo);
    const { repos } = await discoverRepos([root]);
    expect(repos).toHaveLength(1);
    expect(repos[0].path).toBe(repo);
    expect(repos[0].worktrees).toContain(repo);
    expect(repos[0].worktrees).toContain(worktree);
  });

  test("dedupes when both main repo and linked worktree are under the root", async () => {
    const root = tmpRoot();
    const repo = await makeRepo({ dir: join(root, "main-repo") });
    await fxGit(["branch", "wt-branch"], { cwd: repo });
    const wt = join(root, "wt-copy");
    await fxGit(["worktree", "add", wt, "wt-branch"], { cwd: repo });
    const { repos } = await discoverRepos([root]);
    const matches = repos.filter((r) => r.worktrees.includes(repo) || r.worktrees.includes(wt));
    expect(matches).toHaveLength(1);
    expect(matches[0].worktrees.sort()).toEqual([repo, wt].sort());
  });

  test("does not descend into junk dirs", async () => {
    const root = tmpRoot();
    const junk = join(root, "node_modules");
    mkdirSync(junk, { recursive: true });
    await makeRepo({ dir: join(junk, "hidden-repo") });
    const { repos } = await discoverRepos([root]);
    expect(repos.map((r) => r.path)).not.toContain(join(junk, "hidden-repo"));
  });

  test("prunes heavy tool/cache dotdirs but still searches config/state dirs", async () => {
    const root = tmpRoot();
    for (const dotdir of [".bun", ".cache"]) {
      mkdirSync(join(root, dotdir), { recursive: true });
      await makeRepo({ dir: join(root, dotdir, "hidden-repo") });
    }
    // these CAN legitimately hold repos and must stay in the walk
    await makeRepo({ dir: join(root, ".config", "nvim") });
    await makeRepo({ dir: join(root, ".dotfiles", "home", "projects", "notes") });
    const { repos } = await discoverRepos([root]);
    const paths = repos.map((r) => r.path);
    expect(paths).toContain(join(root, ".config", "nvim"));
    expect(paths).toContain(join(root, ".dotfiles", "home", "projects", "notes"));
    expect(paths.some((p) => p.includes(".bun"))).toBe(false);
    expect(paths.some((p) => p.includes(".cache"))).toBe(false);
  });

  test("submodule checkouts surface as their real directory, never a .git path", async () => {
    const root = tmpRoot();
    const sub = await makeRepo({ dir: join(root, "sub-src") });
    const parent = await makeRepo({ dir: join(root, "parent") });
    // NB: "vendor/" is a junk dir by design — submodules there are not walked
    await fxGit(["-c", "protocol.file.allow=always", "submodule", "add", sub, "libs/sub"], {
      cwd: parent,
    });
    const { repos } = await discoverRepos([root]);
    const paths = repos.map((r) => r.path);
    // git reports a submodule's worktree as its .git/modules/<name> gitdir;
    // discover must map that back to the real checkout directory
    expect(paths.every((p) => !p.includes("/.git/"))).toBe(true);
    expect(paths).toContain(join(parent, "libs", "sub"));
  });

  test("does not follow symlinked directories", async () => {
    const root = tmpRoot();
    const outside = await makeRepo();
    symlinkSync(outside, join(root, "linked-outside"));
    const { repos } = await discoverRepos([root]);
    expect(repos.map((r) => r.path)).not.toContain(join(root, "linked-outside"));
  });

  test("respects depth limit", async () => {
    const root = tmpRoot();
    let deep = root;
    for (let i = 0; i < 8; i++) {
      deep = join(deep, `d${i}`);
      mkdirSync(deep, { recursive: true });
    }
    await makeRepo({ dir: join(deep, "deep-repo") });
    const shallow = await discoverRepos([root], { maxDepth: 4 });
    expect(shallow.repos.map((r) => r.path)).not.toContain(join(deep, "deep-repo"));
    const deepEnough = await discoverRepos([root], { maxDepth: 12 });
    expect(deepEnough.repos.map((r) => r.path)).toContain(join(deep, "deep-repo"));
  });

  test("missing root is reported, not fatal", async () => {
    const { repos, skipped } = await discoverRepos(["/definitely/not/here"]);
    expect(repos).toEqual([]);
    expect(skipped.some((s) => s.path === "/definitely/not/here")).toBe(true);
  });
});
