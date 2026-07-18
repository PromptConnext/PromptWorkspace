export const ENGINE_PORT = Number(process.env.PROMPTCONNEXT_ENGINE_PORT ?? 47131);

// Cloud sync (apps/cloud) defaults to the hosted PromptConnext Cloud instance.
// Override with CLOUD_API_URL (e.g. http://localhost:8080 for local dev
// against a source checkout of apps/cloud, see docs/DEVELOPMENT.md). Set it
// to an empty string to disable cloud sync entirely.
const DEFAULT_CLOUD_API_URL = "https://promptconnextcloud-production.up.railway.app";
export const CLOUD_API_URL =
  process.env.CLOUD_API_URL === ""
    ? null
    : process.env.CLOUD_API_URL || DEFAULT_CLOUD_API_URL;

// When both are set, cloud login uses real Supabase password-grant auth and
// stores the returned JWT. When either is unset, cloud login falls back to
// apps/cloud's AUTH_MODE=stub scheme (a plain user id sent as X-User-Id) —
// the same dev-mode identity apps/cloud itself supports without Supabase.
export const SUPABASE_URL = process.env.SUPABASE_URL || null;
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || null;

// Where the browser is sent for interactive sign-in (ADR 0014). Defaults to
// the deployed hosted web app; override for local dev against `pnpm web`
// (http://localhost:3000). Not nullable — browser login needs a destination.
// This is a real TLS-served, team-owned origin (closes the phishing gate: the
// desktop opens it for credential entry, so an unregistered placeholder would
// be a takeover vector).
export const CLOUD_WEB_URL =
  process.env.CLOUD_WEB_URL || "https://prompt-zone-web-app.vercel.app";
