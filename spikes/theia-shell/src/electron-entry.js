// Entry point launched directly by Electron (replaces NODE_OPTIONS --require,
// which loads too early relative to Electron's own module bootstrap and left
// `electron` exporting only the path-string fallback). Requiring 'electron'
// as the first thing inside the real main-process entrypoint is well-formed
// and gives a working {app, session}.
const path = require('path');
const { app, session } = require('electron');

app.once('ready', () => {
    const existing = session.defaultSession.getPreloads();
    session.defaultSession.setPreloads([...existing, path.join(__dirname, 'preload.js')]);
    console.log('[promptconnext-spike] preload injected:', path.join(__dirname, 'preload.js'));
});

require('../lib/backend/electron-main.js');
