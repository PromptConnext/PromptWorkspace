# Building & Distributing PromptConnext

How to run PromptConnext in development and produce a distributable macOS app. Reflects the state as of the packaging pass (ADR 0001 / 0008).

**Current support:** macOS on Apple Silicon (arm64), self-contained (no repo, no system Node needed to *run* the built app). Windows/Linux and code-signed distribution are not done yet — see [Limitations](#limitations).

---

## 1. Prerequisites (to build)

You need these on the **build** machine (end users of the built `.app` need none of them):

- **Node ≥ 24** — the engine uses `node:sqlite` and runs TypeScript natively, both of which require 24+. The build copies *this* Node into the app, so its version and arch become the app's runtime.
- **pnpm** — `npm i -g pnpm`
- **Rust** — install via [rustup](https://rustup.rs); the Tauri shell is Rust.
- **Xcode Command Line Tools** — `xcode-select --install`

Verify: `node -v` (≥ v24), `pnpm -v`, `cargo -v`.

---

## 2. First-time setup

```sh
git clone <repo> && cd PromptConnext
pnpm install
```

---

## 3. Run in development

Two ways:

**Full desktop app (Tauri window + engine + hot-reload UI):**
```sh
pnpm desktop        # = pnpm --dir apps/desktop tauri dev
```
The Rust shell spawns the engine from the repo (`apps/engine`) using your system Node, mints a per-session auth token, and injects it into the webview. First run compiles Rust (a few minutes); later runs are fast.

**Browser-only (fastest UI iteration, no Rust):**
```sh
pnpm engine         # terminal 1 — starts the engine on 127.0.0.1:47131 (no token in this mode)
pnpm --dir apps/desktop dev   # terminal 2 — Vite on http://localhost:1420
```
Open http://localhost:1420. In this mode the engine runs without an auth token so a plain browser can talk to it. (In the packaged app and `pnpm desktop`, the token is required.)

A zero-cost first model for testing: install [Ollama](https://ollama.com), `ollama pull qwen3:8b`, and pick **Local Ollama** in onboarding.

---

## 4. Build a distributable app

```sh
cd apps/desktop
pnpm tauri build
```

This runs, in order (`beforeBuildCommand` + Tauri bundling):
1. `pnpm build` — typecheck + Vite production build of the UI.
2. `pnpm stage:engine` — produces a **self-contained engine** at `src-tauri/.engine-pkg`:
   - a **hoisted `pnpm deploy`** (`--config.node-linker=hoisted`) — a symlink-free copy of the engine + its `node_modules` (raw pnpm `node_modules` is a symlink forest and can't be bundled).
   - `scripts/bundle-node.mjs` copies the build's own Node binary into `.engine-pkg/node` (ABI-matched to the bundled `node-pty`).
3. Rust release compile + bundle into `PromptConnext.app`, copying `.engine-pkg` to `Contents/Resources/engine`.

**Output:** `apps/desktop/src-tauri/target/release/bundle/macos/PromptConnext.app` (~192 MB).

At runtime the Rust shell resolves the engine from `Contents/Resources/engine` and runs it with the **bundled** `Contents/Resources/engine/node` — so the app needs neither the repo nor a system Node. Verified by launching a copy outside the repo with `node` stripped from `PATH`.

---

## 5. What's inside the bundle

```
PromptConnext.app/Contents/
├── MacOS/promptconnext-desktop         # Rust shell (spawns engine, injects auth token)
└── Resources/engine/
    ├── node                         # bundled Node 24 runtime (~120 MB)
    ├── src/index.ts                 # engine entry (run with the bundled node)
    ├── node_modules/                # symlink-free deps incl. node-pty prebuild
    └── package.json
```

Security posture (already in place): the engine binds `127.0.0.1` only; every request needs the per-session token the shell mints at launch (except the health probe); the terminal WebSocket enforces an origin allowlist; the file API is jailed inside the project directory (symlink-safe); model credentials live in the macOS keychain, never on disk.

---

## 6. Distributing to other people

**The reality today: the app is *not* code-signed or notarized.** It runs fine for you, but macOS **Gatekeeper** will block it for anyone who downloads it.

**Quick workaround (for a trusted tester, not real distribution):**
```sh
xattr -dr com.apple.quarantine /path/to/PromptConnext.app   # strip the download quarantine
```
or right-click the app → **Open** → **Open** on the warning dialog.

**Proper distribution (requires an Apple Developer account — not yet configured):**
1. Get a **Developer ID Application** certificate from your Apple Developer account.
2. Configure Tauri signing in `apps/desktop/src-tauri/tauri.conf.json` under `bundle.macOS` (`signingIdentity`) and set up **notarization** env (`APPLE_ID`, `APPLE_PASSWORD`/`APPLE_API_KEY`, `APPLE_TEAM_ID`) — see Tauri's macOS code-signing docs.
3. `pnpm tauri build` then `xcrun notarytool submit … --wait` and `xcrun stapler staple` the `.app`.
4. Distribute the notarized `.app` (zip it) or wrap it in a `.dmg` (add `"dmg"` to `bundle.targets`).

Until step 1–3 are done, treat the build as **internal / testers only**.

---

## 7. Limitations

- **macOS Apple-silicon only.** The bundled Node and `node-pty` prebuild are per-platform; the build targets whatever the build machine is (Apple silicon here). Windows/Linux need their own bundle-node + prebuild handling.
- **Unsigned** — see §6.
- **Bundle size ~192 MB.** ~62 MB is `node-pty`'s prebuilds for *all* platforms; pruning to the target platform is a pending cleanup.
- **No auto-update.** No updater configured.
- **Keychain is macOS-only** (`security` CLI); a cross-platform keyring is needed for Windows/Linux.
