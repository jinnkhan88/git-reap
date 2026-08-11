// Host API correlation: find the PR/MR state for a
// branch through the repo's selected remote. A host adapter is just
// { findPrState(repoInfo, branch, opts) } — dispatch happens by remote host.
//
// Every failure mode (no remote, unknown host, auth missing, rate limit,
// timeout, ambiguity) degrades to { verdict: null } — NEVER a positive
// verdict. The offline classifier rules then apply unchanged.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gitRaw } from "../git.js";

/**
 * Parse a git remote URL into { host, owner, repo } (github/gitlab only),
 * or null when the URL isn't a supported host. Handles:
 *   git@github.com:owner/repo.git
 *   https://github.com/owner/repo.git
 *   ssh://git@gitlab.com/group/sub/repo.git
 */
export function parseRemoteUrl(url) {
  if (!url) return null;
  let m = url.match(/^git@([^:]+):(.+)\.git$/);
  if (m) return splitPath(m[1], m[2]);
  m = url.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (m) return splitPath(m[1], m[2]);
  m = url.match(/^ssh:\/\/git@([^/]+)\/(.+)\.git$/);
  if (m) return splitPath(m[1], m[2]);
  return null;
}

function splitPath(host, path) {
  const hostType = host.includes("github") ? "github" : host.includes("gitlab") ? "gitlab" : null;
  if (!hostType) return null;
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const repo = parts.pop();
  const owner = parts.join("/");
  return { host: hostType, hostname: host, owner, repo };
}

/**
 * Token discovery, READ-ONLY. Precedence per host:
 *   github: GH_TOKEN / GITHUB_TOKEN env → gh CLI auth token → hosts.yml
 *   gitlab: GITLAB_TOKEN / GLAB_TOKEN env → glab CLI config token
 * Never writes, never prompts.
 */
export function discoverToken(host, env = process.env) {
  if (host === "github") {
    if (env.GH_TOKEN || env.GITHUB_TOKEN) return env.GH_TOKEN || env.GITHUB_TOKEN;
    const fromFile = readGhHostsYml(env);
    if (fromFile) return fromFile;
    return tryGhToken(env);
  }
  if (host === "gitlab") {
    if (env.GITLAB_TOKEN || env.GLAB_TOKEN) return env.GITLAB_TOKEN || env.GLAB_TOKEN;
    return readGlabConfig(env);
  }
  return null;
}

function tryGhToken(env = process.env) {
  try {
    const out = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const t = out.trim();
    return t && !t.includes("not logged") ? t : null;
  } catch {
    return null;
  }
}

function readGhHostsYml(env = process.env) {
  const file = join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "gh", "hosts.yml");
  try {
    const text = readFileSync(file, "utf8");
    // YAML: github.com: oauth_token: gho_xxx
    const m = text.match(/oauth_token:\s*["']?([A-Za-z0-9_\-\.]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function readGlabConfig(env = process.env) {
  const file = join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "glab-cli", "config.yml");
  try {
    const text = readFileSync(file, "utf8");
    const m = text.match(/token:\s*["']?([A-Za-z0-9_\-\.]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the selected remote's URL honoring insteadOf rewrites, and parse it.
 * Returns { repoInfo, url } or { repoInfo: null }.
 */
export async function repoInfoFor(repoPath, remote) {
  if (!remote) return { repoInfo: null, url: null };
  // `remote get-url` applies url.<base>.insteadOf rewrites
  const r = await gitRaw(repoPath, ["remote", "get-url", remote]);
  if (r.code !== 0) return { repoInfo: null, url: null };
  const url = r.stdout.trim();
  return { repoInfo: parseRemoteUrl(url), url };
}

/** Human-readable reason for a degraded host response. */
export function degradeWarning(res, host) {
  if (res.status === 401 || res.status === 403) return `${host} auth/rate limit (${res.status})`;
  if (res.status === 429) return `${host} rate limited`;
  if (res.status === 0) return `${host} unreachable: ${res.error ?? "network"}`;
  return `${host} api ${res.status}`;
}

// ---- politeness: pace + backoff + verdict cache ---------------------------
// Host lookups are read-only but still hit the API once per branch. To stay
// human-paced (no bursts that look like a bot), we:
//   1. pace: at least PACER_MIN_MS between consecutive requests (per process)
//   2. back off on 429/403 rate limits: honor Retry-After, capped, then
//      degrade the rest of the repo's lookups to offline
//   3. cache: positive verdicts per repo+branch+sha so rescans are no-ops

export const PACER_MIN_MS = 350;
let lastHostRequestAt = 0;

/** Wait so consecutive host requests are at least PACER_MIN_MS apart. */
export async function paceHostRequest(env = process.env) {
  const min = Number(env.GIT_REAP_PACER_MS || PACER_MIN_MS);
  const wait = lastHostRequestAt + min - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHostRequestAt = Date.now();
}

/**
 * Shared fetch wrapper: returns { ok, status, json } — never throws for
 * network/host errors; rate-limit (429 / 403 with retry-after) and auth
 * failures (401/403) surface as { ok:false, status } so callers degrade.
 * Paces each request; retries ONCE on 429/403 after honoring Retry-After
 * (capped at BACKOFF_MAX_MS). Returns { rateLimited: true } when the
 * response is still a rate limit after the retry, so the caller can stop
 * querying this repo and fall back to offline classification.
 */
const BACKOFF_MAX_MS = 15_000;

export async function hostFetch(
  url,
  { token, headers = {}, timeoutMs = 15_000, retry = true, env = process.env } = {},
) {
  await paceHostRequest(env);
  const res = await rawFetch(url, { token, headers, timeoutMs });
  if (retry && isRateLimited(res)) {
    const waitMs = Math.min(parseRetryAfter(res.retryAfter) ?? 2_000, BACKOFF_MAX_MS);
    await new Promise((r) => setTimeout(r, waitMs));
    const retried = await rawFetch(url, { token, headers, timeoutMs });
    if (isRateLimited(retried)) return { ...retried, rateLimited: true };
    return retried;
  }
  if (isRateLimited(res)) return { ...res, rateLimited: true };
  return res;
}

async function rawFetch(url, { token, headers = {}, timeoutMs = 15_000 }) {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "git-reap",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON body (proxy error page etc.) → treat as no verdict
    }
    return { ok: res.ok, status: res.status, json, retryAfter: res.headers.get("retry-after") };
  } catch (err) {
    return { ok: false, status: 0, json: null, error: err.message };
  }
}

/** True when a response is a rate-limit / auth failure that must degrade. */
export function isDegraded({ ok, status }) {
  return !ok && (status === 401 || status === 403 || status === 429 || status === 0);
}

/** True when a response is specifically a rate limit (429 or 403+retry-after). */
export function isRateLimited(res) {
  return res?.status === 429 || (res?.status === 403 && Boolean(res?.retryAfter));
}

function parseRetryAfter(v) {
  if (!v) return null;
  const secs = Number(v);
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : null;
}

// ---- verdict cache ---------------------------------------------------------

/**
 * Positive-verdict cache, one JSON file per repo at
 *   <dataDir>/host-cache/<host>/<owner>__<repo>.json
 * Shape: { "<branch>@<sha>": { verdict, evidence } }.
 * Only POSITIVE verdicts are cached (merged/closed are stable facts; open
 * PRs and nulls are cheap to re-check and can flip). The sha in the key
 * means a moved branch naturally misses the cache.
 */
export function hostCachePath(repoInfo, dataDir) {
  const owner = repoInfo.owner.replace(/\//g, "__");
  const repo = repoInfo.repo.replace(/\//g, "__");
  return join(dataDir, "host-cache", repoInfo.host, `${owner}__${repo}.json`);
}

export function readHostCache(repoInfo, dataDir) {
  try {
    return JSON.parse(readFileSync(hostCachePath(repoInfo, dataDir), "utf8"));
  } catch {
    return {};
  }
}

export function writeHostCache(repoInfo, dataDir, entries) {
  try {
    const path = hostCachePath(repoInfo, dataDir);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(entries, null, 1));
  } catch {
    // cache is best-effort; a failed write must never break the scan
  }
}
