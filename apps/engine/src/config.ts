export const ENGINE_PORT = Number(process.env.PROMPTWORKSPACE_ENGINE_PORT ?? 47131);

// Cloud sync (apps/cloud) defaults to the hosted PromptWorkspace Cloud instance.
// Override with CLOUD_API_URL (e.g. http://localhost:8080 for local dev
// against a source checkout of apps/cloud, see docs/DEVELOPMENT.md). Set it
// to an empty string to disable cloud sync entirely. This and the CLOUD_WEB_URL
// default below copy packages/cloud-client/src/defaults.ts (the engine does not
// depend on that package); packages/cloud-client/test/defaults.test.ts fails if
// they drift.
const DEFAULT_CLOUD_API_URL = "https://workspace-api.promptconnext.com";
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
//
// SECURITY: the desktop opens this for credential entry, so whoever controls
// this origin can phish users. The default is the org-owned production domain
// (ADR 0014's mitigation: never a reclaimable `*.vercel.app` subdomain).
export const CLOUD_WEB_URL =
  process.env.CLOUD_WEB_URL || "https://workspace.promptconnext.com";

// Which URL scheme the host shell registered for the ADR 0014 sign-in callback.
// The engine is shell-agnostic, so whoever spawns it declares this and the
// engine forwards it to the web sign-in page (ADR 0014's 2026-08-01 amendment
// explains why the scheme can't just be a constant). That page allow-lists the
// value, so a new scheme here needs adding there too. The default keeps a bare
// `pnpm engine` run pointed at the shipping shell.
export const DEEP_LINK_SCHEME =
  process.env.PROMPTWORKSPACE_DEEP_LINK_SCHEME || "promptworkspace";
