// GitLab host adapter.
//
// findPrState(repoInfo, branch, { token, baseUrl }) →
//   { verdict: "merged" | "closed" | null, evidence, warning? }
//
// GitLab MR lookup: GET /projects/:id/merge_requests?source_branch=B&state=all
// with source-project identity (the remote's project). Same binding rules as
// GitHub: exact head SHA → verdict; ancestor → block; ambiguous → null.

import { degradeWarning, hostFetch, isDegraded } from "./mod.js";

export const NAME = "gitlab";

/** Project id is the URL-encoded namespace path (owner/repo). */
export function mrListUrl(repoInfo, branch, baseUrl = "https://gitlab.com/api/v4") {
  const project = `${repoInfo.owner}/${repoInfo.repo}`;
  const encoded = encodeURIComponent(project);
  return `${baseUrl}/projects/${encoded}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=all&per_page=100`;
}

export async function findPrState(repoInfo, branch, { token, baseUrl, timeoutMs = 15_000 } = {}) {
  const url = mrListUrl(repoInfo, branch.name, baseUrl);
  // GitLab uses PRIVATE-TOKEN header, not Bearer
  const res = await hostFetch(url, {
    token: null,
    headers: token ? { "PRIVATE-TOKEN": token } : {},
    timeoutMs,
  });
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

  if (res.json.length === 0) {
    return { verdict: null, evidence: null };
  }

  // GitLab MRs carry the source branch head SHA in `sha`
  const exact = res.json.find((mr) => mr.sha === branch.sha);
  if (exact) {
    return verdictFor(exact, "exact-sha");
  }
  const any = res.json.find((mr) => mr.sha);
  if (any) {
    return {
      verdict: null,
      evidence: null,
      warning: `MR !${any.iid} head ${any.sha?.slice(0, 8)} != tip ${branch.sha.slice(0, 8)} (unpushed commits)`,
    };
  }
  return { verdict: null, evidence: null };
}

function verdictFor(mr, bind) {
  const state = mr.state; // opened | closed | merged
  if (state === "merged") {
    return {
      verdict: "merged",
      evidence: {
        kind: "host",
        host: NAME,
        prId: mr.iid ?? mr.id,
        prUrl: mr.web_url ?? null,
        headSha: mr.sha ?? null,
        bind,
      },
    };
  }
  if (state === "closed") {
    return {
      verdict: "closed",
      evidence: {
        kind: "host",
        host: NAME,
        prId: mr.iid ?? mr.id,
        prUrl: mr.web_url ?? null,
        headSha: mr.sha ?? null,
        bind,
      },
    };
  }
  return { verdict: null, evidence: null };
}
