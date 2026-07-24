// ADR 0008 token, reproduced exactly for the Theia spike (M0).
// Same shape as apps/desktop/src-tauri/src/lib.rs::mint_token(): 32 hex chars
// from the OS CSPRNG, minted once per launch, shared with the engine via env
// and with the renderer via window.__PROMPTCONNEXT_TOKEN__.
const crypto = require('crypto');

function mintToken() {
    return crypto.randomBytes(16).toString('hex');
}

module.exports = { mintToken };
