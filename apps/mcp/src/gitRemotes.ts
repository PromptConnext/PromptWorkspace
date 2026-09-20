// A folder's git remotes, without an editor to ask.
//
// apps/vscode gets these from the built-in Git extension's API
// (src/git/gitBridge.ts). There is no such API here, so the remotes come from
// git itself — `execFile`, never `exec`: the workspace root is caller-supplied
// input, and handing it to a shell would make a folder name an injection point.
// It is passed as `cwd` rather than as a `git -C <path>` argument for the same
// reason a leading `-` is refused in repoUrl.ts — a path is never an argument
// here, so it can never be read as a flag.
//
// Running in a subdirectory is deliberate and correct: git walks up to the
// repository root by itself, so a developer whose agent is scoped to
// `packages/api` still resolves the clone's project.
//
// Shelling out matches apps/engine, which does exactly this for every git
// operation it performs (agent/loop.ts, agent/agent-runner.ts). The alternative
// — parsing `.git/config` by hand — would have to reimplement includes,
// worktree `.git` files and conditional includes to be correct, and would be
// wrong for exactly the developers who configure git carefully.

import { execFile } from "node:child_process";

export interface GitRemotes {
  /** False when the folder is not inside a git repository at all — a different
   *  problem from a repository with no remote, and a different thing to tell
   *  the developer. */
  isRepository: boolean;
  /** Fetch and push URLs, de-duplicated, in the order git reports them. */
  remotes: string[];
}

const GIT_TIMEOUT_MS = 10_000;

export async function readGitRemotes(dir: string): Promise<GitRemotes> {
  let stdout: string;
  try {
    stdout = await runGit(dir, ["remote", "-v"]);
  } catch {
    // A non-zero exit ("not a git repository"), a missing directory, a missing
    // git binary and a timeout all land here. None of them is recoverable by
    // this server, and all of them mean the same thing to the caller: we could
    // not read a remote for this folder.
    return { isRepository: false, remotes: [] };
  }
  return { isRepository: true, remotes: parseRemotes(stdout) };
}

/** Parse `git remote -v` output: `<name>\t<url> (fetch|push)` per line. */
export function parseRemotes(stdout: string): string[] {
  const seen = new Set<string>();
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const url = parts[1];
    if (url) seen.add(url);
  }
  return [...seen];
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });
}
