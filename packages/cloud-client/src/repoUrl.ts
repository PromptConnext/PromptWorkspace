// Repository URL handling: the guard, and the comparison.
//
// `assertCloneableRepoUrl` is ported from apps/engine/src/routes/projects.ts
// (:173-183) with its threat model intact. Cloning is out of a task client's
// scope, so its new job is to refuse a hostile `repo_url` arriving from the
// cloud before we normalise, render or ever hand it to git — `ext::sh -c …` is
// remote code execution, and a leading `-` is argument injection into whatever
// git command a future phase adds.
//
// Shared rather than duplicated (plan 0025 M2): apps/vscode matches a folder's
// remotes against the roster to offer a link, and apps/mcp matches the same
// remotes against the same roster to answer `get_project_rules` for the
// developer's cwd. Two surfaces disagreeing about whether `git@github.com:a/b`
// is `https://github.com/a/b.git` would resolve the same clone to two different
// projects, so there is exactly one copy of the answer.

const HTTPS_REPO_URL_RE =
  /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d+)?\/\S+$/;
const SSH_SHORTHAND_REPO_URL_RE =
  /^[A-Za-z0-9_.-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?:\S+$/;

export class UnsafeRepoUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeRepoUrlError";
  }
}

export function assertCloneableRepoUrl(url: unknown): string {
  if (typeof url !== "string" || url.trim() === "") {
    throw new UnsafeRepoUrlError("repository URL is empty");
  }
  const value = url.trim();
  if (value.startsWith("-")) {
    throw new UnsafeRepoUrlError("repository URL may not begin with '-'");
  }
  if (!HTTPS_REPO_URL_RE.test(value) && !SSH_SHORTHAND_REPO_URL_RE.test(value)) {
    throw new UnsafeRepoUrlError(`unsupported repository URL: ${value}`);
  }
  return value;
}

export function isCloneableRepoUrl(url: unknown): boolean {
  try {
    assertCloneableRepoUrl(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reduce a remote to a comparable `host/path` key.
 *
 * The same repository legitimately appears as an https URL in the cloud and an
 * SSH shorthand in a developer's remote, with or without `.git`, with or
 * without credentials, and in any case. Matching those by string equality
 * would fail for most real clones, which is the whole reason this exists.
 *
 * Returns null for anything unrecognised — a caller must treat that as "no
 * match", never as "matches everything".
 */
export function normalizeRepoUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim();
  if (!value) return null;

  // git@host:owner/repo -> host/owner/repo
  const ssh = /^[A-Za-z0-9_.-]+@([^:/]+):(.+)$/.exec(value);
  if (ssh) {
    value = `${ssh[1]}/${ssh[2]}`;
  } else {
    const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)
      ? value
      : `https://${value}`;
    let url: URL;
    try {
      url = new URL(withScheme);
    } catch {
      return null;
    }
    if (!url.hostname) return null;
    value = `${url.hostname}${url.pathname}`;
  }

  value = value.toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
  value = value.replace(/\/{2,}/g, "/");
  return value || null;
}

export function sameRepo(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeRepoUrl(a);
  const right = normalizeRepoUrl(b);
  return left !== null && left === right;
}

/** How a folder's remote relates to a project's `repo_url`. */
export type RemoteMatch = "exact" | "alias" | "none";

/**
 * The host an SSH-config alias stands for, or the host itself.
 *
 * Developers with two accounts on one git host write `Host github.com-work` in
 * `~/.ssh/config` and clone from `git@github.com-work:org/repo`; `git remote -v`
 * (what both surfaces read) shows the alias, never the real host. A TLD never
 * contains a hyphen, so a hyphen in the LAST label is the alias suffix. A
 * hyphen anywhere else (`my-github.com`) is part of a real host name, and an
 * IDN TLD (`xn--…`) is left alone.
 */
function aliasBaseHost(host: string): string {
  const lastDot = host.lastIndexOf(".");
  if (lastDot < 0) return host;
  const label = host.slice(lastDot + 1);
  if (label.startsWith("xn--")) return host;
  const dash = label.indexOf("-");
  if (dash <= 0 || dash === label.length - 1) return host;
  return host.slice(0, lastDot + 1 + dash);
}

function splitKey(key: string): { host: string; path: string } {
  const slash = key.indexOf("/");
  return slash < 0
    ? { host: key, path: "" }
    : { host: key.slice(0, slash), path: key.slice(slash + 1) };
}

/** Whether a URL-form remote names a port (`ssh://host:2222/…`). The SSH
 *  shorthand `user@host:path` cannot carry one. */
function hasExplicitPort(raw: string): boolean {
  const value = raw.trim();
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return false;
  try {
    return new URL(value).port !== "";
  } catch {
    return false;
  }
}

/**
 * `exact` when the two name one repository on one host (what `sameRepo`
 * answers). `alias` only when the hosts differ solely by a `-<suffix>` on the
 * same base host AND the owner/repo path is identical AND neither side names a
 * port — a port picks a server, and an alias is too weak a claim to say it is
 * the same one. Anything else, and anything unparseable, is `none`.
 */
export function remotesMatch(remote: string, repoUrl: string): RemoteMatch {
  const left = normalizeRepoUrl(remote);
  const right = normalizeRepoUrl(repoUrl);
  if (left === null || right === null) return "none";
  if (left === right) return "exact";
  const a = splitKey(left);
  const b = splitKey(right);
  if (!a.path || a.path !== b.path) return "none";
  if (hasExplicitPort(remote) || hasExplicitPort(repoUrl)) return "none";
  return aliasBaseHost(a.host) === aliasBaseHost(b.host) ? "alias" : "none";
}

/**
 * The roster projects a folder with these remotes belongs to.
 *
 * Exact matches win and are all returned, as before — a monorepo or a fork can
 * legitimately name several, and the caller asks which. Alias matches are a
 * weaker claim (the alias could point anywhere; we only know its spelling), so
 * they are used only when nothing matched exactly, and only when exactly ONE
 * project matches: an alias that fits two projects links neither rather than
 * picking one.
 */
export function projectsMatchingRemotes<T extends { repoUrl?: string | null }>(
  remotes: readonly string[],
  candidates: readonly T[],
): T[] {
  const kind = (candidate: T): RemoteMatch => {
    const url = candidate.repoUrl;
    if (!url) return "none";
    let best: RemoteMatch = "none";
    for (const remote of remotes) {
      const match = remotesMatch(remote, url);
      if (match === "exact") return "exact";
      if (match === "alias") best = "alias";
    }
    return best;
  };
  const kinds = candidates.map((candidate) => ({ candidate, match: kind(candidate) }));
  const exact = kinds.filter((k) => k.match === "exact").map((k) => k.candidate);
  if (exact.length > 0) return exact;
  const alias = kinds.filter((k) => k.match === "alias").map((k) => k.candidate);
  return alias.length === 1 ? alias : [];
}
