# Changelog

## Unreleased

### Added
- **Projects view** — browse the workspaces and projects you belong to, and clone a project's repository without leaving the editor. Projects with tasks assigned to you sort first.
- Cloning a project links the resulting folder automatically; no confirmation prompt for a clone you started.

### Changed
- **My Tasks is now scoped to the project of the folder you have open**, rather than listing every assigned task across every project. Work waiting in another repository appears as a task count in the Projects view.

### Fixed
- Project Context rendered, watched and opened files from the first workspace folder in a multi-root window regardless of which repository the editor was in.

## 0.1.0 — unreleased

First cut, implementing ADR 0019 against the cloud authority ADR 0020 establishes.

- Sign in through the browser, with a paste-a-code fallback for hosts where the URL scheme is
  not registered.
- **My Tasks**: everything assigned to you across workspaces, with checkbox close.
- **Project Context**: `AGENTS.md`, `docs/conventions.md` and the constitution, read from the
  clone, with a drift notice when the cloud's copy has moved on.
- **Copy Task Context** for handing a task to any AI assistant.
- Tasks close from commit subjects (`T3: …`), with the commit attached as evidence. Zero-padding
  no longer matters, and a revert does not re-close.
- Offline: cached task list, queued status writes, flushed on reconnect.

Not included, deliberately: the MCP server, `lm.registerTool`, the Comments API, cloning a
project, and the Anthropic-compat environment command. See ADR 0019.
