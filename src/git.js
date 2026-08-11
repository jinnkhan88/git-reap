// Thin async wrapper over the git CLI.
// Rules: arg arrays only, LC_ALL=C for parse stability, bounded output,
// per-command timeout, optional AbortSignal cancellation. Never parses
// human-oriented output.

import { spawn } from "node:child_process";

const MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const FS = "\x1f"; // field separator inside for-each-ref records

export class GitError extends Error {
  constructor(message, { args = [], code = null, stderr = "" } = {}) {
    super(message);
    this.name = "GitError";
    this.args = args;
    this.code = code;
    this.stderr = stderr;
  }
}

export function gitRaw(repo, args, { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: repo,
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let killReason = "";

    const kill = (reason) => {
      killed = true;
      killReason = reason;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => kill(`timeout after ${timeoutMs}ms`), timeoutMs);
    const onAbort = () => kill("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d) => {
      stdout += d;
      if (stdout.length > MAX_BUFFER) kill("output limit exceeded");
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.length > MAX_BUFFER) stderr = stderr.slice(0, MAX_BUFFER);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new GitError(`failed to spawn git: ${err.message}`, { args }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (killed) {
        reject(new GitError(`git ${args[0]}: ${killReason}`, { args, code, stderr }));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

/** Run git, trim stdout, throw GitError on non-zero exit. */
export async function git(repo, args, opts) {
  const r = await gitRaw(repo, args, opts);
  if (r.code !== 0) {
    throw new GitError(r.stderr.trim() || `git ${args[0]} exited ${r.code}`, {
      args,
      code: r.code,
      stderr: r.stderr,
    });
  }
  return r.stdout.trim();
}

/** Run git, report success as boolean (never throws on non-zero exit). */
export async function gitOk(repo, args, opts) {
  const r = await gitRaw(repo, args, opts);
  return r.code === 0;
}

/**
 * Structured ref listing. fields are for-each-ref atoms; records are
 * newline-separated, fields \x1f-separated (ref names cannot contain
 * control characters, so this is collision-safe).
 */
export async function forEachRef(repo, fields, pattern = "refs/heads", opts) {
  const format = fields.map((f) => `%(${f})`).join(FS);
  const out = await git(repo, ["for-each-ref", `--format=${format}`, pattern], opts);
  if (!out) return [];
  return out.split("\n").map((line) => {
    const parts = line.split(FS);
    return Object.fromEntries(fields.map((f, i) => [f, parts[i] ?? ""]));
  });
}

/** True when `a` is an ancestor of `b`. */
export async function isAncestor(repo, a, b, opts) {
  return gitOk(repo, ["merge-base", "--is-ancestor", a, b], opts);
}

/** Resolve a ref to a SHA, or null when it doesn't exist. */
export async function revParse(repo, ref, opts) {
  const r = await gitRaw(repo, ["rev-parse", "--verify", "--quiet", ref], opts);
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * Worktrees of a repo, parsed once from `git worktree list --porcelain -z`
 * (fields are NUL-separated). Returns [{ path, branch }]; `branch` is null
 * for a detached HEAD worktree. Returns null when the command fails —
 * callers decide whether that means "cannot enumerate" (guards) or "treat
 * as a single-worktree repo" (discovery).
 */
export async function listWorktrees(repo) {
  const r = await gitRaw(repo, ["worktree", "list", "--porcelain", "-z"]);
  if (r.code !== 0) return null;
  const out = [];
  let cur = null;
  for (const field of r.stdout.split("\0")) {
    if (field.startsWith("worktree ")) {
      cur = { path: field.slice("worktree ".length), branch: null };
      out.push(cur);
    } else if (field.startsWith("branch ") && cur) {
      cur.branch = field.slice("branch ".length).trim();
    }
  }
  return out;
}
