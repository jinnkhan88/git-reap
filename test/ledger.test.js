import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gitRaw, revParse } from "../src/git.js";
import {
  acquireLock,
  beginBatch,
  createUndoRef,
  defaultDataDir,
  lastBatch,
  ledgerPaths,
  listBatches,
  listDeleted,
  newBatchId,
  purgeBatch,
  restoreBatch,
  undoRefFor,
} from "../src/ledger.js";
import { git as fxGit, makeRepo, withActiveBranch, withMergedBranch } from "./fixtures.js";

function tmpDataDir() {
  const dir = mkdtempSync(join(tmpdir(), "reap-ledger-"));
  return dir;
}

async function repoCommonDir(repo) {
  const r = await gitRaw(repo, ["rev-parse", "--git-common-dir"]);
  const out = r.stdout.trim();
  // git may return a path relative to the repo; make it absolute so git
  // commands run with the right cwd no matter where the test process is
  return resolve(repo, out);
}

describe("ledger §4.3", () => {
  test("begin/entry/commit writes a committed batch readable back", async () => {
    const dataDir = tmpDataDir();
    const batch = await beginBatch(dataDir, "/repo/.git", { batchId: "b1" });
    batch.entry("feat/x", "abc123", undoRefFor("b1", "feat/x"));
    batch.result("feat/x", "deleted");
    batch.commit();

    const last = lastBatch(dataDir);
    expect(last.batchId).toBe("b1");
    expect(last.committed).toBe(true);
    expect(last.repoCommonDir).toBe("/repo/.git");
    expect(last.entries).toEqual([
      { branch: "feat/x", sha: "abc123", undoRef: "refs/git-reap/undo/b1/feat%2Fx" },
    ]);
    expect(last.results).toEqual([{ branch: "feat/x", status: "deleted", reason: null }]);
  });

  test("interrupted batch (no commit marker) is still readable and restorable", async () => {
    const dataDir = tmpDataDir();
    const batch = await beginBatch(dataDir, "/repo/.git", { batchId: "crash" });
    batch.entry("feat/x", "abc123", undoRefFor("crash", "feat/x"));
    batch.result("feat/x", "deleted");
    // simulate crash: never commit, release lock via abort
    batch.abort();

    const last = lastBatch(dataDir);
    expect(last.batchId).toBe("crash");
    expect(last.committed).toBe(false);
    expect(last.entries).toHaveLength(1);
  });

  test("file lock serializes; stale lock from a dead pid is stolen", async () => {
    const dataDir = tmpDataDir();
    const a = await acquireLock(dataDir, { timeoutMs: 100 });
    await expect(acquireLock(dataDir, { timeoutMs: 100 })).rejects.toThrow(/locked/);
    a.release();
    // stale lock with a dead pid (impossible pid) → stolen
    const { lock } = ledgerPaths(dataDir);
    writeFileSync(lock, "999999999\n");
    const b = await acquireLock(dataDir, { timeoutMs: 200 });
    b.release();
    expect(existsSync(lock)).toBe(false);
  });

  test("ledger lines are fsync'd before any ref deletion (write-ahead)", async () => {
    const dataDir = tmpDataDir();
    const batch = await beginBatch(dataDir, "/repo/.git", { batchId: "wa" });
    batch.entry("feat/x", "abc123", undoRefFor("wa", "feat/x"));
    // the entry must already be on disk before the caller deletes any ref
    const raw = readFileSync(join(dataDir, "ledger.jsonl"), "utf8");
    expect(raw).toContain('"e":"entry"');
    expect(raw).toContain('"n":"feat/x"');
    batch.commit();
  });

  test("createUndoRef makes the tip reachable under the undo namespace", async () => {
    const repo = await makeRepo();
    const { stdout: sha } = await fxGit(["rev-parse", "main"], { cwd: repo });
    const batchId = newBatchId();
    const ref = await createUndoRef(repo, batchId, "main", sha.trim());
    expect(ref).toBe(undoRefFor(batchId, "main"));
    const reread = await revParse(repo, ref);
    expect(reread).toBe(sha.trim());
  });

  test("restore recreates a deleted branch at the recorded SHA", async () => {
    const repo = await makeRepo();
    await withMergedBranch(repo, "merged-branch");
    const commonDir = await repoCommonDir(repo);
    const { stdout: sha } = await fxGit(["rev-parse", "merged-branch"], { cwd: repo });
    const dataDir = tmpDataDir();

    const batch = await beginBatch(dataDir, commonDir, { batchId: "r1" });
    const ref = await createUndoRef(repo, "r1", "merged-branch", sha.trim());
    batch.entry("merged-branch", sha.trim(), ref);
    await fxGit(["branch", "-D", "merged-branch"], { cwd: repo });
    expect(await revParse(repo, "refs/heads/merged-branch")).toBeNull();
    batch.commit();

    const results = await restoreBatch(commonDir, lastBatch(dataDir));
    expect(results).toEqual([{ branch: "merged-branch", sha: sha.trim(), status: "restored" }]);
    expect(await revParse(repo, "refs/heads/merged-branch")).toBe(sha.trim());
  });

  test("restore refuses to overwrite a branch that exists at a different SHA", async () => {
    const repo = await makeRepo();
    await withMergedBranch(repo, "merged-branch");
    const commonDir = await repoCommonDir(repo);
    const { stdout: oldSha } = await fxGit(["rev-parse", "merged-branch"], { cwd: repo });
    const dataDir = tmpDataDir();

    const batch = await beginBatch(dataDir, commonDir, { batchId: "r2" });
    const ref = await createUndoRef(repo, "r2", "merged-branch", oldSha.trim());
    batch.entry("merged-branch", oldSha.trim(), ref);
    await fxGit(["branch", "-D", "merged-branch"], { cwd: repo });
    // someone creates a NEW branch with the same name at a different tip
    await fxGit(["checkout", "-b", "merged-branch", "main"], { cwd: repo });
    await fxGit(["checkout", "main"], { cwd: repo });
    batch.commit();

    const results = await restoreBatch(commonDir, lastBatch(dataDir));
    expect(results[0].status).toBe("refused");
    expect(results[0].reason).toContain("different SHA");
    // the new branch is untouched
    expect(await revParse(repo, "refs/heads/merged-branch")).not.toBe(oldSha.trim());
  });

  test("restore reports 'already' when the branch already sits at the recorded SHA", async () => {
    const repo = await makeRepo();
    await withMergedBranch(repo, "merged-branch");
    const commonDir = await repoCommonDir(repo);
    const { stdout: sha } = await fxGit(["rev-parse", "merged-branch"], { cwd: repo });
    const dataDir = tmpDataDir();

    const batch = await beginBatch(dataDir, commonDir, { batchId: "r3" });
    const ref = await createUndoRef(repo, "r3", "merged-branch", sha.trim());
    batch.entry("merged-branch", sha.trim(), ref);
    batch.commit();

    const results = await restoreBatch(commonDir, lastBatch(dataDir));
    expect(results[0].status).toBe("already");
  });

  test("purgeBatch removes the hidden undo refs", async () => {
    const repo = await makeRepo();
    const commonDir = await repoCommonDir(repo);
    const { stdout: sha } = await fxGit(["rev-parse", "main"], { cwd: repo });
    const batchId = newBatchId();
    const ref = await createUndoRef(repo, batchId, "main", sha.trim());
    expect(await revParse(repo, ref)).not.toBeNull();

    const batch = { entries: [{ undoRef: ref }] };
    const removed = await purgeBatch(commonDir, batch);
    expect(removed).toBe(1);
    expect(await revParse(repo, ref)).toBeNull();
  });

  test("listBatches returns batches oldest-first with commit flags", async () => {
    const dataDir = tmpDataDir();
    const b1 = await beginBatch(dataDir, "/r1/.git", { batchId: "one" });
    b1.commit();
    const b2 = await beginBatch(dataDir, "/r2/.git", { batchId: "two" });
    b2.entry("x", "s", "refs/git-reap/undo/two/x");
    b2.abort(); // interrupted

    const batches = listBatches(dataDir);
    expect(batches.map((b) => b.batchId)).toEqual(["one", "two"]);
    expect(batches[0].committed).toBe(true);
    expect(batches[1].committed).toBe(false);
  });

  test("default data dir resolves to the platform data location", () => {
    // XDG paths are posix-style; force linux so the assertion holds on every OS.
    const dir = defaultDataDir(
      { HOME: "/tmp/fake-home", XDG_DATA_HOME: "/tmp/fake-data" },
      "linux",
    );
    expect(dir).toBe("/tmp/fake-data/git-reap");
    expect(ledgerPaths(dir).ledger).toContain("ledger.jsonl");
  });

  test("listDeleted returns restorable rows with countdown", async () => {
    const repo = await makeRepo();
    await withMergedBranch(repo, "dead-a");
    const commonDir = await repoCommonDir(repo);
    const { stdout: sha } = await fxGit(["rev-parse", "dead-a"], { cwd: repo });
    const dataDir = tmpDataDir();

    const batch = await beginBatch(dataDir, commonDir, { batchId: "dl1" });
    const ref = await createUndoRef(repo, "dl1", "dead-a", sha.trim());
    batch.entry("dead-a", sha.trim(), ref);
    await fxGit(["branch", "-D", "dead-a"], { cwd: repo });
    batch.commit();

    const rows = listDeleted(dataDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      repoPath: commonDir,
      batchId: "dl1",
      branch: "dead-a",
      restorable: true,
    });
    expect(rows[0].daysLeft).toBeGreaterThan(0);
    expect(rows[0].daysLeft).toBeLessThanOrEqual(90);
  });

  test("listDeleted marks rows beyond retention as not restorable", async () => {
    const repo = await makeRepo();
    await withMergedBranch(repo, "dead-b");
    const commonDir = await repoCommonDir(repo);
    const { stdout: sha } = await fxGit(["rev-parse", "dead-b"], { cwd: repo });
    const dataDir = tmpDataDir();

    const batch = await beginBatch(dataDir, commonDir, { batchId: "dl2" });
    const ref = await createUndoRef(repo, "dl2", "dead-b", sha.trim());
    batch.entry("dead-b", sha.trim(), ref);
    await fxGit(["branch", "-D", "dead-b"], { cwd: repo });
    batch.commit();

    // simulate 91 days later: expiry passed → not restorable
    const late = Date.now() + 91 * 86_400_000;
    const rows = listDeleted(dataDir, { now: () => late });
    expect(rows).toHaveLength(1);
    expect(rows[0].restorable).toBe(false);
    expect(rows[0].daysLeft).toBe(0);
  });
});
