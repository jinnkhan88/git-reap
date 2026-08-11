// Branch classification (offline rules 1,2,4,5,6 + §3.2
// gone-branch evidence; host verdicts arrive via opts.hostVerdicts).
// Eligibility: pre-selected = merged / host-verified squash /
// gone-with-proof. patch-equivalent, closed-unmerged, stale are advisory.

import { BUILTIN_PROTECTED } from "./config.js";
import { forEachRef, git, isAncestor } from "./git.js";

export const BRANCH_FIELDS = ["refname:short", "objectname", "upstream", "committerdate:unix"];

export function matchProtected(name, patterns) {
  for (const p of patterns) {
    if (p === name) return true;
    if (p.endsWith("/*")) {
      const prefix = p.slice(0, -1); // "release/"
      if (name.startsWith(prefix) && !name.slice(prefix.length).includes("/")) return true;
    }
  }
  return false;
}

/** `git cherry D B`: all of B's unique commits have patch-equivalents in D? */
async function allPatchEquivalent(repo, defaultRef, sha) {
  const out = await git(repo, ["cherry", defaultRef, sha]).catch(() => null);
  if (out === null || !out.trim()) return false; // empty = no unique commits = ancestor case
  return out
    .trim()
    .split("\n")
    .every((l) => l.startsWith("-"));
}

/**
 * classifyRepo(repoPath, { resolved, staleDays, hostVerdicts, protectedPatterns, now })
 * resolved: result of resolveRepo(). hostVerdicts: { [branch]: { verdict, evidence } }.
 * Returns [{ name, sha, upstream, lastCommitTs, ageDays, class, eligible, evidence }].
 */
export async function classifyRepo(
  repoPath,
  {
    resolved,
    staleDays = 30,
    hostVerdicts = {},
    protectedPatterns = BUILTIN_PROTECTED,
    now = Math.floor(Date.now() / 1000),
    refsParam = null,
  } = {},
) {
  const hasDefault = resolved.status === "ok" && resolved.defaultRef;
  // callers may pre-fetch refs (host lookup needs SHAs before
  // classification); refetch when not supplied so the function stays usable
  // standalone.
  const refs = refsParam ?? (await forEachRef(repoPath, BRANCH_FIELDS));
  const remoteRefs = new Set(
    (await forEachRef(repoPath, ["refname"], "refs/remotes")).map((r) => r.refname),
  );

  const out = [];
  for (const r of refs) {
    const name = r["refname:short"];
    const sha = r.objectname;
    const upstream = r.upstream || null;
    const lastCommitTs = Number(r["committerdate:unix"]) || 0;
    const base = {
      name,
      sha,
      upstream,
      lastCommitTs,
      ageDays: Math.max(0, Math.floor((now - lastCommitTs) / 86400)),
      evidence: { kind: "none" },
    };

    if (hasDefault && `refs/heads/${name}` === resolved.defaultRef) {
      out.push({ ...base, class: "default", eligible: false });
      continue;
    }
    if (matchProtected(name, protectedPatterns)) {
      out.push({ ...base, class: "protected", eligible: false });
      continue;
    }

    // rule 1 — upstream gone (membership check, never [gone] text parsing)
    const isGone = upstream && !remoteRefs.has(upstream);
    if (isGone) {
      // §3.2: eligible only with independent proof — ancestor of D, or
      // host-verified merged PR/MR bound to the tip.
      const host = hostVerdicts[name];
      const ancestor = hasDefault ? await isAncestor(repoPath, sha, resolved.defaultRef) : false;
      const eligible = ancestor || host?.verdict === "merged";
      out.push({
        ...base,
        class: "gone",
        eligible,
        evidence: ancestor
          ? { kind: "ancestor" }
          : host?.verdict === "merged"
            ? { kind: "host", ...host.evidence }
            : { kind: "none" },
      });
      continue;
    }

    if (hasDefault) {
      // rule 2 — merged into default
      if (await isAncestor(repoPath, sha, resolved.defaultRef)) {
        out.push({ ...base, class: "merged", eligible: true, evidence: { kind: "ancestor" } });
        continue;
      }
    }

    // rule 3 — host verdict (unknown/absent falls through)
    const host = hostVerdicts[name];
    if (host?.verdict === "merged") {
      out.push({
        ...base,
        class: "squash-merged",
        eligible: true,
        evidence: { kind: "host", ...host.evidence },
      });
      continue;
    }
    if (host?.verdict === "closed") {
      out.push({
        ...base,
        class: "closed-unmerged",
        eligible: false,
        evidence: { kind: "host", ...host.evidence },
      });
      continue;
    }

    if (hasDefault) {
      // rule 4 — offline patch equivalence (advisory, never eligible)
      if (await allPatchEquivalent(repoPath, resolved.defaultRef, sha)) {
        out.push({ ...base, class: "patch-equivalent", eligible: false });
        continue;
      }
      // rule 5 — stale (blocked without a trustworthy default)
      if (base.ageDays >= staleDays) {
        out.push({ ...base, class: "stale", eligible: false });
        continue;
      }
    }

    out.push({ ...base, class: "active", eligible: false });
  }
  return out;
}
