# PromptWorkspace — Development & Cross-Platform Build Guide

How to develop PromptWorkspace and how to build the desktop app for **both macOS and Windows from a Mac M1** (Apple Silicon). For deep macOS packaging detail (bundle contents, security posture, notarization), see [BUILD_AND_DISTRIBUTE.md](./BUILD_AND_DISTRIBUTE.md) — this guide covers the day-to-day workflow and extends it with the Windows story.

## Layout

| App | Stack | Purpose |
|---|---|---|
| `apps/desktop` | Tauri 2 (Rust shell) + React/Vite webview | The app window; spawns the engine as a sidecar |
| `apps/engine` | Node 24 / TypeScript (Hono, `node:sqlite`, `node-pty`) | Local engine on `127.0.0.1:47131` — runs TS natively, no build step |
| `apps/cloud` | FastAPI + Supabase/Postgres | **Optional** sync/collaboration backend; defaults to production (`https://api.workspace.promptconnext.com`), override with `CLOUD_API_URL`, or set it to `""` to disable |
| `apps/vscode` | VS Code extension (TypeScript, esbuild) | Assigned tasks, project coding rules and commit-driven task close, straight against `apps/cloud` — no sidecar (ADR 0019) |

Decisions live in `docs/decisions/` (ADRs 0001–0010). The two that shape everything: the app is a **Tauri shell + Node sidecar** (0001), and implementation is **BYO-agent** (0009) — PromptWorkspace orchestrates the AI subscription you already have (**Claude Code, Gemini CLI, Codex CLI**, or any CLI via `PROMPTWORKSPACE_AGENT_CMD`) rather than shipping a model runtime. Ollama (`ollama pull qwen3:8b`) is the zero-cost fallback for onboarding.

## Prerequisites (Mac M1)

```bash
brew install node pnpm          # Node ≥ 24 is a hard requirement (node:sqlite, native TS)
node -v                          # must be >= v24 — this exact binary ships inside the app
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust for the shell
xcode-select --install
```

Everything is native arm64; no Rosetta needed.

## Development

```bash
pnpm install
```

**Full desktop app** — Tauri window + engine sidecar + hot-reload UI:

```bash
pnpm desktop        # = pnpm --dir apps/desktop tauri dev  (first run compiles Rust)
```

**Browser-only** — fastest UI iteration, no Rust compile:

```bash
pnpm engine                    # terminal 1: engine on 127.0.0.1:47131 (tokenless in this mode)
pnpm --dir apps/desktop dev    # terminal 2: Vite on http://localhost:1420
```

**Cloud backend (optional)** — only needed when working on sync/collaboration:

```bash
cd apps/cloud
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8080     # in-memory backend, stub auth — no Supabase
pytest                                         # cloud is the only app with a test suite today
```

**VS Code extension** — no Rust, no engine, no sidecar:

```bash
pnpm vscode                      # = pnpm --dir apps/vscode watch  (esbuild, incremental)
pnpm --dir apps/vscode typecheck
pnpm --dir apps/vscode test      # node --test on the pure modules; no editor host needed
pnpm --dir apps/vscode package   # produces a .vsix
```

Open `apps/vscode` in VS Code and press **F5** for an Extension Development Host. Point it at a
local cloud with the `promptworkspace.cloudApiUrl` / `promptworkspace.cloudWebUrl` settings — the
extension reads settings, never `process.env`, because nothing sets env for the extension host.
Settings: `cloudApiUrl`, `cloudWebUrl`, `supabaseUrl`, `supabaseAnonKey`, `projectId`
(resource-scoped, safe to commit), `closeTasksFromCommits`, `commitScanLimit`.

The one repo-level rule worth knowing: `src/git/git.d.ts` is a **vendored, pinned copy** of the
built-in Git extension's API, and `src/git/gitBridge.ts` is the only file allowed to import it.
`pnpm --dir apps/vscode typecheck` is what catches it drifting.

Point the engine at it with `CLOUD_API_URL=http://localhost:8080` — otherwise the engine talks to the hosted production instance by default. For real auth/persistence against your local instance, set `DATA_BACKEND=supabase`, `SUPABASE_URL`, `SUPABASE_KEY` and `RAG_KEY_ENCRYPTION_KEY` (the service refuses to start a supabase backend without it; see `apps/cloud/README.md`).

**Local Supabase after the rename.** `supabase/config.toml`'s `project_id` is now `"PromptWorkspace"`. The CLI names its Docker containers and volumes after it, so a stack started before the rename is not reused: run `supabase stop --all --no-backup` once to drop every local stack's containers and volumes, then `supabase start` and re-apply the two-file baseline (`python scripts/migrate.py apply --var embed_dim=1024` from `apps/cloud`).

**Key environment variables** (engine, `apps/engine/src/config.ts`): `PROMPTWORKSPACE_ENGINE_PORT` (default 47131), `CLOUD_API_URL` (defaults to production, `https://api.workspace.promptconnext.com`; set to `""` to disable cloud sync, or a `http://localhost:8080`-style URL to target a local `apps/cloud` checkout), `SUPABASE_URL` + `SUPABASE_ANON_KEY` (unset = stub cloud auth), `PROMPTWORKSPACE_AGENT_CMD` (custom coding-agent CLI; task text arrives in `$TASK_PROMPT`).

## How packaging works — read this before any cross-build

`pnpm tauri build` runs `pnpm build && pnpm stage:engine` first. `stage:engine` makes a symlink-free hoisted copy of the engine into `src-tauri/.engine-pkg`, then `scripts/bundle-node.mjs` copies **the build machine's own Node binary** (`process.execPath`) into it — guaranteeing the Node ABI matches the installed `node-pty` prebuild. The staged engine ships as a Tauri resource.

The consequence: **the bundled Node runtime and `node-pty` addon are host-platform artifacts.** A build made on arm64 macOS embeds arm64 macOS Node. Cross-compiling the Rust shell alone never produces a working app for another platform — the engine must be staged *on* (or *for*) the target platform too.

## Build target 1 — macOS Apple Silicon: works today

```bash
cd apps/desktop
pnpm tauri build
# → src-tauri/target/release/bundle/macos/PromptWorkspace.app  (~192 MB)
```

The result is fully self-contained (no repo, no system Node needed to run it). For a distributable disk image add `"dmg"` to `bundle.targets` in `tauri.conf.json`. The app is unsigned — testers must `xattr -dr com.apple.quarantine PromptWorkspace.app` or right-click → Open; signing/notarization steps are in [BUILD_AND_DISTRIBUTE.md §6](./BUILD_AND_DISTRIBUTE.md).

## Build target 2 — macOS Intel / universal: one caveat

```bash
rustup target add x86_64-apple-darwin
pnpm tauri build --target x86_64-apple-darwin    # or universal-apple-darwin
```

This cross-compiles the Rust shell correctly, but `bundle-node.mjs` still embeds your **arm64** Node into the x64 bundle — the packaged app would not launch on Intel. Before shipping this target, teach `bundle-node.mjs` to download the matching official build (`node-v24.x-darwin-x64`) instead of copying `process.execPath`, and stage an x64 `node-pty` prebuild. Given Apple Silicon's install base, consider skipping this target entirely.

## Build target 3 — Windows from the M1: use CI (recommended)

Three hard facts: Tauri cannot build MSI (WiX) on macOS at all; its NSIS cross-compile route is officially experimental; and this app's engine bundling is host-platform-bound (previous section). The pragmatic answer to "build Windows from my M1" is: **your M1 triggers the build; a real Windows runner executes it.** Because `bundle-node.mjs` copies the *runner's* Node, a Windows runner automatically embeds a Windows x64 `node.exe`, and `pnpm install` there fetches Windows `node-pty` prebuilds — the same mechanism that makes local M1 builds correct makes CI builds correct per platform.

The three app changes this needed are done:

1. **Bundle target** — `tauri.conf.json` `bundle.targets` is `["app", "nsis"]` (Tauri ignores inapplicable targets per platform, so this is safe on macOS too).
2. **`bundle-node.mjs`** — writes the runtime to `node.exe` when `process.platform === "win32"` (and skips `chmod`, a no-op there); `stage:engine` also no longer shells out to unix-only `rm -rf`.
3. **Key storage** — `apps/engine/src/keychain.ts` now has a Windows path (DPAPI via PowerShell `ConvertTo/From-SecureString`, user-scoped) alongside the macOS `security` CLI path — no native addon, so it doesn't add another platform-bound prebuild like `node-pty`.

`.github/workflows/desktop-build.yml` is in the repo:

```yaml
name: Desktop build
on:
  workflow_dispatch:   # dispatch-only; release tags are vscode-v* / mcp-v*

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        platform: [macos-latest, windows-latest]   # arm64 macOS + x64 Windows
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24        # becomes the bundled engine runtime
          cache: pnpm
      - uses: dtolnay/rust-toolchain@stable
      - uses: swatinem/rust-cache@v2
        with:
          workspaces: apps/desktop/src-tauri
      - run: pnpm install --frozen-lockfile
      - uses: tauri-apps/tauri-action@v0
        with:
          projectPath: apps/desktop
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Trigger from the M1 with `gh workflow run desktop-build.yml` (the workflow is dispatch-only; no tag starts it). Artifacts: `.app`/`.dmg` from the macOS job, NSIS `.exe` installer from the Windows job. Windows code signing is deferred (users see SmartScreen warnings until then).

## Build target 3b — Windows locally on the M1 (experimental, not recommended)

For completeness — the local cross-compile route builds only the Rust shell:

```bash
brew install nsis llvm
cargo install --locked cargo-xwin
rustup target add x86_64-pc-windows-msvc
cd apps/desktop
pnpm tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
```

You would still have to hand-stage a Windows engine (download `node-v24.x-win-x64`'s `node.exe`, obtain `node-pty` Windows prebuilds), and you cannot properly test the result without a Windows machine or VM. Keep this route for debugging bundler issues; ship from CI.

## Summary

| Target | From M1 locally | Path |
|---|---|---|
| macOS arm64 (`.app`/`.dmg`) | ✅ works today | `pnpm tauri build` |
| macOS x64 / universal | ⚠️ shell only — bundled Node wrong arch | fix `bundle-node.mjs` first, or skip |
| Windows x64 (NSIS `.exe`) | ⚠️ local cross-compile experimental | GitHub Actions `windows-latest` (recommended) — engine now covered |
| Windows x64 (MSI) | ❌ impossible on macOS | GitHub Actions only |
