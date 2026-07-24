// Engine sidecar lifecycle (ADR 0016 M2). Deliberately mirrors
// apps/desktop/src-tauri/src/lib.rs 1:1: same env vars, same
// "prefer bundled node, else PATH" resolution, same parent-pid watch
// contract on the engine side. The engine itself (apps/engine) is untouched.
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');

// Engine resolution (ADR 0001, mirrors apps/desktop/src-tauri/src/lib.rs::engine_dir):
// explicit override, else the packaged app's bundled resource dir, else the
// repo checkout this file is running from (dev). The packaged branch has no
// bundled engine/ yet — that's ADR 0016 M2 sub-project 4 (CI + packaging) —
// but the resolution logic is correct now so that sub-project doesn't need
// to touch this function again.
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
        console.log(`[promptconnext-spike] engine exited (code=${code}, signal=${signal})`);
    });
    return child;
}

function killEngine(child) {
    if (child && !child.killed) {
        child.kill();
    }
}

module.exports = { spawnEngine, killEngine, engineDir };
