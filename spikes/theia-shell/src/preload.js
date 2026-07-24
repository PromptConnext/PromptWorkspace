// Electron preload (ADR 0008 M0 port): runs in an isolated context before any
// renderer/app script, same guarantee as the Tauri initialization_script.
// contextIsolation stays on (Electron default/secure); we only need the
// global visible to page scripts, so we use contextBridge.
const { contextBridge } = require('electron');

const token = process.env.PROMPTCONNEXT_TOKEN || '';

contextBridge.exposeInMainWorld('__PROMPTCONNEXT_TOKEN__', token);
