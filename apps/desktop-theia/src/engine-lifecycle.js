// Engine sidecar lifecycle (ADR 0016 M2). Mirrors apps/desktop/src-tauri/
// src/lib.rs's env vars and parent-pid watch contract on the engine side.
// Does NOT yet mirror lib.rs's "prefer bundled node, else PATH" node
// resolution — spawnEngine() below does a bare PATH lookup, which is fine
// for dev but will need the bundled-node preference before packaging
// (ADR 0016 M2 sub-project 4). The engine itself (apps/engine) is untouched.
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');

// Engine resolution (ADR 0001, mirrors apps/desktop/src-tauri/src/lib.rs::engine_dir):
// explicit override, else the packaged app's bundled resource dir, else the
// repo checkout this file is running from (dev). Unlike lib.rs, the packaged
// branch here doesn't check the bundled dir actually exists before returning
// it — there's no bundled engine/ yet to check against — so sub-project 4
// (CI + packaging) will need to add that guard when it starts populating
// resourcesPath/engine.
function engineDir() {
    if (process.env.PROMPTCONNEXT_ENGINE_DIR) {
        return process.env.PROMPTCONNEXT_ENGINE_DIR;
    }
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'engine');
    }
    return path.resolve(__dirname, '../../../apps/engine');
}

function spawnEngine(token, port) {
    const child = spawn('node', ['src/index.ts'], {
        cwd: engineDir(),
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
