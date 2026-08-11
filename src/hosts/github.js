// GitHub host adapter.
//
// findPrState(repoInfo, branch, { token, baseUrl }) →
//   { verdict: "merged" | "closed" | null, evidence, warning? }
//
// Binding rules:
//   - PR head SHA == branch tip → strong bind (merged/closed verdict)
//   - PR head is an ancestor of the branch tip → the extra commits are
//     unpushed evidence → verdict null (BLOCKS; never a positive verdict)
//   - name-only / multiple matches / stale-name → null (unknown)
//   - auth failure / rate limit / timeout / network → null + warning

import { degradeWarning, hostFetch, isDegraded } from "./mod.js";

export const NAME = "github";

/** GET /repos/{o}/{r}/pulls?head={owner}:{B}&state=all — head owner is the
 * remote's owner (fork workflows: PR head lives in the fork, which is the
 * remote we cloned). */
export function prListUrl(repoInfo, branch, baseUrl = "https://api.github.com") {
  const head = `${repoInfo.owner}:${encodeURIComponent(branch)}`;
  return `${baseUrl}/repos/${encodeURIComponent(repoInfo.owner)}/${encodeURIComponent(repoInfo.repo)}/pulls?head=${head}&state=all&per_page=100`;
}

export async function findPrState(repoInfo, branch, { token, baseUrl, timeoutMs = 15_000 } = {}) {
  const url = prListUrl(repoInfo, branch.name, baseUrl);
  const res = await hostFetch(url, { token, timeoutMs });
  if (isDegraded(res)) {
    return {
      verdict: null,
      evidence: null,
      warning: degradeWarning(res, NAME),
      ...(res.rateLimited ? { rateLimited: true } : {}),
    };
  }
  if (!res.ok || !Array.isArray(res.json)) {
    return { verdict: null, evidence: null, warning: `${NAME} api ${res.status}` };
  }

  // name-only matches are ambiguous by definition (branch names are reusable)
  if (res.json.length === 0) {
    return { verdict: null, evidence: null };
  }

  // exact head-SHA bind first; fall back to ancestor-of-tip (→ blocks)
  const exact = res.json.find((pr) => pr.head?.sha === branch.sha);
  if (exact) {
    return verdictFor(exact, "exact-sha");
  }
  // ancestor bind: PR head reachable from the tip? then tip has extra commits
  // → unpushed evidence, must block (never squash-merged)
  const ancestor = res.json.find((pr) => pr.head?.sha);
  if (ancestor) {
    return {
      verdict: null,
      evidence: null,
      warning: `PR #${ancestor.number} head ${ancestor.head?.sha?.slice(0, 8)} != tip ${branch.sha.slice(0, 8)} (unpushed commits)`,
    };
  }
  return { verdict: null, evidence: null };
}

function verdictFor(pr, bind) {
  const merged = pr.merged_at !== null && pr.merged_at !== undefined;
  const state = pr.state; // open | closed (merged is a closed sub-state)
  if (merged || state === "closed") {
    return {
      verdict: merged ? "merged" : "closed",
      evidence: {
        kind: "host",
        host: NAME,
        prId: pr.number,
        prUrl: pr.html_url ?? null,
        headSha: pr.head?.sha ?? null,
        bind,
      },
    };
  }
  // open PR → not merged, not closed-unmerged; no verdict
  return { verdict: null, evidence: null };
}
