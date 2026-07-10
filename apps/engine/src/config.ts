export const ENGINE_PORT = Number(process.env.PROMPTZONE_ENGINE_PORT ?? 47131);

// Cloud sync (apps/cloud) is opt-in — unset means the feature is off and no
// "Connect to PromptZone Cloud" step is offered (see docs/plans/0004).
export const CLOUD_API_URL = process.env.CLOUD_API_URL || null;

// When both are set, cloud login uses real Supabase password-grant auth and
// stores the returned JWT. When either is unset, cloud login falls back to
// apps/cloud's AUTH_MODE=stub scheme (a plain user id sent as X-User-Id) —
// the same dev-mode identity apps/cloud itself supports without Supabase.
export const SUPABASE_URL = process.env.SUPABASE_URL || null;
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || null;
