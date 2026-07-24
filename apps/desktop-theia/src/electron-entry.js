// Electron main-process entry (ADR 0016 M2): mints the session token, spawns
// the engine sidecar, registers the preload, and wires the promptconnext://
// deep link — all in one process, matching apps/desktop/src-tauri/src/lib.rs's
// single-binary shape (the M0 spike split this across two processes for
// spike-launcher convenience; that split is retired here).
//
// Requiring 'electron' as the first thing inside the real main-process
// entrypoint (rather than via NODE_OPTIONS --require, which loads too early
// relative to Electron's own module bootstrap) is well-formed and gives a
// working {app, session}.
const path = require('path');
const { app, session } = require('electron');
const { mintToken } = require('./token');
const { spawnEngine, killEngine } = require('./engine-lifecycle');
const { acquireSingleInstanceLock, registerDeepLink, onDeepLink } = require('./deep-link');
const { registerUpdateLifecycle } = require('./update-lifecycle');

// Must happen before any other initialization: a second launch (including
// one carrying a promptconnext:// URL on Windows/Linux) should quit
// immediately and hand off to the already-running instance rather than
// mint its own token and spawn a second engine.
const gotLock = acquireSingleInstanceLock();

if (gotLock) {
    const PORT = 47199; // dedicated dev port, avoids clashing with `pnpm engine` on 47131
    const token = mintToken();
    // Unlike lib.rs (which never logs the token, only the engine pid/dir), this
    // prints the full value for dev convenience — gated to unpackaged runs so a
    // packaged build's stdout (Console.app, a CI log) never captures the
    // credential that gates the terminal-WS-to-shell path.
    console.log(
        '[promptconnext-desktop-theia] minted token',
        app.isPackaged ? `(${token.length} chars)` : token,
    );

    // Same-process: preload.js reads process.env.PROMPTCONNEXT_TOKEN directly,
    // no subprocess env-passing needed (unlike the retired start-spike.js).
    process.env.PROMPTCONNEXT_TOKEN = token;

    registerDeepLink();

    let engineChild = null;
    let mainWindow = null;

    app.once('ready', () => {
        engineChild = spawnEngine(token, PORT);

        session.defaultSession.registerPreloadScript({
            type: 'frame',
            filePath: path.join(__dirname, 'preload.js'),
        });
        console.log('[promptconnext-desktop-theia] preload injected:', path.join(__dirname, 'preload.js'));

        registerUpdateLifecycle(() => mainWindow);
    });

    // Deep-link URLs (initial 'open-url' on macOS, or one relayed from a
    // second-instance launch) reach the renderer over IPC once a window has
    // actually loaded the preload's listener — see preload.js's
    // __PROMPTCONNEXT_ON_AUTH_CALLBACK__. No consumer subscribes yet (the
    // Planner extension that redeems the code lands in M3); this only
    // proves the relay is live end to end.
    app.on('browser-window-created', (_event, win) => {
        mainWindow = win;
        win.webContents.once('did-finish-load', () => {
            onDeepLink((url) => win.webContents.send('promptconnext-auth-callback', url));
        });
    });

    // will-quit, not before-quit: Theia's own window-close handler negotiates
    // unsaved-editor confirmation and can abort the quit after before-quit has
    // already fired, which would kill the engine with no path to restart it.
    // will-quit only fires once the quit is actually going through — the closest
    // analogue to lib.rs's RunEvent::Exit.
    app.on('will-quit', () => {
        killEngine(engineChild);
    });

    require('../lib/backend/electron-main.js');
}
