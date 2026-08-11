// Scan orchestration: discover → per-repo resolve →
// optional opt-in fetch/prune → classify. Per-repo failures degrade to
// warnings; a no-default repo is inventory-only.

import { BRANCH_FIELDS, classifyRepo } from "./classify.js";
import { repoConfig } from "./config.js";
import { discoverRepos } from "./discover.js";
import { forEachRef, gitRaw } from "./git.js";
import { collectHostVerdicts } from "./hosts/index.js";
import { detectRepoKind } from "./kind.js";
import { resolveRepo } from "./resolve.js";

async function fetchPrune(repoPath, timeoutMs) {
  const r = await gitRaw(repoPath, ["fetch", "--prune"], { timeoutMs });
  if (r.code !== 0) {
    return `fetch failed: ${r.stderr.trim().split("\n")[0] || "unknown error"}`;
  }
  return null;
}

/**
 * scan({ roots, repo, fetch, staleDays, hostVerdicts, onRepo, timeoutMs })
 * → { fetched, repos: [{ path, status, defaultBranch, branches, warnings }],
 *     skipped: [{ path, reason }] }
 */
export async function scan({
  roots = [],
  repo = null,
  fetch = false,
  staleDays = 30,
  onRepo = null,
  timeoutMs = 30_000,
  crossFilesystems = false,
  host = false,
  config = null,
} = {}) {
  const discovery = repo
    ? await discoverRepos([repo], { maxDepth: 0 })
    : await discoverRepos(roots, { crossFilesystems });
  const { skipped } = discovery;
  const repos = [];

  for (const found of discovery.repos) {
    const warnings = [];
    if (fetch) {
      const fetchError = await fetchPrune(found.path, timeoutMs);
      if (fetchError) warnings.push(fetchError);
    }
    let resolved;
    try {
      // per-repo config overlay (default_branch / protected) applies to this repo
      const rc = config ? repoConfig(config, found.path) : {};
      resolved = await resolveRepo(found.path, { config: rc });
    } catch (err) {
      warnings.push(`resolve failed: ${err.message}`);
      repos.push({
        path: found.path,
        commonDir: found.commonDir,
        status: "error",
        defaultBranch: null,
        branches: [],
        warnings,
        kind: detectRepoKind(found.path),
      });
      onRepo?.(found.path);
      continue;
    }
    let branches = [];
    try {
      // host lookup: fetch refs once, ask for PR/MR verdicts (best-effort,
      // any failure degrades to empty), then classify with both. Offline
      // runs collect nothing and behave exactly as before.
      const refs = await forEachRef(found.path, BRANCH_FIELDS);
      let hostVerdicts = {};
      if (host && resolved.remote) {
        const hv = await collectHostVerdicts({
          repoPath: found.path,
          remote: resolved.remote,
          branches: refs.map((r) => ({ name: r["refname:short"], sha: r.objectname })),
          timeoutMs,
          token: config?.hosts?.["github"]?.token ?? config?.hosts?.["gitlab"]?.token ?? null,
          baseUrl:
            config?.hosts?.["github"]?.base_url ?? config?.hosts?.["gitlab"]?.base_url ?? null,
        });
        hostVerdicts = hv.verdicts;
        warnings.push(...hv.warnings);
      }
      const rc = config ? repoConfig(config, found.path) : null;
      branches = await classifyRepo(found.path, {
        resolved,
        staleDays,
        hostVerdicts,
        refsParam: refs,
        protectedPatterns: rc?.protected,
      });
    } catch (err) {
      warnings.push(`classify failed: ${err.message}`);
    }
    repos.push({
      path: found.path,
      commonDir: found.commonDir,
      status: resolved.status,
      defaultBranch: resolved.defaultBranch,
      defaultRef: resolved.defaultRef,
      remote: resolved.remote,
      branches,
      warnings,
      kind: detectRepoKind(found.path),
    });
    onRepo?.(found.path);
  }

  return { fetched: fetch, repos, skipped };
}
