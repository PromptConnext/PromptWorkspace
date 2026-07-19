"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AUTH_MODE } from "@/lib/config";
import { useAuth } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { AuthCard, AuthLink, AuthLinks, Field, FormError, SubmitButton } from "@/components/auth/ui";

// Only same-origin, in-app paths are safe redirect targets. Reject absolute
// URLs and protocol-relative paths ("//evil.example") — both would send a
// just-authenticated user off-site.
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

function LoginForm() {
  const { user, signInStub, signInSupabase, getSessionTokens } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const desktop = params.get("desktop") === "1";
  const desktopState = params.get("state");

  const [userId, setUserId] = useState("dev-user");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Fallback for when the promptconnext:// redirect never arrives — e.g. a
  // `tauri dev` build, where macOS never registers a handler for the scheme
  // outside a bundled+installed .app (there's no Info.plist to source it
  // from). We still attempt the automatic redirect, but keep the code
  // visible so the user can paste it into the desktop app themselves.
  const [handoffCode, setHandoffCode] = useState<string | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!user) return;
    if (desktop && desktopState) {
      // Hand the session to the cloud broker, then bounce to the desktop.
      (async () => {
        const tokens = await getSessionTokens();
        if (!tokens) {
          router.replace(next);
          return;
        }
        try {
          const { code } = await apiFetch<{ code: string }>(
            "/desktop-auth/handoff",
            { authorization: `Bearer ${tokens.accessToken}` },
            {
              method: "POST",
              body: JSON.stringify({
                refresh_token: tokens.refreshToken,
                access_token: tokens.accessToken,
              }),
            },
          );
          setHandoffCode(code);
          window.location.href =
            `promptconnext://auth/callback?code=${encodeURIComponent(code)}` +
            `&state=${encodeURIComponent(desktopState)}`;
        } catch (err) {
          setHandoffError(err instanceof Error ? err.message : "Failed to hand off to the desktop app.");
        }
      })();
      return;
    }
    router.replace(next);
  }, [user, desktop, desktopState, getSessionTokens, next, router]);

  if (user && desktop && desktopState) {
    return (
      <AuthCard title="Signed in">
        {handoffError ? (
          <FormError message={handoffError} />
        ) : handoffCode ? (
          <>
            <p className="text-sm text-slate-600">
              Redirecting you back to the desktop app… If nothing happens in a few seconds
              (common when running the app in development), copy this code and paste it into
              the desktop app&apos;s sign-in screen instead:
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded border border-slate-300 bg-slate-50 px-3 py-2 text-sm">
                {handoffCode}
              </code>
              <button
                type="button"
                className="rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"
                onClick={async () => {
                  await navigator.clipboard.writeText(handoffCode);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? "Copied ✓" : "Copy"}
              </button>
            </div>
          </>
        ) : (
          <p className="text-sm text-slate-500">Preparing handoff…</p>
        )}
      </AuthCard>
    );
  }

  if (user) return null;

  const qs = params.toString();
  const withQuery = (path: string) => (qs ? `${path}?${qs}` : path);

  async function handleStubSubmit(e: React.FormEvent) {
    e.preventDefault();
    signInStub(userId.trim() || "dev-user");
    router.replace(next);
  }

  async function handleSupabaseSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await signInSupabase(email, password);
      router.replace(next);
    } catch (err) {
      setError((err as Error).message);
      setPending(false);
    }
  }

  if (AUTH_MODE === "stub") {
    return (
      <AuthCard title="Sign in to PromptConnext" subtitle="Local dev (stub auth) — any user id works, no password.">
        <form onSubmit={handleStubSubmit} className="flex flex-col gap-4">
          <Field
            label="User id"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="user id"
          />
          <SubmitButton>Continue</SubmitButton>
        </form>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Sign in to PromptConnext">
      <form onSubmit={handleSupabaseSubmit} className="flex flex-col gap-4">
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
        />
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          required
        />
        <FormError message={error} />
        <SubmitButton pending={pending}>Sign in</SubmitButton>
      </form>
      <AuthLinks>
        <span>
          No account? <AuthLink href={withQuery("/register")}>Create one</AuthLink>
        </span>
        <span>
          <AuthLink href={withQuery("/forgot-password")}>Forgot your password?</AuthLink>
        </span>
      </AuthLinks>
    </AuthCard>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
