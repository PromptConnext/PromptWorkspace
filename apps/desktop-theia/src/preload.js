// Electron preload (ADR 0008 M0 port): runs in an isolated context before any
// renderer/app script, same guarantee as the Tauri initialization_script.
// contextIsolation stays on (Electron default/secure); we only need the
// global visible to page scripts, so we use contextBridge.
const { contextBridge, ipcRenderer } = require('electron');

const token = process.env.PROMPTCONNEXT_TOKEN || '';

contextBridge.exposeInMainWorld('__PROMPTCONNEXT_TOKEN__', token);

// ADR 0016 M2 sub-project 2: the promptconnext:// deep-link callback (ADR
// 0014), relayed from the main process (src/deep-link.js) over Electron IPC
// instead of Tauri's emit/listen event bus. No consumer exists yet — the
// Planner extension that redeems the code doesn't land until M3 — but the
// wiring is live end-to-end today, same "plumbing parity" bar as the token.
contextBridge.exposeInMainWorld('__PROMPTCONNEXT_ON_AUTH_CALLBACK__', (callback) => {
    const listener = (_event, url) => callback(url);
    ipcRenderer.on('promptconnext-auth-callback', listener);
    return () => ipcRenderer.removeListener('promptconnext-auth-callback', listener);
});
