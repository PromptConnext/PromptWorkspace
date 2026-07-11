export const AUTH_MODE: "stub" | "supabase" =
  process.env.NEXT_PUBLIC_AUTH_MODE === "supabase" ? "supabase" : "stub";

export const CLOUD_API_URL = process.env.NEXT_PUBLIC_CLOUD_API_URL ?? "http://localhost:8080";
export const CLOUD_WS_URL = process.env.NEXT_PUBLIC_CLOUD_WS_URL ?? "ws://localhost:8080";

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
