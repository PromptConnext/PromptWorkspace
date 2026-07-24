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
console.log('[promptconnext-desktop-theia] minted token', token);

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

app.on('before-quit', () => {
    killEngine(engineChild);
});

require('../lib/backend/electron-main.js');
