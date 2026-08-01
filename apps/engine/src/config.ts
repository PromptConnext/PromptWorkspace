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
//
// SECURITY: the desktop opens this for credential entry, so whoever controls
// this origin can phish users. The default below is a `*.vercel.app` subdomain,
// which is only owned while the Vercel project exists — if it is ever deleted or
// renamed, the name becomes reclaimable by anyone (dangling-subdomain takeover).
// The 2026-07-25 pre-launch readiness review called moving to an org-owned
// custom domain a hard blocker for public distribution. On 2026-08-01 the
// owner accepted the risk for launch instead (ADR 0014, "Accepted risk"), so
// this ships on the vercel.app subdomain. The mitigation is unchanged and
// still outstanding: point this default (or the shipped build's CLOUD_WEB_URL)
// at a domain the org owns at the DNS level, e.g. app.promptconnext.com. Until
// then, do not delete or rename the Vercel project — that is what makes the
// name reclaimable.
export const CLOUD_WEB_URL =
  process.env.CLOUD_WEB_URL || "https://prompt-zone-web-app.vercel.app";

// Which URL scheme the host shell registered for the ADR 0014 sign-in callback.
// The engine is shell-agnostic, so whoever spawns it declares this and the
// engine forwards it to the web sign-in page (ADR 0014's 2026-08-01 amendment
// explains why the scheme can't just be a constant). That page allow-lists the
// value, so a new scheme here needs adding there too. The default keeps a bare
// `pnpm engine` run pointed at the shipping shell.
export const DEEP_LINK_SCHEME =
  process.env.PROMPTCONNEXT_DEEP_LINK_SCHEME || "promptconnext";
