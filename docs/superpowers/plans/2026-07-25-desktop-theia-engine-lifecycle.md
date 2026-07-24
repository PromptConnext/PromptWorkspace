# ADR 0016 M2 sub-project 1 — Engine Lifecycle + Token Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the ADR 0016 M0 spike (`spikes/theia-shell/`) into a real workspace app (`apps/desktop-theia`) with correct engine directory resolution, single-process engine spawn + kill-on-exit, and a non-deprecated preload API — dev-mode only, no packaging.

**Architecture:** One new Electron main-process entry point collapses what the M0 spike split across two processes (`start-spike.js` outer launcher + `electron-entry.js` Electron child) into one, matching `apps/desktop/src-tauri/src/lib.rs`'s single-binary shape: mint token → set `process.env.PROMPTCONNEXT_TOKEN` (same-process, so `preload.js`'s existing env read keeps working) → spawn engine (with a real packaged/dev directory-resolution fallback chain) → register the preload via the modern non-deprecated API → let Theia's own `electron-main.js` boot the window → kill the engine child on `before-quit`.

**Tech Stack:** Eclipse Theia 1.66.0 (Electron 38.4.0), Node ≥24, plain JS (the spike's source files are `.js`, not TypeScript — this plan keeps that). pnpm workspace (`apps/*` glob already covers the new app — no `pnpm-workspace.yaml` edit needed).

## Global Constraints

- No changes to `apps/engine`, `apps/cloud`, `apps/desktop`, or `spikes/theia-shell/` — this plan only adds `apps/desktop-theia/`.
- No packaging, no self-contained Node/engine bundling, no CI workflow, no code-signing — dev-mode (`pnpm --dir apps/desktop-theia start`) only. That's sub-project 4.
- No keychain, deep-link, or auto-updater work — that's sub-projects 2 and 3.
- No Planner UI or business/developer tab split — that's M3.
- Package name: `@promptconnext/desktop-theia` (matches `@promptconnext/engine`'s scoping convention).
- `spikes/theia-shell/src/inject-preload.js` and `start-spike.js` do not carry over (superseded / CI-only scaffolding, per spec).
- `spikes/theia-shell/ci-verify.js`, `docs/m0-report.md`, `docs/m0-tasks.md`, `docs/open-vsx-audit.md`, `stubs/` do not carry over (M0-CI-specific, not app code).
- No test runner will exist for this app (consistent with `apps/desktop`'s own posture) — verification is a successful `theia build` plus manual dev-mode launch and process-cleanup checks.

---

### Task 1: Scaffold `apps/desktop-theia` from the M0 spike

**Files:**
- Create: `apps/desktop-theia/package.json` (adapted from `spikes/theia-shell/package.json`)
- Create: `apps/desktop-theia/webpack.config.js` (copied from `spikes/theia-shell/webpack.config.js`, unchanged)
- Create: `apps/desktop-theia/.gitignore` (copied from `spikes/theia-shell/.gitignore`, unchanged)
- Create: `apps/desktop-theia/src/token.js` (copied from `spikes/theia-shell/src/token.js`, unchanged)
- Create: `apps/desktop-theia/src/preload.js` (copied from `spikes/theia-shell/src/preload.js`, unchanged)
- Create: `apps/desktop-theia/src/engine-lifecycle.js` (adapted in Task 2, plain copy for this task)
- Create: `apps/desktop-theia/src/electron-entry.js` (adapted in Task 3, plain copy for this task)

**Interfaces:**
- Consumes: nothing from other tasks (this is the first task).
- Produces: a working `apps/desktop-theia` directory that installs and builds via Theia's own CLI, with `token.js` exporting `mintToken(): string` and `engine-lifecycle.js` exporting `spawnEngine(token: string, port: number): ChildProcess` and `killEngine(child: ChildProcess | null): void` — the exact shapes Tasks 2 and 3 will modify in place.

- [ ] **Step 1: Create the directory and copy over the files that need no changes**

  ```bash
  mkdir -p apps/desktop-theia/src
  cp spikes/theia-shell/webpack.config.js apps/desktop-theia/webpack.config.js
  cp spikes/theia-shell/.gitignore apps/desktop-theia/.gitignore
  cp spikes/theia-shell/src/token.js apps/desktop-theia/src/token.js
  cp spikes/theia-shell/src/preload.js apps/desktop-theia/src/preload.js
  cp spikes/theia-shell/src/engine-lifecycle.js apps/desktop-theia/src/engine-lifecycle.js
  cp spikes/theia-shell/src/electron-entry.js apps/desktop-theia/src/electron-entry.js
  ```

- [ ] **Step 2: Write `apps/desktop-theia/package.json`**

  Same shape as `spikes/theia-shell/package.json`, with the name changed and the spike's `postinstall`/`prepare` scripts kept (they already run `theia check:theia-version` / `theia build --mode development`, which is exactly what this app needs too):

  ```json
  {
    "name": "@promptconnext/desktop-theia",
    "version": "0.0.0",
    "private": true,
    "description": "ADR 0016 M2: Eclipse Theia Electron desktop shell + PromptConnext engine sidecar, at plumbing parity with apps/desktop (Tauri). Ships alongside apps/desktop until the ADR 0016 M4 cutover; apps/desktop is untouched.",
    "main": "src/electron-entry.js",
    "theia": {
      "target": "electron",
      "frontend": {
        "config": {
          "applicationName": "PromptConnext (Theia)",
          "preferences": {
            "security.workspace.trust.enabled": false
          }
        }
      },
      "backend": {
        "config": {
          "startupTimeout": -1
        }
      },
      "electron": {
        "splashScreenOptions": {
          "width": 300,
          "height": 300
        }
      }
    },
    "dependencies": {
      "@theia/core": "1.66.0",
      "@theia/editor": "1.66.0",
      "@theia/filesystem": "1.66.0",
      "@theia/navigator": "1.66.0",
      "@theia/process": "1.66.0",
      "@theia/terminal": "1.66.0",
      "@theia/preferences": "1.66.0",
      "@theia/workspace": "1.66.0",
      "@theia/monaco": "1.66.0",
      "@theia/electron": "1.66.0",
      "@vscode/ripgrep": "1.15.9"
    },
    "devDependencies": {
      "@theia/cli": "1.66.0",
      "electron": "38.4.0",
      "terser-webpack-plugin": "^5.3.0"
    },
    "overrides": {
      "@vscode/ripgrep": "1.15.9"
    },
    "scripts": {
      "prepare": "theia build --mode development",
      "start": "electron .",
      "postinstall": "theia check:theia-version"
    }
  }
  ```

  Three deliberate differences from the spike's `package.json`:
  - `applicationName` is `"PromptConnext (Theia)"` instead of `"PromptConnext (Theia spike)"` — this is now a real app, not a spike, but it still needs to read differently from `apps/desktop`'s plain `"PromptConnext"` window title while both coexist during M2/M3.
  - A top-level `"main": "src/electron-entry.js"` field is added. The spike never had one — `start-spike.js` (retired, does not carry over) launched Electron by passing `src/electron-entry.js` directly as the electron binary's CLI argument, which bypasses `package.json`'s `main` field entirely. This app instead uses the standard Electron convention (`electron .` reads `main` from `package.json`), so `main` must point at **our** `src/electron-entry.js` — not at Theia's generated `lib/backend/electron-main.js` — because `electron-entry.js` is what mints the token, spawns the engine, and registers the preload before it `require()`s Theia's own generated entry point (see Task 3). Pointing `main` at Theia's generated file directly would skip all of that.
  - The `"start"` script is `"electron ."`, the standard convention this `main` field setup enables.

- [ ] **Step 3: Add `pnpm-lock.yaml` entry via install**

  ```bash
  pnpm install --filter @promptconnext/desktop-theia
  ```

  Expected: installs cleanly (this repo is on macOS arm64 for local dev — the M0 CI native-module Windows toolchain issues do not apply here). If `drivelist`/`keytar`/`native-keymap` fail to install on this machine specifically, stop and report — that would mean the stub-package workaround needs to return here too, which is out of this plan's scope to decide alone.

- [ ] **Step 4: Build and verify**

  ```bash
  cd apps/desktop-theia && npx theia build --mode development && cd ../..
  ```

  Expected: build succeeds, produces `apps/desktop-theia/lib/backend/electron-main.js` — this is the file `src/electron-entry.js` (Task 3) `require()`s at the end, not the `package.json` `"main"` entry itself (that stays `src/electron-entry.js`, unaffected by this build).

  Verify the path Task 3's `electron-entry.js` expects actually exists:

  ```bash
  ls apps/desktop-theia/lib/backend/electron-main.js
  ```

  If it doesn't exist at that path, find the actual build output path and use that in Task 3 Step 1's `require(...)` call instead of guessing.

- [ ] **Step 5: Commit**

  ```bash
  git add apps/desktop-theia
  git commit -m "feat(desktop-theia): scaffold apps/desktop-theia from the M0 spike (ADR 0016 M2)"
  ```

---

### Task 2: Real engine directory resolution

**Files:**
- Modify: `apps/desktop-theia/src/engine-lifecycle.js`

**Interfaces:**
- Consumes: Electron's `app.isPackaged: boolean` and `process.resourcesPath: string` (both standard Electron main-process globals, available via `require('electron').app`).
- Produces: `engineDir(): string` — a new exported function Task 3's `electron-entry.js` does not need to call directly (kept internal to `engine-lifecycle.js`, used by `spawnEngine`), but is exported anyway for the manual verification step in Task 4 to exercise the `PROMPTCONNEXT_ENGINE_DIR` override path directly if needed.

- [ ] **Step 1: Replace the hardcoded `ENGINE_DIR` constant with a real resolution function**

  In `apps/desktop-theia/src/engine-lifecycle.js`, replace:

  ```js
  const path = require('path');
  const { spawn } = require('child_process');

  const ENGINE_DIR =
      process.env.PROMPTCONNEXT_ENGINE_DIR ||
      path.resolve(__dirname, '../../../apps/engine');
  ```

  with:

  ```js
  const path = require('path');
  const { spawn } = require('child_process');
  const { app } = require('electron');

  // Engine resolution (ADR 0001, mirrors apps/desktop/src-tauri/src/lib.rs::engine_dir):
  // explicit override, else the packaged app's bundled resource dir, else the
  // repo checkout this file is running from (dev). The packaged branch has no
  // bundled engine/ yet — that's ADR 0016 M2 sub-project 4 (CI + packaging) —
  // but the resolution logic is correct now so that sub-project doesn't need
  // to touch this function again.
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

- [ ] **Step 2: Update `spawnEngine` to call `engineDir()` instead of the removed constant**

  Find the `spawnEngine` function's `cwd: ENGINE_DIR` line and change it to `cwd: engineDir()`.

- [ ] **Step 3: Update the module export**

  Find the existing `module.exports = { spawnEngine, killEngine, ENGINE_DIR };` line and change it to:

  ```js
  module.exports = { spawnEngine, killEngine, engineDir };
  ```

- [ ] **Step 4: Verify the file has no remaining references to the old `ENGINE_DIR` constant**

  ```bash
  grep -n "ENGINE_DIR" apps/desktop-theia/src/engine-lifecycle.js
  ```

  Expected: no output (all uses converted to `engineDir()` calls or the export name).

- [ ] **Step 5: Sanity-check the file loads without syntax errors**

  ```bash
  node -e "require('./apps/desktop-theia/src/engine-lifecycle.js')" 2>&1 | head -5
  ```

  Expected: this will actually throw, because `require('electron')` outside an Electron process returns a path string, not `{app}` — `app.isPackaged` will throw `Cannot read properties of undefined`. That's expected and fine; it confirms the module *parses* (a real syntax error would throw a `SyntaxError` at a different point, during parse, before reaching that line). If you see a `SyntaxError`, fix it. If you see the `Cannot read properties of undefined (reading 'isPackaged')` (or similar) error, that confirms the file is syntactically valid and the real verification happens in Task 4 inside an actual Electron process.

- [ ] **Step 6: Commit**

  ```bash
  git add apps/desktop-theia/src/engine-lifecycle.js
  git commit -m "feat(desktop-theia): real engine directory resolution (ADR 0016 M2)"
  ```

---

### Task 3: Collapse to single process — spawn engine + kill-on-exit + preload fix

**Files:**
- Modify: `apps/desktop-theia/src/electron-entry.js`

**Interfaces:**
- Consumes: `mintToken(): string` from `./token.js` (Task 1, unchanged), `spawnEngine(token: string, port: number): ChildProcess` and `killEngine(child: ChildProcess | null): void` from `./engine-lifecycle.js` (Task 2's shape).
- Produces: nothing further downstream — this is the last code task before manual verification.

- [ ] **Step 1: Replace `electron-entry.js`'s contents**

  The current file only wires the preload and requires Theia's backend:

  ```js
  const path = require('path');
  const { app, session } = require('electron');

  app.once('ready', () => {
      const existing = session.defaultSession.getPreloads();
      session.defaultSession.setPreloads([...existing, path.join(__dirname, 'preload.js')]);
      console.log('[promptconnext-spike] preload injected:', path.join(__dirname, 'preload.js'));
  });

  require('../lib/backend/electron-main.js');
  ```

  Replace it with:

  ```js
  // Electron main-process entry (ADR 0016 M2): mints the session token, spawns
  // the engine sidecar, and registers the preload — all in one process,
  // matching apps/desktop/src-tauri/src/lib.rs's single-binary shape (the M0
  // spike split this across two processes for spike-launcher convenience;
  // that split is retired here).
  const path = require('path');
  const { app, session } = require('electron');
  const { mintToken } = require('./token');
  const { spawnEngine, killEngine } = require('./engine-lifecycle');

  const PORT = 47199; // dedicated dev port, avoids clashing with `pnpm engine` on 47131
  const token = mintToken();
  console.log('[promptconnext-desktop-theia] minted token', token);

  // Same-process: preload.js reads process.env.PROMPTCONNEXT_TOKEN directly,
  // no subprocess env-passing needed (unlike the retired start-spike.js).
  process.env.PROMPTCONNEXT_TOKEN = token;

  let engineChild = null;

  app.once('ready', () => {
      engineChild = spawnEngine(token, PORT);

      const existing = session.defaultSession.getPreloads();
      session.defaultSession.setPreloads([...existing, path.join(__dirname, 'preload.js')]);
      console.log('[promptconnext-desktop-theia] preload injected:', path.join(__dirname, 'preload.js'));
  });

  app.on('before-quit', () => {
      killEngine(engineChild);
  });

  require('../lib/backend/electron-main.js');
  ```

  (This step deliberately keeps the deprecated `getPreloads`/`setPreloads` calls — Step 2 replaces them. Keeping the engine-spawn change and the preload-API change as separate steps within this task makes it easy to isolate which change caused a problem if `theia build`/launch fails partway through.)

- [ ] **Step 2: Replace the deprecated preload API**

  In the same file, replace:

  ```js
      const existing = session.defaultSession.getPreloads();
      session.defaultSession.setPreloads([...existing, path.join(__dirname, 'preload.js')]);
      console.log('[promptconnext-desktop-theia] preload injected:', path.join(__dirname, 'preload.js'));
  ```

  with:

  ```js
      session.defaultSession.registerPreloadScript({
          type: 'frame',
          filePath: path.join(__dirname, 'preload.js'),
      });
      console.log('[promptconnext-desktop-theia] preload injected:', path.join(__dirname, 'preload.js'));
  ```

- [ ] **Step 3: Verify the file has no remaining deprecated-API calls**

  ```bash
  grep -n "getPreloads\|setPreloads" apps/desktop-theia/src/electron-entry.js
  ```

  Expected: no output.

- [ ] **Step 4: Rebuild**

  ```bash
  cd apps/desktop-theia && npx theia build --mode development && cd ../..
  ```

  Expected: build succeeds (this file isn't part of the webpack-bundled frontend/backend — it's the Electron main-process entry loaded directly by `electron .` — so `theia build` succeeding here just confirms nothing else broke; the real test of this file is Task 4's manual launch).

- [ ] **Step 5: Commit**

  ```bash
  git add apps/desktop-theia/src/electron-entry.js
  git commit -m "feat(desktop-theia): collapse engine spawn to single process, kill-on-exit, fix deprecated preload API (ADR 0016 M2)"
  ```

---

### Task 4: End-to-end manual verification

No file changes expected — this task confirms the three prior tasks work together as a real, launchable dev app. If verification surfaces a real gap, fix it in the relevant file from Tasks 1–3 and commit that fix with a message describing exactly what gap was closed; otherwise this task ends without a commit.

**Files:** none expected.

**Interfaces:** none — exercises the app built by Tasks 1–3.

- [ ] **Step 1: Launch the app**

  ```bash
  pnpm --dir apps/desktop-theia start
  ```

  (Runs Task 1's `"start": "electron ."` script, which reads `"main": "src/electron-entry.js"`.)

  Confirm:
  - Console prints `[promptconnext-desktop-theia] minted token <32 hex chars>` and `[promptconnext-desktop-theia] preload injected: .../preload.js`.
  - The Theia Electron window opens and reaches its ready state (same "Frontend application start" log line pattern the M0 spike's CI verified).
  - `curl http://127.0.0.1:47199/engine/health` returns 200 while the app is running.

- [ ] **Step 2: Verify the token reached the renderer**

  In the Theia app's own DevTools console (or via a quick temporary `console.log(window.__PROMPTCONNEXT_TOKEN__)` if DevTools access is awkward in this build), confirm `window.__PROMPTCONNEXT_TOKEN__` matches the token printed in Step 1's console output.

- [ ] **Step 3: Verify the `PROMPTCONNEXT_ENGINE_DIR` override**

  ```bash
  PROMPTCONNEXT_ENGINE_DIR="$(pwd)/apps/engine" pnpm --dir apps/desktop-theia start
  ```

  (Run from the repo root, so `$(pwd)/apps/engine` resolves correctly.)

  Confirm the engine still starts successfully (this exercises the override branch of `engineDir()` from Task 2 — the value here happens to resolve to the same real directory as the default branch, but proves the env var is actually read and takes precedence).

- [ ] **Step 4: Verify kill-on-exit**

  With the app running (Step 1), note the engine's PID from `ps aux | grep 'src/index.ts'` (or equivalent — the engine process command line includes `apps/engine/src/index.ts`). Quit the Electron app normally (Cmd+Q / window close). Re-run the `ps` check.

  Confirm: the engine process is gone — no orphaned `node .../apps/engine/src/index.ts` process survives the quit. This is the concrete regression test for the kill-on-exit gap this sub-project closes (the M0 spike never wired this to real app-quit).

- [ ] **Step 5: If everything passes, no commit needed for this task.** If any gap was found and fixed, commit that fix with a message describing the specific gap closed.
