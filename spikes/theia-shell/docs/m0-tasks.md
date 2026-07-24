# ADR 0016 M0 task list

- [x] Scratch branch `spike/0016-theia-m0`, spike isolated under `spikes/theia-shell/` (own package.json/lockfile, not in pnpm workspace, apps/desktop untouched)
- [x] Bare Theia Electron package.json (theia 1.66.0, electron 38.4.0 pinned to Theia's peer requirement)
- [x] `npm install` completes cleanly (needed `terser-webpack-plugin` added explicitly + `@vscode/ripgrep` pinned to 1.15.9 to dodge a Node ESM-exports resolution bug in 1.18.0)
- [x] `theia build` succeeds
- [x] Electron main spawns the existing engine (`apps/engine`, unmodified) as a sidecar, passing `PROMPTCONNEXT_PARENT_PID` / `PROMPTCONNEXT_AUTH_TOKEN` same as `lib.rs`
- [x] Preload injects `window.__PROMPTCONNEXT_TOKEN__` before app scripts, via `session.defaultSession.setPreloads()` layered over Theia's own preload
- [x] Engine allowlist extended via `PROMPTCONNEXT_ALLOWED_ORIGINS` env (no engine code change)
- [x] Open a project folder; confirm file routes (`/files`, `/file`, `/status`) work against the spawned engine — verified with a real project row + bearer token
- [x] Confirm terminal WS (`/engine/projects/:id/terminal`) works end-to-end, including the ADR 0008 origin-allowlist test (allowed / evil / missing origin)
- [x] Repeat the above on Windows x64 — verified via GitHub Actions CI (`windows-2022`), all checks pass (see `docs/m0-report.md`).
- [x] Open VSX extension audit (`docs/open-vsx-audit.md`)
- [x] Deep-link + keychain re-home prototype writeup (`src/deep-link-keychain-prototype.md`)
- [x] Test: non-allowlisted origin rejected (WS closes 1008) — reproduced ADR 0008's test on the new shell
- [x] M0 report: PASS/FAIL per exit criterion + recommendation (`docs/m0-report.md`)
