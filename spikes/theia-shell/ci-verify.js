// CI verification for the ADR 0016 M0 spike (Windows x64 leg — the macOS
// arm64 leg was verified manually, see docs/m0-report.md). Exercises the
// engine sidecar + ADR 0008 token/origin model directly (no Electron
// window needed for this part), then smoke-launches the actual Theia
// Electron app headlessly to prove it boots on Windows. Exits non-zero on
// any failed assertion so the GitHub Actions job fails loudly.
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const { mintToken } = require('./src/token');
const { spawnEngine, killEngine } = require('./src/engine-lifecycle');

const PORT = 47199;
let failures = 0;

function check(label, cond) {
    if (cond) {
        console.log(`PASS: ${label}`);
    } else {
        console.error(`FAIL: ${label}`);
        failures++;
    }
}

function get(url, headers) {
    return new Promise((resolve, reject) => {
        http.get(url, { headers }, res => {
            let body = '';
            res.on('data', c => (body += c));
            res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('error', reject);
    });
}

function post(url, headers, data) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(data);
        const req = http.request(
            url,
            { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' } },
            res => {
                let body = '';
                res.on('data', c => (body += c));
                res.on('end', () => resolve({ status: res.statusCode, body }));
            },
        );
        req.on('error', reject);
        req.end(payload);
    });
}

function waitForHealth(retriesLeft) {
    return get(`http://127.0.0.1:${PORT}/engine/health`).catch(() => null).then(res => {
        if (res && res.status === 200) return;
        if (retriesLeft <= 0) throw new Error('engine never came up');
        return new Promise(r => setTimeout(r, 500)).then(() => waitForHealth(retriesLeft - 1));
    });
}

// WS origin test in-process (no extra deps): allowed origin should open,
// evil/missing origin should close 1008, reproducing ADR 0008's terminal-WS
// guard purely via the PROMPTCONNEXT_ALLOWED_ORIGINS env extension point.
function wsOriginTest(origin, projectId, token) {
    return new Promise(resolve => {
        const ws = new WebSocket(
            `ws://127.0.0.1:${PORT}/engine/projects/${projectId}/terminal?token=${token}`,
            origin ? { headers: { Origin: origin } } : undefined,
        );
        let opened = false;
        ws.onopen = () => { opened = true; ws.close(); };
        ws.onclose = e => resolve({ opened, code: e.code, reason: e.reason });
        ws.onerror = () => {};
        setTimeout(() => resolve({ opened, code: null, reason: 'timeout' }), 5000);
    });
}

(async () => {
    const token = mintToken();
    console.log('minted token', token);
    const engine = spawnEngine(token, PORT);

    try {
        await waitForHealth(60);
        check('engine health reachable', true);

        const noAuth = await get(`http://127.0.0.1:${PORT}/agents`);
        check('request without token is 401', noAuth.status === 401);

        const created = await post(
            `http://127.0.0.1:${PORT}/engine/projects`,
            { Authorization: `Bearer ${token}` },
            { name: 'ci-verify-project', path: __dirname },
        );
        check('project creation with token succeeds', created.status === 200 || created.status === 201);
        const projectId = JSON.parse(created.body).id;

        const files = await get(`http://127.0.0.1:${PORT}/engine/projects/${projectId}/files`, {
            Authorization: `Bearer ${token}`,
        });
        check('file listing route works end-to-end', files.status === 200 && JSON.parse(files.body).tree);

        const status = await get(`http://127.0.0.1:${PORT}/engine/projects/${projectId}/status`, {
            Authorization: `Bearer ${token}`,
        });
        check('status route works end-to-end', status.status === 200);

        const allowed = await wsOriginTest('http://localhost:62219', projectId, token);
        check('allowlisted origin opens the terminal WS', allowed.opened === true);

        // The server can only reject with a custom close code (1008) after
        // completing the WS upgrade handshake, which fires the client's
        // 'open' event first — a raw HTTP 403 is the only way to fail
        // before that. So `opened` alone doesn't indicate a security hole;
        // what matters is that it's closed with 1008 before anything else
        // (no pty spawn) can happen.
        const evil = await wsOriginTest('http://evil.example.com', projectId, token);
        check('evil origin is rejected (1008)', evil.code === 1008);

        const missing = await wsOriginTest(undefined, projectId, token);
        check('missing origin is rejected (1008)', missing.code === 1008);
    } finally {
        killEngine(engine);
    }

    // Smoke-launch the actual Electron app to prove it boots on this OS.
    // Bounded run: kill after the frontend reports 'ready' or after a timeout.
    console.log('--- smoke-launching Theia Electron app ---');
    const electronBin = require('electron');
    const result = spawnSync(
        process.platform === 'win32' ? 'cmd' : 'node',
        process.platform === 'win32'
            ? ['/c', 'node', 'start-spike.js']
            : ['start-spike.js'],
        {
            cwd: __dirname,
            encoding: 'utf8',
            timeout: 60_000,
            env: { ...process.env, PROMPTCONNEXT_ENGINE_ALREADY_VERIFIED: '1' },
        },
    );
    const out = `${result.stdout || ''}${result.stderr || ''}`;
    console.log(out);
    check('Theia Electron app reaches the ready state', /Changed application state from .* to .ready./.test(out));

    console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
})().catch(err => {
    console.error('ci-verify crashed:', err);
    process.exit(1);
});
