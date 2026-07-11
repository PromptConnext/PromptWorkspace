// Fail closed: only an explicit "stub" opts into the insecure X-User-Id
// header path. Unset/misconfigured falls back to real Supabase auth, not
// the weaker mode — a forgotten env var in production must not silently
// downgrade auth.
export const AUTH_MODE: "stub" | "supabase" =
  process.env.NEXT_PUBLIC_AUTH_MODE === "stub" ? "stub" : "supabase";

export const CLOUD_API_URL = process.env.NEXT_PUBLIC_CLOUD_API_URL ?? "http://localhost:8080";
export const CLOUD_WS_URL = process.env.NEXT_PUBLIC_CLOUD_WS_URL ?? "ws://localhost:8080";

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
