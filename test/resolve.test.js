import { describe, expect, test } from "bun:test";
import { resolveRepo } from "../src/resolve.js";
import { git as fxGit, makeRepo, withNoDefault, withNonStandardDefault } from "./fixtures.js";

async function withOriginRemote(repo) {
  // local bare "remote" (default branch main) + symbolic HEAD published
  const bare = `${repo}-remote.git`;
  await fxGit(["init", "--bare", "-b", "main", bare]);
  await fxGit(["remote", "add", "origin", bare], { cwd: repo });
  await fxGit(["push", "-u", "origin", "main"], { cwd: repo });
  await fxGit(["remote", "set-head", "origin", "-a"], { cwd: repo });
  return bare;
}

describe("resolveRepo", () => {
  test("plain local repo resolves main via convention, no remote", async () => {
    const repo = await makeRepo();
    const r = await resolveRepo(repo);
    expect(r.status).toBe("ok");
    expect(r.defaultBranch).toBe("main");
    expect(r.defaultRef).toBe("refs/heads/main");
    expect(r.remote).toBeNull();
    expect(r.lastCommitTs).toBeGreaterThan(0);
  });

  test("remote symbolic HEAD wins over convention", async () => {
    const repo = await makeRepo();
    await withOriginRemote(repo);
    // rename local main so ONLY the remote HEAD can identify the default
    await fxGit(["branch", "-m", "main", "local-only-name"], { cwd: repo });
    const r = await resolveRepo(repo);
    expect(r.status).toBe("ok");
    expect(r.remote).toBe("origin");
    expect(r.defaultBranch).toBe("main");
    expect(r.defaultRef).toBe("refs/remotes/origin/main");
  });

  test("explicit config beats everything", async () => {
    const repo = await makeRepo();
    await withNonStandardDefault(repo, "trunk");
    const r = await resolveRepo(repo, { config: { defaultBranch: "trunk" } });
    expect(r.defaultBranch).toBe("trunk");
    expect(r.defaultRef).toBe("refs/heads/trunk");
  });

  test("non-standard default resolves via convention (trunk)", async () => {
    const repo = await makeRepo();
    await withNonStandardDefault(repo, "trunk");
    const r = await resolveRepo(repo);
    expect(r.status).toBe("ok");
    expect(r.defaultBranch).toBe("trunk");
  });

  test("no main/master/trunk and no remote HEAD → no-default safe failure", async () => {
    const repo = await makeRepo();
    await withNoDefault(repo);
    const r = await resolveRepo(repo);
    expect(r.status).toBe("no-default");
    expect(r.defaultBranch).toBeNull();
    expect(r.defaultRef).toBeNull();
  });
});
