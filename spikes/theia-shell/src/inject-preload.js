// Loaded via NODE_OPTIONS=--require before Theia's own electron-main.js runs.
// Registers our preload as an *additional* session preload (Electron's
// session.setPreloads layers preloads; it doesn't replace Theia's own), so
// the token global is injected before any app script without touching
// Theia's generated entrypoint. Our 'ready' listener is registered before
// electron-main.js's (this file loads first), and Electron fires 'ready'
// listeners in registration order, so this runs before any BrowserWindow
// (and its session) is created.
// NODE_OPTIONS is inherited by every Electron child process (renderer, GPU,
// utility), not just the main process, and `electron` only exports
// {app, session} in the main process (process.type === 'browser') — guard so
// this is a no-op everywhere else.
if (process.type !== 'browser') {
    module.exports = {};
    return;
}

const path = require('path');
const { app, session } = require('electron');

app.once('ready', () => {
    const existing = session.defaultSession.getPreloads();
    session.defaultSession.setPreloads([...existing, path.join(__dirname, 'preload.js')]);
    console.log('[promptconnext-spike] preload injected:', path.join(__dirname, 'preload.js'));
});
