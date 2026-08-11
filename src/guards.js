// Tri-state safety guards. Every guard returns
// "pass" | "block" | "unknown" — unknown BLOCKS. Execution re-runs all
// guards at deletion time; scan-time classification is
// never trusted for the mutation.

import { matchProtected } from "./classify.js";
import { git, gitRaw, listWorktrees, revParse } from "./git.js";
export const PASS = "pass";
export const BLOCK = "block";
export const UNKNOWN = "unknown";

const VERDICT_ORDER = [BLOCK, UNKNOWN, PASS];

function worst(a, b) {
  return VERDICT_ORDER.indexOf(a) <= VERDICT_ORDER.indexOf(b) ? a : b;
}

/** Combine individual guard verdicts: any block blocks, else any unknown is unknown. */
export function combine(verdicts) {
  return verdicts.reduce((acc, v) => worst(acc, v), PASS);
}

/** The set of refs/heads/* currently checked out in any worktree, or null
 * when worktrees can't be enumerated (unknown downstream). */
async function checkedOutHeads(repo) {
  const wts = await listWorktrees(repo);
  if (wts === null) return null;
  return new Set(wts.map((w) => w.branch).filter(Boolean));
}

/**
 * Run every guard for one branch.
 *
 * @param repoPath path inside the repository (any worktree works)
 * @param branch   branch name (short form, e.g. "feat/x")
 * @param opts     { defaultRef, upstream, protectedPatterns, evidence }
 *   - defaultRef: resolved default ref (refs/heads/... or refs/remotes/...), or null when unresolved
 *   - upstream:   the branch's upstream ref (e.g. "refs/remotes/origin/x"), or null
 *   - evidence:   classification evidence ({ kind, ... }) for the §3.2 disposability check
 * @returns { guard, verdict, reason } where guard is the worst offender
 */
export async function runGuards(
  repoPath,
  branch,
  { defaultRef = null, upstream = null, protectedPatterns = [], evidence = null } = {},
) {
  const guards = [];

  // 1. current-branch — not HEAD of any worktree
  const heads = await checkedOutHeads(repoPath);
  if (heads === null) {
    guards.push({
      name: "current-branch",
      verdict: UNKNOWN,
      reason: "could not enumerate worktrees",
    });
  } else if (heads.has(`refs/heads/${branch}`)) {
    guards.push({ name: "current-branch", verdict: BLOCK, reason: "checked out in a worktree" });
  } else {
    guards.push({ name: "current-branch", verdict: PASS });
  }

  // 2. default-branch — B != resolved D (implicit, any name)
  if (!defaultRef) {
    guards.push({ name: "default-branch", verdict: UNKNOWN, reason: "no default branch resolved" });
  } else if (defaultRef === `refs/heads/${branch}`) {
    guards.push({ name: "default-branch", verdict: BLOCK, reason: "is the default branch" });
  } else {
    guards.push({ name: "default-branch", verdict: PASS });
  }

  // 3. protected — built-ins + config patterns
  if (matchProtected(branch, protectedPatterns)) {
    guards.push({ name: "protected", verdict: BLOCK, reason: "matches protected pattern" });
  } else {
    guards.push({ name: "protected", verdict: PASS });
  }

  // 4. unpushed — ahead-count == 0 when upstream resolves; unknown when it
  //    can't (gone / no upstream). §3.2 disposability proof (ancestor of D,
  //    or host-verified merged) substitutes for a resolvable upstream.
  if (upstream) {
    const resolvedUpstream = await revParse(repoPath, upstream);
    if (resolvedUpstream === null) {
      // upstream ref gone: the branch is "gone" — §3.2 decides eligibility
      const disposable =
        evidence?.kind === "ancestor" || evidence?.kind === "host" || evidence?.kind === "merged";
      guards.push(
        disposable
          ? { name: "unpushed", verdict: PASS, reason: "commits proven disposable (§3.2)" }
          : {
              name: "unpushed",
              verdict: UNKNOWN,
              reason: "upstream gone, disposability unproven (§3.2)",
            },
      );
    } else {
      const ahead = Number(
        await git(repoPath, ["rev-list", "--count", `${upstream}..${branch}`]).catch(() => "1"),
      );
      guards.push(
        ahead > 0
          ? {
              name: "unpushed",
              verdict: BLOCK,
              reason: `${ahead} unpushed commit${ahead > 1 ? "s" : ""}`,
            }
          : { name: "unpushed", verdict: PASS },
      );
    }
  } else if (defaultRef) {
    // No upstream at all: the branch is local-only. Its commits are only
    // disposable when they're already in the default branch (ancestor) or
    // host-verified merged; a plain no-upstream branch is unproven.
    const disposable =
      evidence?.kind === "ancestor" || evidence?.kind === "host" || evidence?.kind === "merged";
    guards.push(
      disposable
        ? { name: "unpushed", verdict: PASS, reason: "commits proven disposable (§3.2)" }
        : {
            name: "unpushed",
            verdict: UNKNOWN,
            reason: "no upstream, disposability unproven (§3.2)",
          },
    );
  } else {
    guards.push({
      name: "unpushed",
      verdict: UNKNOWN,
      reason: "no upstream and no default to compare",
    });
  }

  // 5. dirty-worktree — the branch's worktree (if any) is clean.
  //    A branch checked out somewhere is already blocked by current-branch,
  //    but a branch can ALSO be deleted from another worktree while a linked
  //    worktree of it sits dirty; guard independently via status.
  const wts = await listWorktrees(repoPath);
  if (wts === null) {
    guards.push({
      name: "dirty-worktree",
      verdict: UNKNOWN,
      reason: "could not enumerate worktrees",
    });
  } else {
    const branchWorktree = wts.find((w) => w.branch === `refs/heads/${branch}`)?.path ?? null;
    if (!branchWorktree) {
      guards.push({ name: "dirty-worktree", verdict: PASS, reason: "no worktree for branch" });
    } else {
      const st = await gitRaw(branchWorktree, ["status", "--porcelain=v2", "-z"]);
      if (st.code !== 0) {
        guards.push({
          name: "dirty-worktree",
          verdict: UNKNOWN,
          reason: "could not read worktree status",
        });
      } else if (st.stdout.length > 0) {
        guards.push({
          name: "dirty-worktree",
          verdict: BLOCK,
          reason: "worktree has uncommitted changes",
        });
      } else {
        guards.push({ name: "dirty-worktree", verdict: PASS });
      }
    }
  }

  const verdict = combine(guards.map((g) => g.verdict));
  const worstGuard = guards.find((g) => g.verdict === verdict) ?? guards[0];
  return { verdict, guard: worstGuard.name, reason: worstGuard.reason ?? null, guards };
}
