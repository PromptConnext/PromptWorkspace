// M0 spike launcher: mint the ADR-0008 token, spawn the engine sidecar
// (unmodified apps/engine), wait for health, then launch the Theia Electron
// app with our preload injected. Mirrors what lib.rs does in one process
// instead of two languages, since the spike's goal is to prove the wiring,
// not to build the real Electron main-process integration (that's M2).
const path = require('path');
const { spawnSync } = require('child_process');
const http = require('http');
const { mintToken } = require('./src/token');
const { spawnEngine } = require('./src/engine-lifecycle');

const PORT = 47199; // dedicated spike port, avoids clashing with a dev `pnpm engine` on 47131
const token = mintToken();
console.log('[promptconnext-spike] minted token', token);

const engine = spawnEngine(token, PORT);

function waitForHealth(retriesLeft) {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${PORT}/engine/health`, res => {
            if (res.statusCode === 200) {
                resolve();
            } else if (retriesLeft > 0) {
                setTimeout(() => waitForHealth(retriesLeft - 1).then(resolve, reject), 500);
            } else {
                reject(new Error('engine health never returned 200'));
            }
        });
        req.on('error', () => {
            if (retriesLeft > 0) {
                setTimeout(() => waitForHealth(retriesLeft - 1).then(resolve, reject), 500);
            } else {
                reject(new Error('engine never came up'));
            }
        });
    });
}

waitForHealth(40).then(() => {
    console.log('[promptconnext-spike] engine healthy, launching Theia');
    const electronBin = require('electron');
    const projectArg = process.argv[2] || path.resolve(__dirname, '../../apps/engine');
    const result = spawnSync(electronBin, [path.join(__dirname, 'src/electron-entry.js'), projectArg], {
        stdio: 'inherit',
        env: {
            ...process.env,
            PROMPTCONNEXT_TOKEN: token,
        },
    });
    engine.kill();
    process.exit(result.status || 0);
}).catch(err => {
    console.error('[promptconnext-spike] FAIL:', err.message);
    engine.kill();
    process.exit(1);
});
