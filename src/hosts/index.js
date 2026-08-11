// Host verdict collection: given a repo + resolved remote, look up
// every local branch's PR/MR state through the matching host adapter.
//
// collectHostVerdicts({ repoPath, remote, branches, token, timeoutMs, env }) →
//   { verdicts: { [branch]: { verdict, evidence } }, warnings: string[] }
//
// No remote / unknown host / no token / any failure → empty verdicts (the
// offline classifier rules apply unchanged). Warnings surface in the scan.

import { defaultDataDir } from "../ledger.js";
import * as github from "./github.js";
import * as gitlab from "./gitlab.js";
import { discoverToken, hostCachePath, readHostCache, repoInfoFor, writeHostCache } from "./mod.js";

const ADAPTERS = { github, gitlab };

/**
 * Branches: [{ name, sha }] from the scan/classify pipeline (head SHAs are
 * needed for the §3.3 content binding). Only branches that are NOT already
 * proven (not ancestor-of-default, not obviously merged) strictly need a host
 * verdict, but we query all so the report records PR evidence for the ones
 * that have it.
 */
export async function collectHostVerdicts({
  repoPath,
  remote,
  branches = [],
  token = null,
  timeoutMs = 15_000,
  env = process.env,
  baseUrl = null,
  dataDir = defaultDataDir(env),
} = {}) {
  if (!branches.length || !remote) return { verdicts: {}, warnings: [] };
  const { repoInfo, url } = await repoInfoFor(repoPath, remote);
  if (!repoInfo) return { verdicts: {}, warnings: [] };

  const adapter = ADAPTERS[repoInfo.host];
  if (!adapter) return { verdicts: {}, warnings: [] };

  const effectiveToken = token ?? discoverToken(repoInfo.host, env);
  const warnings = [];
  // positive verdicts survive between runs; moved branches miss by sha
  const cache = readHostCache(repoInfo, dataDir);
  const cacheFile = hostCachePath(repoInfo, dataDir);
  const cachedKeys = Object.keys(cache);

  const verdicts = {};
  let rateLimited = false;
  for (const branch of branches) {
    const key = `${branch.name}@${branch.sha}`;
    const hit = cache[key];
    if (hit?.verdict) {
      verdicts[branch.name] = { verdict: hit.verdict, evidence: hit.evidence, cached: true };
      continue;
    }
    try {
      const r = await adapter.findPrState(repoInfo, branch, {
        token: effectiveToken,
        timeoutMs,
        ...(baseUrl ? { baseUrl } : {}),
      });
      if (r.rateLimited) {
        // once limited → stop querying this repo entirely, stay offline
        rateLimited = true;
        warnings.push(
          `${branch.name}: ${repoInfo.host} rate limited, host lookups stopped for this repo (offline rules apply)`,
        );
        break;
      }
      if (r.verdict) {
        verdicts[branch.name] = { verdict: r.verdict, evidence: r.evidence };
        cache[key] = { verdict: r.verdict, evidence: r.evidence };
      }
      if (r.warning) warnings.push(`${branch.name}: ${r.warning}`);
    } catch (err) {
      warnings.push(`${branch.name}: host lookup failed: ${err.message}`);
    }
  }

  // persist only when we actually wrote new entries (avoids touching disk
  // on every no-op scan, and never writes on rate-limit aborts)
  if (Object.keys(cache).length > cachedKeys.length) {
    writeHostCache(repoInfo, dataDir, cache);
  }

  // one-line summary when we had a remote but no token at all
  if (!effectiveToken && url && !rateLimited) {
    warnings.push(
      `no ${repoInfo.host} token found (GH_TOKEN/GITHUB_TOKEN or gh auth; ` +
        `GITLAB_TOKEN/GLAB_TOKEN or glab config), host PR evidence skipped`,
    );
  }

  return { verdicts, warnings, cacheFile };
}
