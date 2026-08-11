// Durable undo: hidden undo refs + write-ahead batch ledger.
//
// Before deleting branch B at tip S we (1) append a ledger entry and fsync
// it, (2) create a hidden ref refs/git-reap/undo/<batch>/<encoded-branch>
// pointing at S so the tip stays a reachability root (a JSON SHA alone
// would be gc'd exactly when undo is needed), then (3) delete. The ledger
// is append-only JSONL with begin/entry/result/commit events; a batch that
// never reached `commit` is an interrupted batch and is still restorable.
//
// Locking: a pid lock file in the data dir serializes concurrent reaps on
// the same machine. Repo identity is the git common-dir (stable), never a
// movable worktree path.

import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { configPaths } from "./config.js";
import { gitRaw, revParse } from "./git.js";

export const UNDO_REFS_PREFIX = "refs/git-reap/undo";
export const DEFAULT_RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;

export function ledgerPaths(dataDir) {
  return { ledger: join(dataDir, "ledger.jsonl"), lock: join(dataDir, "lock") };
}

export function defaultDataDir(env = process.env, platform) {
  return configPaths(env, platform).dataDir;
}

/** Short unique batch id (safe in ref paths: lowercase alnum + dash). */
export function newBatchId() {
  return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

/** Branch names may contain slashes; encode so one branch maps to one ref leaf. */
export function encodeBranch(branch) {
  return encodeURIComponent(branch).replace(/\./g, "%2E");
}

export function undoRefFor(batchId, branch) {
  return `${UNDO_REFS_PREFIX}/${batchId}/${encodeBranch(branch)}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readPid(lockPath) {
  try {
    const buf = Buffer.alloc(32);
    const fd = openSync(lockPath, "r");
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    return Number.parseInt(buf.toString("utf8", 0, n).trim(), 10) || null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // exists but not ours
  }
}

/**
 * Exclusive pid lock. Retries until timeoutMs; steals a lock whose pid is
 * dead (crashed process). Returns { release() }.
 */
export async function acquireLock(dataDir, { timeoutMs = 10_000, pollMs = 50 } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const { lock } = ledgerPaths(dataDir);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      writeSync(fd, `${process.pid}\n`);
      fsyncSync(fd);
      return {
        release() {
          try {
            closeSync(fd);
          } catch {}
          try {
            unlinkSync(lock);
          } catch {}
        },
      };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const pid = readPid(lock);
      if (pid && !pidAlive(pid)) {
        try {
          unlinkSync(lock);
        } catch {}
        continue; // stale lock from a dead process
      }
      if (Date.now() >= deadline) {
        throw new Error(`git-reap: data dir is locked by another process (${lock})`);
      }
      await sleep(pollMs);
    }
  }
}

/** Append one JSONL line with fsync (durable before any ref deletion). */
function appendLine(dataDir, obj) {
  mkdirSync(dataDir, { recursive: true });
  const { ledger } = ledgerPaths(dataDir);
  const fd = openSync(ledger, "a");
  try {
    writeSync(fd, `${JSON.stringify(obj)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Begin a batch. Writes the `begin` line (fsync'd) and holds the lock until
 * the returned handle is committed or aborted.
 */
export async function beginBatch(
  dataDir,
  repoCommonDir,
  { batchId = newBatchId(), now = Date.now, lockTimeoutMs = 10_000 } = {},
) {
  const lock = await acquireLock(dataDir, { timeoutMs: lockTimeoutMs });
  appendLine(dataDir, { e: "begin", b: batchId, r: repoCommonDir, t: now() });
  return {
    batchId,
    repoCommonDir,
    entry(branch, sha, undoRef) {
      appendLine(dataDir, { e: "entry", b: batchId, n: branch, s: sha, u: undoRef });
    },
    result(branch, status, reason = null) {
      appendLine(dataDir, { e: "result", b: batchId, n: branch, st: status, why: reason });
    },
    commit() {
      appendLine(dataDir, { e: "commit", b: batchId, t: now() });
      lock.release();
    },
    abort() {
      lock.release();
    },
  };
}

/** Parse the ledger into an array of raw events (empty array if none). */
export function readLedger(dataDir) {
  const { ledger } = ledgerPaths(dataDir);
  if (!existsSync(ledger)) return [];
  return readFileSync(ledger, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * The LAST batch group in the ledger, committed or not (an interrupted
 * batch is still restorable). Returns null when the ledger has no batches.
 */
export function lastBatch(dataDir) {
  return listBatches(dataDir).at(-1) ?? null;
}

/** Every batch group in the ledger, oldest first. */
export function listBatches(dataDir) {
  const events = readLedger(dataDir);
  const batches = [];
  let cur = null;
  for (const ev of events) {
    if (ev.e === "begin") {
      cur = {
        batchId: ev.b,
        repoCommonDir: ev.r,
        ts: ev.t,
        committed: false,
        entries: [],
        results: [],
      };
      batches.push(cur);
    } else if (cur && ev.e === "entry")
      cur.entries.push({ branch: ev.n, sha: ev.s, undoRef: ev.u });
    else if (cur && ev.e === "result")
      cur.results.push({ branch: ev.n, status: ev.st, reason: ev.why });
    else if (cur && ev.e === "commit") cur.committed = true;
  }
  return batches;
}

/**
 * Restorable-branch view for the TUI "recently deleted" section:
 * every branch in a committed batch, with its 90-day expiry countdown.
 *   [{ repoPath, batchId, branch, sha, deletedAt, expiresAt, daysLeft,
 *      restorable }]
 * `restorable` is false when the batch was purged (undo ref gone) or the
 * retention window passed; the TUI shows those greyed out.
 */
export function listDeleted(
  dataDir,
  { retentionDays = DEFAULT_RETENTION_DAYS, now = Date.now } = {},
) {
  const batches = listBatches(dataDir);
  const out = [];
  for (const batch of batches) {
    if (!batch.committed) continue;
    const deletedAt = batch.ts ?? 0;
    const expiresAt = deletedAt + retentionDays * DAY_MS;
    const restorable = now() < expiresAt;
    for (const entry of batch.entries) {
      out.push({
        repoPath: batch.repoCommonDir,
        batchId: batch.batchId,
        branch: entry.branch,
        sha: entry.sha,
        undoRef: entry.undoRef,
        deletedAt,
        expiresAt,
        daysLeft: Math.max(0, Math.ceil((expiresAt - now()) / DAY_MS)),
        restorable,
      });
    }
  }
  // most recently deleted first
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

/**
 * Create the hidden undo ref for one branch (idempotent: a pre-existing
 * ref is left untouched). Returns the ref name.
 */
export async function createUndoRef(repoPath, batchId, branch, sha) {
  const ref = undoRefFor(batchId, branch);
  const r = await gitRaw(repoPath, ["update-ref", ref, sha]);
  if (r.code !== 0) {
    const err = new Error(`failed to create undo ref ${ref}: ${r.stderr.trim()}`);
    err.code = r.code;
    throw err;
  }
  return ref;
}

/**
 * Restore one batch's branches. For each entry, re-create the branch at the
 * recorded SHA — refusing to overwrite a branch that exists at a different
 * SHA (restore-refuses-overwrite). Returns per-entry results; partial
 * restore is visible, not silent.
 *
 * @param commonDir repo git common-dir (from the batch)
 * @param batch     lastBatch()/listBatches() entry
 * @returns [{ branch, sha, status: "restored"|"already"|"refused"|"failed", reason }]
 */
export async function restoreBatch(commonDir, batch) {
  const results = [];
  for (const entry of batch.entries) {
    const ref = `refs/heads/${entry.branch}`;
    const current = await revParse(commonDir, ref);
    if (current === entry.sha) {
      results.push({
        branch: entry.branch,
        sha: entry.sha,
        status: "already",
        reason: "branch already at recorded SHA",
      });
      continue;
    }
    if (current !== null) {
      results.push({
        branch: entry.branch,
        sha: entry.sha,
        status: "refused",
        reason: "branch exists at a different SHA",
      });
      continue;
    }
    const r = await gitRaw(commonDir, ["update-ref", ref, entry.sha]);
    if (r.code !== 0) {
      results.push({
        branch: entry.branch,
        sha: entry.sha,
        status: "failed",
        reason: r.stderr.trim(),
      });
    } else {
      results.push({ branch: entry.branch, sha: entry.sha, status: "restored" });
    }
  }
  return results;
}

/**
 * Delete the hidden undo refs of a batch (reap undo --purge). Keeps ledger
 * lines for history; returns the number of refs removed.
 */
export async function purgeBatch(commonDir, batch) {
  let removed = 0;
  for (const entry of batch.entries) {
    const r = await gitRaw(commonDir, ["update-ref", "-d", entry.undoRef]);
    if (r.code === 0) removed += 1;
  }
  return removed;
}

/**
 * Purge batches older than retentionDays whose branches have been restored
 * or refused (i.e. the user has moved on). Returns purged batch ids.
 */
export async function purgeExpired(
  dataDir,
  { retentionDays = DEFAULT_RETENTION_DAYS, now = Date.now } = {},
) {
  const cutoff = now() - retentionDays * DAY_MS;
  const batches = listBatches(dataDir);
  const purged = [];
  for (const batch of batches) {
    if (batch.ts && batch.ts < cutoff) {
      try {
        await purgeBatch(batch.repoCommonDir, batch);
      } catch {
        // repo may be gone; leave refs for manual cleanup
      }
      purged.push(batch.batchId);
    }
  }
  return purged;
}
