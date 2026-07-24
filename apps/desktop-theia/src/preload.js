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

// ADR 0016 M2 sub-project 3: mirrors apps/desktop/src/update.ts +
// components/UpdatePrompt.tsx's shape (check -> {version, currentVersion} |
// null, downloadUpdate with progress, install-and-relaunch) over IPC instead
// of Tauri's plugin-updater/plugin-process. No consumer yet (M3 territory).
contextBridge.exposeInMainWorld('__PROMPTCONNEXT_UPDATER__', {
    check: () => ipcRenderer.invoke('promptconnext-update-check'),
    downloadUpdate: () => ipcRenderer.invoke('promptconnext-update-download'),
    quitAndInstall: () => ipcRenderer.invoke('promptconnext-update-install'),
    onProgress: (callback) => {
        const listener = (_event, progress) => callback(progress);
        ipcRenderer.on('promptconnext-update-progress', listener);
        return () => ipcRenderer.removeListener('promptconnext-update-progress', listener);
    },
});
