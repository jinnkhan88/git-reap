// CLI wiring: `run --yes` executes through the safety engine and
// `undo` restores. Uses a real fixture repo + isolated XDG data dir per test.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanup,
  git as fxGit,
  makeRepo,
  withMergedBranch,
  withNoUpstreamBranch,
} from "./fixtures.js";

async function runCli(args, { dataDir, root }) {
  const proc = Bun.spawn({
    cmd: ["bun", "run", "src/bin.js", ...args, "--root", root],
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, XDG_DATA_HOME: dataDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe("CLI run/undo", () => {
  let repo;
  let dataDir;
  beforeEach(async () => {
    repo = await makeRepo();
    dataDir = mkdtempSync(join(tmpdir(), "reap-cli-data-"));
    await withMergedBranch(repo, "feat/merged"); // ancestor of main → eligible
    await withNoUpstreamBranch(repo, "fix/unmerged"); // no proof → not eligible
  });
  afterEach(() => {
    cleanup(repo);
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("run without --yes refuses to execute", async () => {
    const { code, stderr } = await runCli(["run"], { dataDir, root: repo });
    expect(code).toBe(2);
    expect(stderr).toContain("--yes");
  });

  test("run --yes deletes only eligible branches and records a batch", async () => {
    const { code, stdout } = await runCli(["run", "--yes"], { dataDir, root: repo });
    expect(code).toBe(0);
    expect(stdout).toContain("feat/merged");
    expect(stdout).toContain("deleted");
    expect(stdout).toContain("batch");
    // merged branch gone, unmerged untouched
    const branches = Bun.spawnSync({
      cmd: ["git", "-C", repo, "branch"],
      stdout: "pipe",
    }).stdout.toString();
    expect(branches).not.toContain("feat/merged");
    expect(branches).toContain("fix/unmerged");
  });

  test("undo restores the deleted branch at its recorded SHA", async () => {
    await runCli(["run", "--yes"], { dataDir, root: repo });
    const { code, stdout } = await runCli(["undo"], { dataDir, root: repo });
    expect(code).toBe(0);
    expect(stdout).toContain("restored");
    const branches = Bun.spawnSync({
      cmd: ["git", "-C", repo, "branch"],
      stdout: "pipe",
    }).stdout.toString();
    expect(branches).toContain("feat/merged");
  });
});
