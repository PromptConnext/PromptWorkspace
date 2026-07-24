// Engine sidecar lifecycle for the Theia spike (ADR 0016 M0).
// Deliberately mirrors apps/desktop/src-tauri/src/lib.rs 1:1: same env vars,
// same "prefer bundled node, else PATH" resolution, same parent-pid watch
// contract on the engine side. The engine itself (apps/engine) is untouched.
const path = require('path');
const { spawn } = require('child_process');

const ENGINE_DIR =
    process.env.PROMPTCONNEXT_ENGINE_DIR ||
    path.resolve(__dirname, '../../../apps/engine');

function spawnEngine(token, port) {
    const child = spawn('node', ['src/index.ts'], {
        cwd: ENGINE_DIR,
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

module.exports = { spawnEngine, killEngine, ENGINE_DIR };
