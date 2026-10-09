# Matching a folder's git remote to a project

**Status:** normative · **Finding:** #35 (trust test, 2026-10-09) · **Code:** `packages/cloud-client/src/repoUrl.ts`

Both editor surfaces answer "which cloud project is this folder?" by comparing the folder's git remotes with each roster project's `repo_url`. `apps/vscode` uses the answer to offer a link and to mark a project as cloned in the Projects view; `apps/mcp` uses it to resolve `get_project_rules` and `close_task` for a `workspace_root`. There is one implementation, in `packages/cloud-client`, so the two can never disagree about the same clone.

## The rule

A remote and a `repo_url` are first reduced to a `host/owner/repo` key by `normalizeRepoUrl`: scheme, credentials, a trailing `.git`, trailing slashes and case are dropped, and the SSH shorthand `git@host:owner/repo` becomes `host/owner/repo`. Anything that does not parse is "no match", never "matches everything".

`remotesMatch(remote, repoUrl)` then answers one of three things. **`exact`** when the two keys are equal. **`alias`** when the paths are identical and the hosts differ only by a `-<suffix>` on the same base host — `github.com-work` and `github.com`. That is the spelling a developer with two accounts on one git host gets from `Host github.com-work` in `~/.ssh/config`, and `git remote -v` shows the alias, never the real host (`url.*.insteadOf` does not help: the rewritten URL is what `git remote -v` prints). The suffix is recognised only in the last label, because a top-level domain never contains a hyphen; a hyphen elsewhere (`my-github.com`) is part of a real host name. **`none`** for everything else, including a different owner or repository on an aliased host.

`projectsMatchingRemotes(remotes, candidates)` turns that into a decision over the whole roster. Exact matches win, and all of them are returned, as before: a fork or a monorepo can legitimately name several projects, and the caller asks the developer which. An alias match is a weaker claim — the alias could point at any host — so it is consulted only when nothing matched exactly, and it counts only when **exactly one** project matches. An alias that fits two projects links neither; it never picks one. The manual "Link This Folder to a Project…" command (VS Code) and the `project_id` argument (MCP) remain the way out for that case.

Pending-clone linking (`pendingCloneMatches`) still uses exact matching: the folder it links was cloned from the very `repo_url` it is compared with.
