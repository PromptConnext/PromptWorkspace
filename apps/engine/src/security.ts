// Localhost origin allowlist (ADR 0008). The engine binds 127.0.0.1, but any
// web page the user visits can still reach it — for WebSockets there is no CORS
// preflight, so a drive-by page could otherwise open the terminal socket and
// get a shell (CSWSH → RCE). Browsers always send an accurate Origin on both
// fetch and WS handshakes and cannot forge it, so an allowlist is the effective
// gate against the browser-driven threat. Extra origins via
// PROMPTWORKSPACE_ALLOWED_ORIGINS (comma-separated) for custom dev setups.
const DEFAULT_ORIGINS = [
  "tauri://localhost", // packaged app (macOS/Linux webview)
  "https://tauri.localhost", // packaged app (Windows webview)
  "http://localhost:1420", // vite dev server
  "http://127.0.0.1:1420",
];

export const ALLOWED_ORIGINS = new Set([
  ...DEFAULT_ORIGINS,
  ...(process.env.PROMPTWORKSPACE_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
]);

export function isAllowedOrigin(origin: string | undefined | null): boolean {
  return typeof origin === "string" && ALLOWED_ORIGINS.has(origin);
}

// Per-session auth token (ADR 0008/0001). The packaged Tauri shell mints a
// random token, passes it to the engine via PROMPTWORKSPACE_AUTH_TOKEN, and injects
// it into the webview. When set, every request must present it — defending
// against same-origin XSS and non-browser local processes that the origin
// allowlist alone can't stop. Unset in dev (`pnpm engine`) so local iteration
// and browser tests keep working.
export const AUTH_TOKEN = process.env.PROMPTWORKSPACE_AUTH_TOKEN ?? null;

// Accept the token via header (HTTP) or `?token=` (WebSocket handshakes, where
// browsers can't set headers). Returns true when no token is configured.
export function isAuthorized(headerToken: string | undefined, queryToken: string | null): boolean {
  if (!AUTH_TOKEN) return true;
  const bearer = headerToken?.replace(/^Bearer\s+/i, "");
  return bearer === AUTH_TOKEN || queryToken === AUTH_TOKEN;
}
