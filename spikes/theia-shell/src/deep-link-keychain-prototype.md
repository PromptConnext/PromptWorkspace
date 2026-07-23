# Deep-link + keychain re-home prototype notes (ADR 0016 M0)

Goal: prove the two Rust-shell responsibilities not yet ported are routine
under Electron, without fully porting ADR 0014's redeem flow. Not wired into
the running spike app — this documents the concrete API calls and confirms
no blocker exists.

## Deep-link (`promptconnext://`)

Electron's main-process API replaces `tauri-plugin-deep-link` 1:1:

```js
const { app } = require('electron');

if (!app.isDefaultProtocolClient('promptconnext')) {
  app.setAsDefaultProtocolClient('promptconnext');
}

// macOS: fires when the OS opens a promptconnext:// URL
app.on('open-url', (event, url) => {
  event.preventDefault();
  forwardToRenderer(url); // same shape as lib.rs's `auth-callback` emit
});

// Windows/Linux: single-instance re-launch carries the URL in argv, exactly
// like tauri-plugin-single-instance's second-instance callback today.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (event, argv) => {
    const url = argv.find(a => a.startsWith('promptconnext://'));
    if (url) forwardToRenderer(url);
  });
}
```

This is a direct, well-documented mapping — `setAsDefaultProtocolClient` +
`open-url` (macOS) + `second-instance` argv (Windows/Linux) is the standard
Electron deep-link recipe and is what `electron-builder`'s protocol-handler
tooling assumes. **No blocker.** The one caveat ADR 0016 already calls out —
macOS has no *runtime* registration API for an unbundled dev process, so
`tauri dev` needed the "paste the code manually" fallback — carries over
identically to unpackaged Electron (`electron .` in dev also isn't a
registered bundle), so TopBar's existing manual-code fallback ports unchanged.

## Keychain

Electron ships `safeStorage` (built-in, no native module compile step,
replaces the macOS-only `security` CLI shell-out):

```js
const { safeStorage } = require('electron');

function encryptToken(plaintext) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS keychain unavailable');
  return safeStorage.encryptString(plaintext); // Buffer, back it with a file or app storage
}

function decryptToken(buf) {
  return safeStorage.decryptString(buf);
}
```

`safeStorage` uses Keychain Services on macOS and DPAPI on Windows under the
hood — exactly the two backends ADR 0001 flagged as needed, and it is
**built into Electron itself** (no `keytar` native-module dependency, which
matters because `keytar` is deprecated and needs prebuild binaries per
platform — `safeStorage` avoids that whole prebuild-per-platform problem that
already bit `node-pty` in the current bundle). **No blocker; this is easier
than the current Rust `security` CLI shell-out**, matching the research
document's prediction in ADR 0016 §"What moves."

## Verdict

Both re-homes are routine, well-trodden Electron APIs with no missing
platform primitive. Full port (wiring these into the actual redeem/keychain
call sites from ADR 0014) is out of scope for M0 and belongs in M2.
