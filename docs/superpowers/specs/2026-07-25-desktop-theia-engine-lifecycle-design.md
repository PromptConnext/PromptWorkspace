# ADR 0016 M2, sub-project 1 — Engine lifecycle + token injection

**Date:** 2026-07-25 · **Scope:** new `apps/desktop-theia` app · **First of five M2 sub-projects** (engine lifecycle + token injection → keychain + deep-link → auto-updater → CI matrix + signing/notarization → Open VSX registry), each with its own spec/plan/implementation cycle. This one is the foundation the other four build on.

## Context

ADR 0016's M2 milestone ("Theia app skeleton at plumbing parity with Tauri") is too broad for a single spec — it spans several independently-shippable subsystems. This spec covers only the first: turning the M0 spike's engine-spawn and token-injection prototypes into real code, in a real app.

M0 (`spikes/theia-shell/`, merged to `main`) already proved this works end to end: engine health, auth, file routes, status routes, and the terminal WS origin allowlist all passed on macOS arm64 and Windows x64 CI. The spike's `src/engine-lifecycle.js`, `src/token.js`, and `src/preload.js` are the starting point here — this sub-project promotes them, not rewrites them, fixing two things the spike deliberately left as known gaps and one deprecation Electron itself flagged in CI:

1. **Engine directory resolution.** The spike hardcodes `path.resolve(__dirname, '../../../apps/engine')` — works only because the spike sits at a fixed depth relative to the real engine in the monorepo. The Tauri shell's `lib.rs::engine_dir()` has a real fallback chain: an explicit `PROMPTCONNEXT_ENGINE_DIR` env override, else the packaged app's bundled resource directory, else the dev-checkout path. This sub-project ports that same fallback chain (packaged-resource-dir branch included for correctness, even though nothing bundles into it yet — that's sub-project 4's job).
2. **Kill-on-exit.** The spike exports `killEngine()` but nothing ever calls it — the spike script's own process management (`start-spike.js`) handles cleanup ad hoc for CI purposes, not via Electron's real app-lifecycle hooks. `lib.rs::run()` kills and waits on the child in its `RunEvent::Exit` handler. This sub-project wires the equivalent Electron hook (`app.on('before-quit', ...)` or `will-quit`) so a real quit never orphans the engine process.
3. **Deprecated preload API.** M0's Windows CI log flagged `session.defaultSession.setPreloads()`/`getPreloads()` as deprecated (`session.getPreloadScripts`/`registerPreloadScript` is the replacement). Fix it while this code is being touched anyway, rather than carrying a known deprecation into new production code.

## Non-goals

- No self-contained packaging (bundling the build's own Node binary, hoisted `pnpm deploy` of `apps/engine`). That's sub-project 4 (CI matrix + code-signing), where packaged builds are actually produced and tested. This sub-project targets `pnpm --dir apps/desktop-theia dev` only — spawning the engine via system Node, exactly as `apps/desktop`'s own `beforeDevCommand` doesn't stage either.
- No keychain, deep-link, or auto-updater work (sub-projects 2 and 3).
- No CI workflow, no code-signing, no notarization (sub-project 4).
- No Open VSX extension registry wiring (sub-project 5).
- No changes to `apps/engine`, `apps/cloud`, or `apps/desktop` (the Tauri app keeps shipping unmodified until M4 cutover — this is strictly additive, a new app living alongside it).
- No Planner UI, no business/developer split — M2's whole point per the ADR is plumbing parity, not the Planner surface (that's M3).

## Design

### 1. New app: `apps/desktop-theia`

Promote `spikes/theia-shell/` into `apps/desktop-theia/`, added to `pnpm-workspace.yaml` as a real workspace member (currently the spike's `package.json` deliberately excludes it — "not part of the pnpm workspace" was an M0 isolation choice, no longer appropriate once this is real product work). Rename the package from `promptconnext-theia-spike` to a real name (`@promptconnext/desktop-theia`, matching the `@promptconnext/engine` naming convention already used by `apps/engine`).

Directory carries over largely as-is: `theia` config block in `package.json`, `webpack.config.js`, the `@theia/*` dependency set. Files specific to spike CI/orchestration (`ci-verify.js`, `start-spike.js`, `docs/m0-report.md`, `docs/m0-tasks.md`, `docs/open-vsx-audit.md`, the native-module stubs under `stubs/`) do not carry over — those were CI-scaffolding for the go/no-go gate, not app code. (The stubs may need to return in sub-project 4 if the same Windows CI toolchain bug resurfaces — noted there, not solved here.) `src/inject-preload.js` also does not carry over — it's the superseded `NODE_OPTIONS=--require` preload-injection mechanism the spike itself replaced with `electron-entry.js` (see M0 session history); `electron-entry.js`'s approach is what this sub-project builds on.

### 2. `src/engine-lifecycle.js` — real directory resolution

Replace the spike's hardcoded path with the Tauri fallback chain:

```js
const path = require('path');
const { app } = require('electron');

function engineDir() {
  if (process.env.PROMPTCONNEXT_ENGINE_DIR) {
    return process.env.PROMPTCONNEXT_ENGINE_DIR;
  }
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'engine');
  }
  return path.resolve(__dirname, '../../../apps/engine');
}
```

The packaged branch has no bundled `engine/` directory yet in this sub-project — it exists for correctness and so sub-project 4 doesn't need to touch this function again, not because it's exercised by anything today. `app.isPackaged` is `false` under `pnpm dev`, so the existing dev path is what actually runs.

`spawnEngine`/`killEngine` keep their existing signatures and behavior (env vars: `PROMPTCONNEXT_PARENT_PID`, `PROMPTCONNEXT_AUTH_TOKEN`, `PROMPTCONNEXT_ENGINE_PORT`, `PROMPTCONNEXT_ALLOWED_ORIGINS` extension) — those already mirror `lib.rs` correctly and aren't part of this sub-project's known gaps.

### 3. Kill-on-exit wiring

**Architectural correction from the M0 spike:** the spike is actually *two* processes — an outer Node launcher (`start-spike.js`) that mints the token, spawns the engine itself, waits for health, and only then spawns Electron as a *child process* with the token passed via env (`PROMPTCONNEXT_TOKEN`). `electron-entry.js` itself never spawns the engine — it only wires the preload and requires Theia's own `electron-main.js`. The spike's own comment says as much: "mirrors what `lib.rs` does in one process instead of two languages... that's M2." `start-spike.js` does not carry over (it's CI/spike launcher scaffolding); this sub-project collapses the two processes into one, matching `lib.rs`'s single-binary shape.

In the app's Electron main entry point (renamed/adapted from `electron-entry.js`), the main process itself now mints the token, spawns the engine, and — since the preload runs in the *same* process space (not a spawned subprocess) — can just set `process.env.PROMPTCONNEXT_TOKEN` directly before the preload loads, no subprocess env-passing needed:

```js
const { app } = require('electron');
const { mintToken } = require('./token');
const { spawnEngine, killEngine } = require('./engine-lifecycle');

const token = mintToken();
process.env.PROMPTCONNEXT_TOKEN = token; // same-process: preload.js reads this directly
let engineChild = null;

app.whenReady().then(() => {
  engineChild = spawnEngine(token, port);
  // ... existing Theia backend startup
});

app.on('before-quit', () => {
  killEngine(engineChild);
});
```

`preload.js`'s existing `process.env.PROMPTCONNEXT_TOKEN` read stays unchanged — it already expects exactly this. Matches `lib.rs`'s `RunEvent::Exit` handler: no engine process survives a real app quit.

### 4. Preload API fix

Replace:

```js
const existing = session.defaultSession.getPreloads();
session.defaultSession.setPreloads([...existing, path.join(__dirname, 'preload.js')]);
```

with:

```js
session.defaultSession.registerPreloadScript({
  type: 'frame',
  filePath: path.join(__dirname, 'preload.js'),
});
```

`token.js` and `preload.js` themselves carry over unchanged — they already correctly mint the 32-hex CSPRNG token and inject `window.__PROMPTCONNEXT_TOKEN__` before app scripts run (ADR 0008), matching `lib.rs::mint_token()`'s shape exactly.

## Testing

- Manual: `pnpm --dir apps/desktop-theia dev` (or equivalent workspace script — exact command name is an implementation-plan detail), confirm the Electron+Theia window launches, the engine process is spawned as a child, `window.__PROMPTCONNEXT_TOKEN__` is set before any Theia frontend script runs, and `/engine/health` responds.
- Manual: verify `PROMPTCONNEXT_ENGINE_DIR` override still works (unchanged behavior, but now sitting inside a branch instead of being the only path).
- Manual: quit the app, confirm via `ps`/Activity Monitor/Task Manager that no orphaned `node` engine process remains — the concrete regression test for the kill-on-exit gap this sub-project closes.
- No automated test suite exists for this app (consistent with `apps/desktop`'s own testing posture) — `tsc --noEmit` (if the app's `package.json` gains a typecheck script) or equivalent build-succeeds check is the available automated gate.
