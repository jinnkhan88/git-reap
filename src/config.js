// Config loading. Precedence: flag > env > config > default.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { pathToFileURL } from "node:url";

export const BUILTIN_PROTECTED = ["main", "master", "develop", "dev", "release/*"];

const DEFAULTS = {
  roots: [],
  staleDays: 30,
  fetch: false,
  protected: [],
  hosts: {},
};

export function configPaths(env = process.env, platform) {
  const plat = platform ?? env.platform ?? process.platform;
  if (plat === "win32") {
    const appdata = env.APPDATA ?? win32.join(env.HOME ?? homedir(), "AppData", "Roaming");
    const localappdata = env.LOCALAPPDATA ?? win32.join(env.HOME ?? homedir(), "AppData", "Local");
    return {
      configFile: win32.join(appdata, "git-reap", "config.toml"),
      dataDir: win32.join(localappdata, "git-reap"),
    };
  }
  const home = env.HOME ?? homedir();
  const xdgConfig = env.XDG_CONFIG_HOME ?? join(home, ".config");
  const xdgData = env.XDG_DATA_HOME ?? join(home, ".local", "share");
  return {
    configFile: join(xdgConfig, "git-reap", "config.toml"),
    dataDir: join(xdgData, "git-reap"),
  };
}

async function readToml(file) {
  // Bun loads .toml natively via import.
  const mod = await import(pathToFileURL(file).href);
  return mod.default ?? mod;
}

function fromEnv(env) {
  const out = {};
  if (env.GIT_REAP_STALE_DAYS) {
    out.staleDays = Number.parseInt(env.GIT_REAP_STALE_DAYS, 10);
  }
  if (env.GIT_REAP_FETCH) {
    out.fetch = ["1", "true", "yes"].includes(env.GIT_REAP_FETCH.toLowerCase());
  }
  if (env.GIT_REAP_ROOTS) {
    out.roots = env.GIT_REAP_ROOTS.split(":").filter(Boolean);
  }
  return out;
}

function normalize(raw) {
  const out = {};
  if (Array.isArray(raw.roots)) out.roots = raw.roots.map(String);
  if (raw.stale_days !== undefined) out.staleDays = Number(raw.stale_days);
  if (raw.fetch !== undefined) out.fetch = Boolean(raw.fetch);
  if (Array.isArray(raw.protected)) out.protected = raw.protected.map(String);
  if (raw.default_branch !== undefined) out.defaultBranch = String(raw.default_branch);
  // per-repo overrides: [repos."/abs/path"] default_branch / protected
  if (raw.repos && typeof raw.repos === "object") {
    out.repos = {};
    for (const [path, cfg] of Object.entries(raw.repos)) {
      const r = {};
      if (cfg.default_branch !== undefined) r.defaultBranch = String(cfg.default_branch);
      if (Array.isArray(cfg.protected)) r.protected = cfg.protected.map(String);
      out.repos[path] = r;
    }
  }
  if (raw.hosts && typeof raw.hosts === "object") out.hosts = raw.hosts;
  return out;
}

/** Per-repo effective config: global defaults overlaid with the repo entry. */
export function repoConfig(config, repoPath) {
  const entry = config.repos?.[repoPath];
  if (!entry) return config;
  return {
    ...config,
    defaultBranch: entry.defaultBranch ?? config.defaultBranch,
    protected: [...BUILTIN_PROTECTED, ...(entry.protected ?? []), ...(config.protected ?? [])],
  };
}

export async function loadConfig({
  env = process.env,
  flags = {},
  platform = process.platform,
} = {}) {
  const paths = configPaths(env, platform);
  let fileCfg = {};
  let loadedFrom = null;
  if (existsSync(paths.configFile)) {
    fileCfg = normalize(await readToml(paths.configFile));
    loadedFrom = paths.configFile;
  }
  const envCfg = fromEnv(env);
  const flagCfg = {};
  if (flags.staleDays != null && !Number.isNaN(flags.staleDays)) {
    flagCfg.staleDays = flags.staleDays;
  }
  if (flags.fetch) flagCfg.fetch = true;
  if (flags.roots?.length) flagCfg.roots = flags.roots;

  const merged = { ...DEFAULTS, ...fileCfg, ...envCfg, ...flagCfg };
  return {
    ...merged,
    protected: [...BUILTIN_PROTECTED, ...(fileCfg.protected ?? [])],
    loadedFrom,
    dataDir: paths.dataDir,
  };
}
