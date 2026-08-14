// Repository URL handling: the guard, and the comparison.
//
// `assertCloneableRepoUrl` is ported from apps/engine/src/routes/projects.ts
// (:173-183) with its threat model intact. Cloning is out of this extension's
// scope, so its new job is to refuse a hostile `repo_url` arriving from the
// cloud before we normalise, render or ever hand it to git — `ext::sh -c …` is
// remote code execution, and a leading `-` is argument injection into whatever
// git command a future phase adds.

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
