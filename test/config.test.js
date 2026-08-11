import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_PROTECTED, configPaths, loadConfig } from "../src/config.js";

// join that normalizes to forward slashes: loadConfig returns posix-style
// paths when platform is forced, so expectations must match.
const pjoin = (...parts) => join(...parts).replaceAll("\\", "/");

function withTmp(fn) {
  // Normalize so HOME-style env matches posix joins in the module under test.
  const dir = join(tmpdir(), `reap-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}`).replaceAll("\\", "/");
  mkdirSync(dir, { recursive: true });
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("configPaths", () => {
  test("linux/mac uses XDG-style paths", () => {
    const p = configPaths({ HOME: "/home/u", platform: "linux" });
    expect(p.configFile).toBe("/home/u/.config/git-reap/config.toml");
    expect(p.dataDir).toBe("/home/u/.local/share/git-reap");
  });

  test("respects XDG_CONFIG_HOME and XDG_DATA_HOME", () => {
    const p = configPaths({
      HOME: "/home/u",
      XDG_CONFIG_HOME: "/xdg/cfg",
      XDG_DATA_HOME: "/xdg/data",
      platform: "linux",
    });
    expect(p.configFile).toBe("/xdg/cfg/git-reap/config.toml");
    expect(p.dataDir).toBe("/xdg/data/git-reap");
  });

  test("windows uses APPDATA/LOCALAPPDATA", () => {
    const p = configPaths({
      APPDATA: "C:\\Users\\u\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
      platform: "win32",
    });
    expect(p.configFile).toBe("C:\\Users\\u\\AppData\\Roaming\\git-reap\\config.toml");
    expect(p.dataDir).toBe("C:\\Users\\u\\AppData\\Local\\git-reap");
  });
});

describe("loadConfig", () => {
  test("defaults when no config file exists", async () => {
    await withTmp(async (dir) => {
      const cfg = await loadConfig({ env: { HOME: dir }, platform: "linux" });
      expect(cfg.staleDays).toBe(30);
      expect(cfg.fetch).toBe(false);
      expect(cfg.roots).toEqual([]);
      expect(cfg.protected).toEqual(BUILTIN_PROTECTED);
      expect(cfg.loadedFrom).toBeNull();
    });
  });

  test("reads TOML config; user protected EXTENDS built-ins", async () => {
    await withTmp(async (dir) => {
      const cfgDir = join(dir, ".config", "git-reap");
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(
        join(cfgDir, "config.toml"),
        'roots = ["~/projects", "~/code"]\nstale_days = 14\nfetch = true\nprotected = ["hotfix/*"]\n',
      );
      const cfg = await loadConfig({ env: { HOME: dir }, platform: "linux" });
      expect(cfg.roots).toEqual(["~/projects", "~/code"]);
      expect(cfg.staleDays).toBe(14);
      expect(cfg.fetch).toBe(true);
      expect(cfg.protected).toEqual([...BUILTIN_PROTECTED, "hotfix/*"]);
      expect(cfg.loadedFrom).toBe(pjoin(cfgDir, "config.toml"));
    });
  });

  test("flag > env > config > default precedence", async () => {
    await withTmp(async (dir) => {
      const cfgDir = join(dir, ".config", "git-reap");
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(join(cfgDir, "config.toml"), "stale_days = 14\n");
      const cfg = await loadConfig({
        env: { HOME: dir, GIT_REAP_STALE_DAYS: "20" },
        flags: { staleDays: 7 },
        platform: "linux",
      });
      expect(cfg.staleDays).toBe(7); // flag wins

      const cfgEnv = await loadConfig({
        env: { HOME: dir, GIT_REAP_STALE_DAYS: "20" },
        flags: {},
        platform: "linux",
      });
      expect(cfgEnv.staleDays).toBe(20); // env beats config
    });
  });

  test("flag roots override config roots entirely", async () => {
    await withTmp(async (dir) => {
      const cfgDir = join(dir, ".config", "git-reap");
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(join(cfgDir, "config.toml"), 'roots = ["~/projects"]\n');
      const cfg = await loadConfig({
        env: { HOME: dir },
        flags: { roots: ["~/other"] },
        platform: "linux",
      });
      expect(cfg.roots).toEqual(["~/other"]);
    });
  });

  test("reads per-repo default_branch + hosts section", async () => {
    await withTmp(async (dir) => {
      const cfgDir = join(dir, ".config", "git-reap");
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(
        join(cfgDir, "config.toml"),
        [
          'default_branch = "trunk"',
          'roots = ["~/projects"]',
          'hosts.github.base_url = "https://api.github.com"',
          'hosts.github.token = "gho_cfg"',
          "",
          '[repos."/home/u/projects/special"]',
          'default_branch = "develop"',
          'protected = ["experiment/*"]',
          "",
          '[repos."/home/u/projects/plain"]',
          'default_branch = "trunk"',
          "",
        ].join("\n"),
      );
      const cfg = await loadConfig({ env: { HOME: dir }, platform: "linux" });
      expect(cfg.defaultBranch).toBe("trunk");
      expect(cfg.hosts.github.token).toBe("gho_cfg");
      expect(cfg.hosts.github.base_url).toBe("https://api.github.com");
      const { repoConfig } = await import("../src/config.js");
      const special = repoConfig(cfg, "/home/u/projects/special");
      expect(special.defaultBranch).toBe("develop");
      expect(special.protected).toContain("experiment/*");
      const plain = repoConfig(cfg, "/home/u/projects/plain");
      expect(plain.defaultBranch).toBe("trunk");
    });
  });
});
