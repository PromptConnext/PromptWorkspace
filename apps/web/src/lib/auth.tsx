"use client";

// Mirrors apps/engine/src/cloudClient.ts's auth-header logic on the browser
// side: stub mode sends X-User-Id, supabase mode sends a Bearer JWT from a
// real Supabase Auth session.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { AUTH_MODE, SUPABASE_ANON_KEY, SUPABASE_URL } from "./config";

const STUB_USER_KEY = "pz_stub_user_id";

export interface AuthUser {
  id: string;
  email: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  authHeaders: () => Record<string, string>;
  signInStub: (userId: string) => void;
  signInSupabase: (email: string, password: string) => Promise<void>;
  signUpSupabase: (email: string, password: string) => Promise<void>;
  sendPasswordReset: (email: string) => Promise<void>;
  updatePassword: (newPassword: string) => Promise<void>;
  signOut: () => Promise<void>;
  getSessionTokens: () => Promise<{ accessToken: string; refreshToken: string } | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

let supabase: SupabaseClient | null = null;
function getSupabase(): SupabaseClient {
  if (!supabase) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set");
    }
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return supabase;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (AUTH_MODE === "stub") {
      const stored = typeof window !== "undefined" ? localStorage.getItem(STUB_USER_KEY) : null;
      if (stored) setUser({ id: stored, email: `${stored}@promptzone.local` });
      setLoading(false);
      return;
    }

    const client = getSupabase();
    client.auth.getSession().then(({ data }) => {
      const session = data.session;
      if (session) {
        setUser({ id: session.user.id, email: session.user.email ?? "" });
        setToken(session.access_token);
      }
      setLoading(false);
    });
    const { data: sub } = client.auth.onAuthStateChange((_event, session) => {
      if (session) {
        setUser({ id: session.user.id, email: session.user.email ?? "" });
        setToken(session.access_token);
      } else {
        setUser(null);
        setToken(null);
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const signInStub = useCallback((userId: string) => {
    localStorage.setItem(STUB_USER_KEY, userId);
    setUser({ id: userId, email: `${userId}@promptzone.local` });
  }, []);

  const signInSupabase = useCallback(async (email: string, password: string) => {
    const { error } = await getSupabase().auth.signInWithPassword({ email, password });
    if (error) throw error;
  }, []);

  const signUpSupabase = useCallback(async (email: string, password: string) => {
    const { error } = await getSupabase().auth.signUp({ email, password });
    if (error) throw error;
  }, []);

  // Supabase mails a recovery link back to /reset-password; the redirect must be
  // an absolute URL, so it's built from the live origin at call time.
  const sendPasswordReset = useCallback(async (email: string) => {
    const redirectTo =
      typeof window !== "undefined" ? `${window.location.origin}/reset-password` : undefined;
    const { error } = await getSupabase().auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw error;
  }, []);

  const updatePassword = useCallback(async (newPassword: string) => {
    const { error } = await getSupabase().auth.updateUser({ password: newPassword });
    if (error) throw error;
  }, []);

  const signOut = useCallback(async () => {
    if (AUTH_MODE === "stub") {
      localStorage.removeItem(STUB_USER_KEY);
      setUser(null);
      return;
    }
    await getSupabase().auth.signOut();
  }, []);

  const getSessionTokens = useCallback(async () => {
    const { data } = await getSupabase().auth.getSession();
    const session = data.session;
    if (!session) return null;
    return { accessToken: session.access_token, refreshToken: session.refresh_token };
  }, []);

  const authHeaders = useCallback((): Record<string, string> => {
    if (AUTH_MODE === "stub") {
      return user ? { "x-user-id": user.id } : {};
    }
    return token ? { authorization: `Bearer ${token}` } : {};
  }, [user, token]);

  const value = useMemo(
    () => ({
      user,
      loading,
      authHeaders,
      signInStub,
      signInSupabase,
      signUpSupabase,
      sendPasswordReset,
      updatePassword,
      signOut,
      getSessionTokens,
    }),
    [
      user,
      loading,
      authHeaders,
      signInStub,
      signInSupabase,
      signUpSupabase,
      sendPasswordReset,
      updatePassword,
      signOut,
      getSessionTokens,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

// Presence's WS auth query param (?token=... in supabase mode, ?user_id=...
// in stub mode) — see apps/cloud/app/api/presence.py's _identify().
export function usePresenceAuthParam(): { key: "token" | "user_id"; value: string } | null {
  const { user, authHeaders } = useAuth();
  if (!user) return null;
  if (AUTH_MODE === "stub") return { key: "user_id", value: user.id };
  const auth = authHeaders().authorization;
  if (!auth) return null;
  return { key: "token", value: auth.replace(/^Bearer /, "") };
}
