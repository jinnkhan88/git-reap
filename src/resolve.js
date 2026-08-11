// Default-branch + remote resolution.
// Precedence: explicit config → selected remote's symbolic HEAD →
// conventional local names (main/master/trunk) → conventional
// remote-tracking refs → safe failure ("no-default").

import { git, gitOk } from "./git.js";

const CONVENTIONAL = ["main", "master", "trunk"];

async function listRemotes(repo) {
  const out = await git(repo, ["remote"]).catch(() => "");
  return out ? out.split("\n").filter(Boolean) : [];
}

/** The remote to trust: current branch's upstream remote, else origin, else first. */
async function selectRemote(repo, remotes) {
  if (!remotes.length) return null;
  const head = await git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "");
  if (head) {
    const upstreamRemote = await git(repo, ["config", "--get", `branch.${head}.remote`]).catch(
      () => "",
    );
    if (upstreamRemote && remotes.includes(upstreamRemote)) return upstreamRemote;
  }
  if (remotes.includes("origin")) return "origin";
  return remotes[0];
}

async function existsRef(repo, ref) {
  return gitOk(repo, ["show-ref", "--verify", "--quiet", ref]);
}

/**
 * resolveRepo(repo, { config }) →
 *   ok:         { status:"ok", defaultBranch, defaultRef, remote, remotes, lastCommitTs }
 *   no-default: { status:"no-default", defaultBranch:null, defaultRef:null, remote, remotes }
 */
export async function resolveRepo(repo, { config = {} } = {}) {
  const remotes = await listRemotes(repo);
  const remote = await selectRemote(repo, remotes);

  const found = async (branch, ref) => {
    const ts = Number(await git(repo, ["log", "-1", "--format=%ct", ref]).catch(() => "0"));
    return {
      status: "ok",
      defaultBranch: branch,
      defaultRef: ref,
      remote,
      remotes,
      lastCommitTs: ts,
    };
  };

  // 1. explicit per-repo config
  if (config.defaultBranch) {
    const local = `refs/heads/${config.defaultBranch}`;
    const remoteRef = remote ? `refs/remotes/${remote}/${config.defaultBranch}` : null;
    if (await existsRef(repo, local)) return found(config.defaultBranch, local);
    if (remoteRef && (await existsRef(repo, remoteRef))) {
      return found(config.defaultBranch, remoteRef);
    }
    // configured but absent → fall through to detection rather than failing blind
  }

  // 2. selected remote's symbolic HEAD (refs/remotes/<remote>/HEAD)
  if (remote) {
    const headRef = `refs/remotes/${remote}/HEAD`;
    const target = await git(repo, ["symbolic-ref", "--quiet", headRef]).catch(() => "");
    if (target.startsWith(`refs/remotes/${remote}/`)) {
      const branch = target.slice(`refs/remotes/${remote}/`.length);
      const local = `refs/heads/${branch}`;
      if (await existsRef(repo, local)) return found(branch, local);
      if (await existsRef(repo, target)) return found(branch, target);
    }
  }

  // 3. conventional local names
  for (const name of CONVENTIONAL) {
    const ref = `refs/heads/${name}`;
    if (await existsRef(repo, ref)) return found(name, ref);
  }

  // 4. conventional remote-tracking names on the selected remote
  if (remote) {
    for (const name of CONVENTIONAL) {
      const ref = `refs/remotes/${remote}/${name}`;
      if (await existsRef(repo, ref)) return found(name, ref);
    }
  }

  // 5. safe failure
  return {
    status: "no-default",
    defaultBranch: null,
    defaultRef: null,
    remote,
    remotes,
    lastCommitTs: 0,
  };
}
