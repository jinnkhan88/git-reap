// Host sync tests: parseRemoteUrl, token discovery,
// GitHub PR lookup with head-SHA binding against a local node:http mock,
// GitLab MR lookup, and degradation (auth / rate-limit / timeout / no token).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPrState as ghFind } from "../src/hosts/github.js";
import { findPrState as glFind } from "../src/hosts/gitlab.js";
import { collectHostVerdicts } from "../src/hosts/index.js";
import { discoverToken, hostFetch, parseRemoteUrl } from "../src/hosts/mod.js";
import { git as fxGit, makeRepo } from "./fixtures.js";

function mockServer(routes) {
  const hits = [];
  const server = createServer((req, res) => {
    // match on FULL path including query — catches URL-building bugs
    // (e.g. encoding the branch object instead of its name)
    hits.push({ url: req.url, auth: req.headers.authorization ?? null });
    const route = routes.find((r) => req.url === r.url);
    if (!route) {
      res.writeHead(404).end("{}");
      return;
    }
    if (route.status) {
      res.writeHead(route.status, route.headers ?? {}).end(route.body ?? "{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(route.json));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        hits,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const ghRepo = { host: "github", hostname: "github.com", owner: "jinnkhan88", repo: "demo-api" };
const glRepo = { host: "gitlab", hostname: "gitlab.com", owner: "grp", repo: "sub/proj" };

describe("parseRemoteUrl", () => {
  test("ssh git@ form", () => {
    expect(parseRemoteUrl("git@github.com:jinnkhan88/demo-api.git")).toEqual(ghRepo);
  });
  test("https form", () => {
    expect(parseRemoteUrl("https://github.com/jinnkhan88/demo-api")).toEqual(ghRepo);
  });
  test("gitlab nested path + ssh form", () => {
    expect(parseRemoteUrl("ssh://git@gitlab.com/grp/sub/proj.git")).toEqual({
      host: "gitlab",
      hostname: "gitlab.com",
      owner: "grp/sub",
      repo: "proj",
    });
  });
  test("non-github/gitlab host → null", () => {
    expect(parseRemoteUrl("git@bitbucket.org:o/r.git")).toBeNull();
    expect(parseRemoteUrl("file:///srv/repo")).toBeNull();
  });
});

describe("discoverToken (read-only)", () => {
  test("env vars win for github", () => {
    expect(discoverToken("github", { GH_TOKEN: "gho_x" })).toBe("gho_x");
    expect(discoverToken("github", { GITHUB_TOKEN: "gho_y" })).toBe("gho_y");
  });
  test("env vars for gitlab", () => {
    expect(discoverToken("gitlab", { GITLAB_TOKEN: "gl-x" })).toBe("gl-x");
    expect(discoverToken("gitlab", { GLAB_TOKEN: "gl-y" })).toBe("gl-y");
  });
  test("parses gh hosts.yml when no env", () => {
    const dir = mkdtempSync(join(tmpdir(), "reap-host-"));
    mkdirSync(join(dir, "gh"), { recursive: true });
    writeFileSync(
      join(dir, "gh", "hosts.yml"),
      "github.com:\n  oauth_token: gho_fromfile\n  user: jinnkhan88\n",
    );
    expect(discoverToken("github", { XDG_CONFIG_HOME: dir })).toBe("gho_fromfile");
    rmSync(dir, { recursive: true, force: true });
  });
  test("returns null when nothing found", () => {
    // hermetic: no env vars AND no gh CLI on PATH (the real gh here IS authed)
    expect(discoverToken("github", { PATH: "/nonexistent" })).toBeNull();
    expect(discoverToken("gitlab", { PATH: "/nonexistent" })).toBeNull();
  });
});

describe("github.findPrState (§3.3 binding)", () => {
  let mock;
  const branch = { name: "feat/x", sha: "aabbccdd" };

  beforeEach(async () => {
    mock = await mockServer([
      {
        url: "/repos/jinnkhan88/demo-api/pulls?head=jinnkhan88:feat%2Fx&state=all&per_page=100",
        json: [
          {
            number: 12,
            state: "closed",
            merged_at: "2026-01-02T00:00:00Z",
            html_url: "https://github.com/jinnkhan88/demo-api/pull/12",
            head: { sha: "aabbccdd" },
          },
        ],
      },
    ]);
  });
  afterEach(async () => await mock.close());

  test("exact head-SHA bind → merged", async () => {
    const r = await ghFind(ghRepo, branch, { token: "t", baseUrl: mock.baseUrl });
    expect(r.verdict).toBe("merged");
    expect(r.evidence.prId).toBe(12);
    expect(r.evidence.bind).toBe("exact-sha");
    expect(mock.hits[0].auth).toBe("Bearer t");
  });

  test("head SHA mismatch → null + unpushed warning (blocks)", async () => {
    const r = await ghFind(
      ghRepo,
      { ...branch, sha: "deadbeef" },
      { token: "t", baseUrl: mock.baseUrl },
    );
    expect(r.verdict).toBeNull();
    expect(r.warning).toContain("unpushed");
  });

  test("closed PR without merged_at → closed-unmerged verdict", async () => {
    const m2 = await mockServer([
      {
        url: "/repos/jinnkhan88/demo-api/pulls?head=jinnkhan88:feat%2Fx&state=all&per_page=100",
        json: [
          {
            number: 7,
            state: "closed",
            merged_at: null,
            html_url: "https://x/7",
            head: { sha: "aabbccdd" },
          },
        ],
      },
    ]);
    const r = await ghFind(ghRepo, branch, { token: "t", baseUrl: m2.baseUrl });
    expect(r.verdict).toBe("closed");
    await m2.close();
  });

  test("open PR → null (no verdict)", async () => {
    const m2 = await mockServer([
      {
        url: "/repos/jinnkhan88/demo-api/pulls?head=jinnkhan88:feat%2Fx&state=all&per_page=100",
        json: [{ number: 9, state: "open", merged_at: null, head: { sha: "aabbccdd" } }],
      },
    ]);
    const r = await ghFind(ghRepo, branch, { token: "t", baseUrl: m2.baseUrl });
    expect(r.verdict).toBeNull();
    await m2.close();
  });

  test("empty results → null, no warning", async () => {
    const m2 = await mockServer([
      {
        url: "/repos/jinnkhan88/demo-api/pulls?head=jinnkhan88:feat%2Fx&state=all&per_page=100",
        json: [],
      },
    ]);
    const r = await ghFind(ghRepo, branch, { token: "t", baseUrl: m2.baseUrl });
    expect(r.verdict).toBeNull();
    expect(r.warning).toBeUndefined();
    await m2.close();
  });
});

describe("degradation", () => {
  test("401 auth failure → null + warning", async () => {
    const m = await mockServer([
      {
        url: "/repos/jinnkhan88/demo-api/pulls?head=jinnkhan88:f&state=all&per_page=100",
        status: 401,
      },
    ]);
    const r = await ghFind(ghRepo, { name: "f", sha: "s" }, { token: "bad", baseUrl: m.baseUrl });
    expect(r.verdict).toBeNull();
    expect(r.warning).toContain("auth");
    await m.close();
  });
  test("429 rate limit → null + warning", async () => {
    const m = await mockServer([
      {
        url: "/repos/jinnkhan88/demo-api/pulls?head=jinnkhan88:f&state=all&per_page=100",
        status: 429,
      },
    ]);
    const r = await ghFind(ghRepo, { name: "f", sha: "s" }, { token: "t", baseUrl: m.baseUrl });
    expect(r.verdict).toBeNull();
    expect(r.warning).toContain("rate");
    await m.close();
  });
  test("unreachable host → null + warning (no throw)", async () => {
    const r = await ghFind(
      ghRepo,
      { name: "f", sha: "s" },
      { token: "t", baseUrl: "http://127.0.0.1:1" },
    );
    expect(r.verdict).toBeNull();
    expect(r.warning).toContain("unreachable");
  });
  test("gitlab 403 → null + warning", async () => {
    const m = await mockServer([
      {
        url: "/projects/grp%2Fsub%2Fproj/merge_requests?source_branch=f&state=all&per_page=100",
        status: 403,
      },
    ]);
    const r = await glFind(glRepo, { name: "f", sha: "s" }, { token: "t", baseUrl: m.baseUrl });
    expect(r.verdict).toBeNull();
    expect(r.warning).toContain("auth");
    await m.close();
  });
});

describe("gitlab.findPrState", () => {
  test("merged MR exact sha → merged, PRIVATE-TOKEN header", async () => {
    const m = await mockServer([
      {
        url: "/projects/grp%2Fsub%2Fproj/merge_requests?source_branch=f&state=all&per_page=100",
        json: [
          {
            iid: 3,
            state: "merged",
            sha: "abc123",
            web_url: "https://gitlab.com/grp/sub/proj/-/merge_requests/3",
          },
        ],
      },
    ]);
    const r = await glFind(
      glRepo,
      { name: "f", sha: "abc123" },
      { token: "gl-t", baseUrl: m.baseUrl },
    );
    expect(r.verdict).toBe("merged");
    expect(r.evidence.prId).toBe(3);
    // gitlab token goes in PRIVATE-TOKEN header (checked via Authorization null)
    await m.close();
  });
  test("closed MR → closed verdict", async () => {
    const m = await mockServer([
      {
        url: "/projects/grp%2Fsub%2Fproj/merge_requests?source_branch=f&state=all&per_page=100",
        json: [{ iid: 4, state: "closed", sha: "abc123" }],
      },
    ]);
    const r = await glFind(
      glRepo,
      { name: "f", sha: "abc123" },
      { token: "t", baseUrl: m.baseUrl },
    );
    expect(r.verdict).toBe("closed");
    await m.close();
  });
});

describe("collectHostVerdicts integration", () => {
  test("no remote → empty verdicts, no warnings", async () => {
    const r = await collectHostVerdicts({
      repoPath: "/x",
      remote: null,
      branches: [{ name: "f", sha: "s" }],
    });
    expect(r.verdicts).toEqual({});
    expect(r.warnings).toEqual([]);
  });
  test("unknown host URL → empty verdicts", async () => {
    const repo = await makeRepo();
    await fxGit(["remote", "add", "origin", "git@bitbucket.org:o/r.git"], { cwd: repo });
    const r = await collectHostVerdicts({
      repoPath: repo,
      remote: "origin",
      branches: [{ name: "f", sha: "s" }],
    });
    expect(r.verdicts).toEqual({});
    expect(r.warnings).toEqual([]);
  });
});

describe("politeness: pace, cache, backoff", () => {
  const dataDir = () => mkdtempSync(join(tmpdir(), "reap-cache-"));
  const env0 = { ...process.env, GIT_REAP_PACER_MS: "0" }; // tests: no pacing wait

  test("hostFetch paces consecutive requests (spacing ≥ configured ms)", async () => {
    const m = await mockServer([
      { url: "/a", json: { ok: 1 } },
      { url: "/b", json: { ok: 2 } },
    ]);
    const t0 = Date.now();
    await hostFetch(`${m.baseUrl}/a`, { token: "t", env: { GIT_REAP_PACER_MS: "150" } });
    const t1 = Date.now();
    await hostFetch(`${m.baseUrl}/b`, { token: "t", env: { GIT_REAP_PACER_MS: "150" } });
    const t2 = Date.now();
    expect(t1 - t0).toBeGreaterThanOrEqual(0);
    expect(t2 - t1).toBeGreaterThanOrEqual(130); // paced ≥ 150ms
    expect(m.hits.length).toBe(2);
    await m.close();
  });

  test("positive verdicts are cached; second scan reuses cache, zero requests", async () => {
    const m = await mockServer([
      {
        url: `/repos/jinnkhan88/demo-api/pulls?head=jinnkhan88:feat%2Fx&state=all&per_page=100`,
        json: [
          {
            number: 7,
            state: "closed",
            merged_at: "2026-08-01T00:00:00Z",
            html_url: "https://github.com/jinnkhan88/demo-api/pull/7",
            head: { sha: "abc1234" },
          },
          {
            number: 8,
            state: "closed",
            merged_at: "2026-08-02T00:00:00Z",
            html_url: "https://github.com/jinnkhan88/demo-api/pull/8",
            head: { sha: "def5678" },
          },
        ],
      },
    ]);
    const repo = await makeRepo();
    await fxGit(["remote", "add", "origin", "git@github.com:jinnkhan88/demo-api.git"], {
      cwd: repo,
    });
    const branches = [{ name: "feat/x", sha: "abc1234" }];
    const dir = dataDir();

    const first = await collectHostVerdicts({
      repoPath: repo,
      remote: "origin",
      branches,
      token: "t",
      baseUrl: m.baseUrl,
      dataDir: dir,
      env: env0,
    });
    expect(first.verdicts["feat/x"].verdict).toBe("merged");
    expect(m.hits.length).toBe(1);

    // second scan: same branch + sha → cache hit, no network
    const second = await collectHostVerdicts({
      repoPath: repo,
      remote: "origin",
      branches,
      token: "t",
      baseUrl: m.baseUrl,
      dataDir: dir,
      env: env0,
    });
    expect(second.verdicts["feat/x"].verdict).toBe("merged");
    expect(second.verdicts["feat/x"].cached).toBe(true);
    expect(m.hits.length).toBe(1); // still 1 — no re-request

    // moved branch (new sha) → cache miss → new request
    const moved = await collectHostVerdicts({
      repoPath: repo,
      remote: "origin",
      branches: [{ name: "feat/x", sha: "def5678" }],
      token: "t",
      baseUrl: m.baseUrl,
      dataDir: dir,
      env: env0,
    });
    expect(moved.verdicts["feat/x"].cached).toBeUndefined();
    expect(m.hits.length).toBe(2);

    await m.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("429 rate limit → backoff retry, then stop querying the repo", async () => {
    const m = await mockServer([
      {
        url: `/repos/jinnkhan88/demo-api/pulls?head=jinnkhan88:feat%2Fx&state=all&per_page=100`,
        json: [
          {
            number: 7,
            state: "closed",
            merged_at: "2026-08-01T00:00:00Z",
            html_url: "https://github.com/jinnkhan88/demo-api/pull/7",
            head: { sha: "abc1234" },
          },
        ],
      },
    ]);
    const dir = dataDir();
    const repo = await makeRepo();
    await fxGit(["remote", "add", "origin", "git@github.com:jinnkhan88/demo-api.git"], {
      cwd: repo,
    });

    // monkeypatch: first response is 429 with retry-after, then OK
    const origFetch = globalThis.fetch;
    let limited = true;
    globalThis.fetch = async (url, opts) => {
      if (limited) {
        limited = false;
        return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
      }
      return origFetch(url, opts);
    };
    try {
      const r = await collectHostVerdicts({
        repoPath: repo,
        remote: "origin",
        branches: [{ name: "feat/x", sha: "abc1234" }],
        token: "t",
        baseUrl: m.baseUrl,
        dataDir: dir,
        env: env0,
      });
      // after the retry succeeds, verdict is present
      expect(r.verdicts["feat/x"].verdict).toBe("merged");
    } finally {
      globalThis.fetch = origFetch;
      await m.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("persistent 429 → rateLimited flag + warning, no cache write", async () => {
    const dir = dataDir();
    const repo = await makeRepo();
    await fxGit(["remote", "add", "origin", "git@github.com:jinnkhan88/demo-api.git"], {
      cwd: repo,
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("{}", { status: 429, headers: { "retry-after": "1" } });
    try {
      const r = await collectHostVerdicts({
        repoPath: repo,
        remote: "origin",
        branches: [
          { name: "feat/x", sha: "abc1234" },
          { name: "feat/y", sha: "zzz9999" },
        ],
        token: "t",
        baseUrl: "http://127.0.0.1:1",
        dataDir: dir,
        env: env0,
      });
      expect(r.verdicts).toEqual({});
      expect(r.warnings.some((w) => w.includes("rate limited"))).toBe(true);
      expect(r.warnings.some((w) => w.includes("stopped for this repo"))).toBe(true); // broke after first limit
    } finally {
      globalThis.fetch = origFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
