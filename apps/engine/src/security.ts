// Localhost origin allowlist (ADR 0008). The engine binds 127.0.0.1, but any
// web page the user visits can still reach it — for WebSockets there is no CORS
// preflight, so a drive-by page could otherwise open the terminal socket and
// get a shell (CSWSH → RCE). Browsers always send an accurate Origin on both
// fetch and WS handshakes and cannot forge it, so an allowlist is the effective
// gate against the browser-driven threat. Extra origins via
// PROMPTZONE_ALLOWED_ORIGINS (comma-separated) for custom dev setups.
const DEFAULT_ORIGINS = [
  "tauri://localhost", // packaged app (macOS/Linux webview)
  "https://tauri.localhost", // packaged app (Windows webview)
  "http://localhost:1420", // vite dev server
  "http://127.0.0.1:1420",
];

export const ALLOWED_ORIGINS = new Set([
  ...DEFAULT_ORIGINS,
  ...(process.env.PROMPTZONE_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
]);

export function isAllowedOrigin(origin: string | undefined | null): boolean {
  return typeof origin === "string" && ALLOWED_ORIGINS.has(origin);
}
