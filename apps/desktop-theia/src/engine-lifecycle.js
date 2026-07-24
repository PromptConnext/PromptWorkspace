// Engine sidecar lifecycle (ADR 0016 M2). Mirrors apps/desktop/src-tauri/
// src/lib.rs's env vars, node-binary preference, and parent-pid watch
// contract on the engine side. The engine itself (apps/engine) is untouched.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');

// Engine resolution (ADR 0001, mirrors apps/desktop/src-tauri/src/lib.rs::engine_dir):
// explicit override, else the packaged app's bundled resource dir — only if
// scripts/bundle-node.mjs (sub-project 4) actually staged one there, else
// falling through to dev — else the repo checkout this file is running from.
function engineDir() {
    if (process.env.PROMPTCONNEXT_ENGINE_DIR) {
        return process.env.PROMPTCONNEXT_ENGINE_DIR;
    }
    if (app.isPackaged) {
        const bundled = path.join(process.resourcesPath, 'engine');
        if (fs.existsSync(path.join(bundled, 'src', 'index.ts'))) {
            return bundled;
        }
        // A packaged app has no repo checkout to fall through to — the dev
        // path below cannot exist here. Log loudly so a broken bundle isn't
        // silently indistinguishable from a missing system Node in the logs.
        console.error(
            `[promptconnext-desktop-theia] bundled engine missing at ${bundled} — packaging is broken`,
        );
    }
    return path.resolve(__dirname, '../../../apps/engine');
}

// Node binary resolution (mirrors lib.rs's node/node.exe preference): the
// staged bundle's own Node first (guarantees the ABI matches the node-pty
// prebuilt it was staged with), else whatever `node` resolves to on PATH.
function nodeBinary(dir) {
    const bundled = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
    return fs.existsSync(bundled) ? bundled : 'node';
}

function spawnEngine(token, port) {
    const dir = engineDir();
    const child = spawn(nodeBinary(dir), ['src/index.ts'], {
        cwd: dir,
        env: {
            ...process.env,
            PROMPTCONNEXT_PARENT_PID: String(process.pid),
            PROMPTCONNEXT_AUTH_TOKEN: token,
            PROMPTCONNEXT_ENGINE_PORT: String(port),
            // M0: extend the engine's origin allowlist to this Electron
            // renderer's origin via the existing env-var extension point
            // (src/security.ts) — no engine code change.
            PROMPTCONNEXT_ALLOWED_ORIGINS: [
                process.env.PROMPTCONNEXT_ALLOWED_ORIGINS,
                'file://',
            ].filter(Boolean).join(','),
        },
        stdio: 'inherit',
    });
    child.on('exit', (code, signal) => {
        console.log(`[promptconnext-desktop-theia] engine exited (code=${code}, signal=${signal})`);
    });
    // spawn() doesn't throw on failure (e.g. `node` missing from PATH) — it
    // emits 'error' asynchronously. An 'error' event with no listener is
    // rethrown as an uncaught exception, which here would take down the
    // whole Electron main process. Log and let /engine/health surface the
    // outage instead, matching lib.rs's "never block the shell on a failed
    // sidecar" posture.
    child.on('error', (err) => {
        console.error('[promptconnext-desktop-theia] failed to start engine:', err);
    });
    return child;
}

function killEngine(child) {
    if (child && !child.killed) {
        child.kill();
    }
}

module.exports = { spawnEngine, killEngine, engineDir };
