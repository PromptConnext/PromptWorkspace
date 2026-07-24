// Electron main-process entry (ADR 0016 M2): mints the session token, spawns
// the engine sidecar, and registers the preload — all in one process,
// matching apps/desktop/src-tauri/src/lib.rs's single-binary shape (the M0
// spike split this across two processes for spike-launcher convenience;
// that split is retired here).
//
// Requiring 'electron' as the first thing inside the real main-process
// entrypoint (rather than via NODE_OPTIONS --require, which loads too early
// relative to Electron's own module bootstrap) is well-formed and gives a
// working {app, session}.
const path = require('path');
const { app, session } = require('electron');
const { mintToken } = require('./token');
const { spawnEngine, killEngine } = require('./engine-lifecycle');

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

let engineChild = null;

app.once('ready', () => {
    engineChild = spawnEngine(token, PORT);

    session.defaultSession.registerPreloadScript({
        type: 'frame',
        filePath: path.join(__dirname, 'preload.js'),
    });
    console.log('[promptconnext-desktop-theia] preload injected:', path.join(__dirname, 'preload.js'));
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
