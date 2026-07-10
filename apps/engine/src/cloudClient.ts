// Thin fetch wrapper around apps/cloud's REST API (docs/plans/0004 D1-D2).
// Mirrors apps/desktop/src/api.ts's request<T> shape on the other side of the
// engine, but authenticates as the *cloud* user, not the local engine session.
import { getAppState, setAppState } from "./db.ts";
import { readSecret, storeSecret, deleteSecret } from "./keychain.ts";
import { CLOUD_API_URL, SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.ts";

const SESSION_KEY = "cloud_session";
const SESSION_CRED = "cloud.session";

export type CloudSession = { mode: "stub" | "supabase"; userId: string };

export function cloudMode(): "stub" | "supabase" {
  return SUPABASE_URL && SUPABASE_ANON_KEY ? "supabase" : "stub";
}

export function loadCloudSession(): CloudSession | null {
  const raw = getAppState(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CloudSession;
  } catch {
    return null;
  }
}

export function storeCloudSession(session: CloudSession, token?: string): void {
  if (token) storeSecret(SESSION_CRED, token);
  setAppState(SESSION_KEY, JSON.stringify(session));
}

export function clearCloudSession(): void {
  deleteSecret(SESSION_CRED);
  setAppState(SESSION_KEY, JSON.stringify(null));
}

function authHeaders(session: CloudSession): Record<string, string> {
  if (session.mode === "supabase") {
    const token = readSecret(SESSION_CRED);
    if (!token) throw new Error("cloud session token missing — log in again");
    return { authorization: `Bearer ${token}` };
  }
  return { "x-user-id": session.userId };
}

export class CloudNotConfiguredError extends Error {
  constructor() {
    super("cloud sync is not configured (CLOUD_API_URL unset)");
  }
}

export class CloudNotLoggedInError extends Error {
  constructor() {
    super("not logged in to PromptZone Cloud");
  }
}

// Authenticated call against apps/cloud, using whichever session is stored.
export async function cloudFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!CLOUD_API_URL) throw new CloudNotConfiguredError();
  const session = loadCloudSession();
  if (!session) throw new CloudNotLoggedInError();
  const res = await fetch(`${CLOUD_API_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...authHeaders(session),
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `cloud HTTP ${res.status}`);
  }
  return data as T;
}

// Real Supabase password-grant login — only used when SUPABASE_URL/ANON_KEY
// are configured. Returns the access token + resolved user id; caller is
// responsible for persisting the session.
export async function supabasePasswordLogin(
  email: string,
  password: string,
): Promise<{ token: string; userId: string }> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("Supabase auth is not configured");
  }
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data as { error_description?: string; msg?: string };
    throw new Error(err.error_description ?? err.msg ?? "login failed");
  }
  const ok = data as { access_token: string; user: { id: string } };
  return { token: ok.access_token, userId: ok.user.id };
}
