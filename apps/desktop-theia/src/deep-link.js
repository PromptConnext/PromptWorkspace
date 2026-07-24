// promptconnext:// deep-link handling (ADR 0016 M2 sub-project 2), mirrors
// apps/desktop/src-tauri/src/lib.rs's use of tauri-plugin-deep-link +
// tauri-plugin-single-instance: register the protocol, forward every
// promptconnext:// open to the one running instance, and re-focus that
// instance's window instead of letting a second one spawn.
//
// macOS: 'open-url' fires directly on the OS event, before or after
// app.ready depending on launch timing. Windows/Linux have no such event —
// a second launch instead re-invokes the app, which requestSingleInstanceLock
// intercepts and relays via 'second-instance''s additionalData (the argv we
// pass to requestSingleInstanceLock below), the same relay lib.rs wires
// through tauri-plugin-single-instance's second-instance callback.
//
// Same caveat as lib.rs's comment on macOS registration: Launch Services
// only reads CFBundleURLTypes from a bundle's Info.plist, so an unpackaged
// `electron .` dev run has no OS-level handler for the scheme even after
// setAsDefaultProtocolClient() — that call is a no-op until this app is
// actually packaged. Nothing here can fix that in dev; whatever manual
// "paste the code" fallback the Planner extension needs (M3) is unaffected
// by this sub-project either way.
const { app } = require('electron');

const PROTOCOL = 'promptconnext';

// Forward a deep-link URL to the given callback, once one is registered.
// Buffers at most the most recent URL seen before the callback exists (an
// OS 'open-url' can fire before Theia's first window has loaded), matching
// tauri-plugin-deep-link's own internal queuing.
let pendingUrl = null;
let deliver = null;

function forward(url) {
    if (deliver) {
        deliver(url);
    } else {
        pendingUrl = url;
    }
}

// Called once a window exists and can receive the callback (Task 3 wires
// this to webContents.send after the first window finishes loading).
function onDeepLink(callback) {
    deliver = callback;
    if (pendingUrl) {
        deliver(pendingUrl);
        pendingUrl = null;
    }
}

// Must run before app.ready and before any other single-instance-sensitive
// setup — the second instance quits immediately if another is already
// running, so nothing else in electron-entry.js should execute after a
// `false` return here.
//
// Theia registers its own single-instance lock inside the electron-main.js
// this file requires further down (src-gen/backend/electron-main.js calls
// app.requestSingleInstanceLock(process.argv), and its own 'second-instance'
// handler reads process.argv back out of the event's fourth ("additionalData")
// parameter — NOT the raw argv this callback receives). Because Electron only
// honors the *first* requestSingleInstanceLock() call per process, we have to
// make that first call ourselves (to gate spawning the engine on it) — so we
// pass process.argv through exactly as Theia would have, keeping its own
// second-instance handler working once it registers its listener.
function acquireSingleInstanceLock() {
    const gotLock = app.requestSingleInstanceLock(process.argv);
    if (!gotLock) {
        app.quit();
        return false;
    }

    app.on('second-instance', (_event, _argv, _cwd, additionalData) => {
        const relaunchArgv = Array.isArray(additionalData) ? additionalData : [];
        const url = relaunchArgv.find((a) => a.startsWith(`${PROTOCOL}://`));
        if (url) {
            forward(url);
        }
        // Re-focus the running instance's window, same as lib.rs's
        // single-instance callback does via get_webview_window("main").
        const [win] = require('electron').BrowserWindow.getAllWindows();
        if (win) {
            if (win.isMinimized()) win.restore();
            win.focus();
        }
    });

    return true;
}

function registerDeepLink() {
    // Append '--open-url' the same way Theia's own Windows registration does
    // (electron-main-application.js) so a promptconnext:// launch arg is
    // recognized by that convention rather than mis-parsed as a workspace
    // path to open, on the off chance Theia's second-instance handler sees
    // it before this module's own listener above does.
    if (!app.isDefaultProtocolClient(PROTOCOL)) {
        app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, ['--open-url']);
    }

    app.on('open-url', (event, url) => {
        event.preventDefault();
        forward(url);
    });
}

module.exports = { acquireSingleInstanceLock, registerDeepLink, onDeepLink };
