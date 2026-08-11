// Race-safe deletion transaction.
//
// Guards evaluated at scan time do NOT protect the mutation. Each branch is
// revalidated at deletion time: re-read tip → re-run all guards → write the
// undo anchor and fsync → compare-and-delete. `git branch -d` is used only
// for `merged` branches (git's own ancestor check as a bonus); everything
// else deletes via `git update-ref -d refs/heads/B <old-sha>` so the delete
// fails if the ref moved between review and execution.

import { isAbsolute, resolve } from "node:path";
import { gitOk, gitRaw, revParse } from "./git.js";
import { runGuards } from "./guards.js";
import { beginBatch, createUndoRef } from "./ledger.js";

export const DELETED = "deleted";
export const ABORTED = "aborted";
export const FAILED = "failed";
export const SKIPPED = "skipped";

/**
 * Revalidate ONE branch at execution time.
 * Returns { ok, status, reason } — status ABORTED/SKIPPED/FAILED when not ok.
 */
export async function revalidateBranch(repoPath, branch, { defaultRef, protectedPatterns }) {
  // step 1 — re-read the tip; abort if it differs from the reviewed SHA
  const tip = await revParse(repoPath, `refs/heads/${branch.name}`);
  if (tip === null) {
    return { ok: false, status: SKIPPED, reason: "branch no longer exists" };
  }
  if (tip !== branch.sha) {
    return {
      ok: false,
      status: ABORTED,
      reason: `tip moved since review (now ${tip.slice(0, 8)})`,
    };
  }

  // step 2 — re-run ALL guards; any block/unknown aborts
  const g = await runGuards(repoPath, branch.name, {
    defaultRef,
    upstream: branch.upstream,
    protectedPatterns,
    evidence: branch.evidence,
  });
  if (g.verdict !== "pass") {
    return { ok: false, status: ABORTED, reason: `${g.guard}: ${g.reason}` };
  }
  return { ok: true };
}

/**
 * Delete one branch after full revalidation.
 * The undo anchor is written + fsync'd BEFORE the ref deletion.
 * Returns { status, reason?, undoRef? }.
 */
export async function deleteBranchWithUndo(
  repoPath,
  branch,
  { batch, defaultRef, protectedPatterns },
) {
  const re = await revalidateBranch(repoPath, branch, { defaultRef, protectedPatterns });
  if (!re.ok) return re;

  // step 3 — undo anchor (ledger entry is fsync'd inside beginBatch.entry;
  // the hidden ref keeps the tip reachable)
  let undoRef;
  try {
    undoRef = await createUndoRef(repoPath, batch.batchId, branch.name, branch.sha);
  } catch (err) {
    return { ok: false, status: FAILED, reason: `undo ref failed: ${err.message}` };
  }
  batch.entry(branch.name, branch.sha, undoRef);

  // step 4 — delete. merged → git branch -d (git's ancestor check as a
  // bonus); everything else → compare-and-delete against the reviewed SHA.
  if (branch.class === "merged") {
    const ok = await gitOk(repoPath, ["branch", "-d", branch.name]);
    if (!ok) {
      batch.result(branch.name, FAILED, "git branch -d refused (not merged into HEAD/upstream)");
      return { ok: false, status: FAILED, reason: "git branch -d refused" };
    }
  } else {
    const r = await gitRaw(repoPath, ["update-ref", "-d", `refs/heads/${branch.name}`, branch.sha]);
    if (r.code !== 0) {
      batch.result(branch.name, FAILED, r.stderr.trim() || "update-ref refused");
      return { ok: false, status: FAILED, reason: r.stderr.trim() || "update-ref refused" };
    }
  }

  batch.result(branch.name, DELETED);
  return { ok: true, status: DELETED, undoRef };
}

/**
 * Execute a deletion plan for one repo as a ledger batch.
 *
 * @param repoPath  worktree path (git commands run here)
 * @param commonDir repo git common-dir (ledger identity, stable)
 * @param branches  [{ name, sha, upstream, evidence, class }] — the REVIEWED
 *                  selection from the confirm screen
 * @param opts      { dataDir, defaultRef, protectedPatterns }
 * @returns { batchId, results: [{ branch, status, reason?, undoRef? }] }
 */
export async function executePlan(
  repoPath,
  commonDir,
  branches,
  { dataDir, defaultRef, protectedPatterns = [], lockTimeoutMs = 10_000 },
) {
  // git rev-parse --git-common-dir can return a path relative to the caller's
  // cwd; normalize against the repo path so the ledger identity is stable.
  const cd = isAbsolute(commonDir) ? commonDir : resolve(repoPath, commonDir);
  const batch = await beginBatch(dataDir, cd, { lockTimeoutMs });
  const results = [];
  try {
    for (const branch of branches) {
      const r = await deleteBranchWithUndo(repoPath, branch, {
        batch,
        defaultRef,
        protectedPatterns,
      });
      results.push({
        branch: branch.name,
        status: r.status,
        reason: r.reason ?? null,
        undoRef: r.undoRef ?? null,
      });
    }
    batch.commit();
  } catch (err) {
    batch.abort();
    throw err;
  }
  return { batchId: batch.batchId, results };
}
