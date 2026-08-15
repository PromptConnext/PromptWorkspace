"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AUTH_MODE } from "@/lib/config";
import { useAuth } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { safeNext } from "@/lib/next-path";
import { AuthCard, AuthLink, AuthLinks, Field, FormError, SubmitButton } from "@/components/auth/ui";

// Re-exported for the existing page-level test; the implementation lives in
// lib/ so the register page can share it without importing a route module.
export { safeNext };

// Deep-link schemes a client may ask us to hand the session back to:
// `promptconnext` is the shipping Tauri shell, `promptconnext-theia` the
// in-development Electron one, and the rest are the VS Code family the
// extension in apps/vscode runs inside (ADR 0019) — every fork registers its
// own scheme, so `env.uriScheme` differs per editor and cannot be hardcoded.
//
// The allow-list is a security control, not tidiness: the URL below carries a
// one-time code that redeems a real session, and the query string is
// attacker-controllable, so an arbitrary scheme would hand that code to any
// locally-installed app willing to register for it.
//
// Widening it to the editor schemes has a real, accepted cost: OS URL-scheme
// registration is unauthenticated and last-writer-wins on every platform, so
// any local app claiming `vscode://` can receive the code. What bounds it is
// that the code is single-use with a 120s TTL (app/desktop_auth_store.py) and
// that `state` never leaves the client's machine except in the outbound URL —
// a thief who takes the code without the state cannot complete *our* sign-in,
// and the user sees a failed login rather than a silent one. What it does not
// bound is an app that hijacks the scheme and wins the race; that risk already
// existed for `promptconnext://` and this enlarges the colliding set.
const DESKTOP_SCHEMES: string[] = [
  "promptconnext",
  "promptconnext-theia",
  "vscode",
  "vscode-insiders",
  "vscode-exploration",
  "vscodium",
  "codium",
  "cursor",
  "windsurf",
];

export function desktopScheme(raw: string | null): string {
  return raw && DESKTOP_SCHEMES.includes(raw) ? raw : "promptconnext";
}

// Where to send the one-time code.
//
// The two desktop shells accept the authority-less `scheme://auth/callback`
// this has always built. A VS Code extension cannot: `registerUriHandler` only
// receives URIs whose authority is the extension id
// (`vscode://publisher.name/path`), and the scheme varies per editor. So a
// client may instead send its own fully-resolved callback as `redirect_uri`
// (built with `env.asExternalUri`), and we validate it rather than construct it.
//
// microsoft/vscode#141640: `handleUri` drops the URI *fragment*, so `code` and
// `state` must stay in the query string. They already do — do not "tidy" them
// into a hash.
export function desktopRedirect(
  rawRedirectUri: string | null,
  rawScheme: string | null,
  code: string,
  state: string,
): string {
  const fallback =
    `${desktopScheme(rawScheme)}://auth/callback?code=${encodeURIComponent(code)}` +
    `&state=${encodeURIComponent(state)}`;
  if (!rawRedirectUri) return fallback;

  let target: URL;
  try {
    target = new URL(rawRedirectUri);
  } catch {
    return fallback;
  }
  // `https:` is refused outright even though asExternalUri can legitimately
  // return an https tunnel under Remote/Codespaces: allowing arbitrary https
  // here is an open redirect that leaks a live session code to any origin.
  // Remote hosts use the paste-the-code fallback below instead. If that ever
  // needs to change, add an exact-host allow-list — never a bare `https:`.
  if (!DESKTOP_SCHEMES.includes(target.protocol.replace(/:$/, ""))) return fallback;
  // A callback that already carries these is trying to pin them past us.
  if (target.hash || target.searchParams.has("code") || target.searchParams.has("state")) {
    return fallback;
  }
  target.searchParams.set("code", code);
  target.searchParams.set("state", state);
  return target.toString();
}

function LoginForm() {
  const { user, signInStub, signInSupabase, signOut, getSessionTokens } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const desktop = params.get("desktop") === "1";
  const desktopState = params.get("state");
  const rawScheme = params.get("scheme");
  const rawRedirectUri = params.get("redirect_uri");

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
  // A desktop/editor handoff mints a code that redeems a *real* session into a
  // native app, so a session this browser happens to be carrying is not consent
  // to grant one. Without this gate the flow is invisible: a user who signs in
  // from the editor is handed straight back as whoever the browser was already
  // logged in as, with no form shown and no way to pick a different account.
  const [approved, setApproved] = useState(false);
  const handoff = desktop && Boolean(desktopState);

  useEffect(() => {
    if (!user) return;
    if (desktop && desktopState) {
      if (!approved) return;
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
          window.location.href = desktopRedirect(
            rawRedirectUri,
            rawScheme,
            code,
            desktopState,
          );
        } catch (err) {
          setHandoffError(err instanceof Error ? err.message : "Failed to hand off to the desktop app.");
        }
      })();
      return;
    }
    router.replace(next);
  }, [
    user,
    approved,
    desktop,
    desktopState,
    rawScheme,
    rawRedirectUri,
    getSessionTokens,
    next,
    router,
  ]);

  if (user && handoff && !approved) {
    return (
      <AuthCard
        title="Continue to the app"
        subtitle="This browser already has a PromptConnext session."
      >
        <p className="text-sm text-slate-600">
          Signing in will hand <strong>{user.email || user.id}</strong> to the app that opened
          this page. Not the account you want? Sign out here and enter your email and password
          instead.
        </p>
        <div className="mt-6 flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setApproved(true)}
            className="rounded-lg bg-indigo-600 px-3 py-2 font-medium text-white transition hover:bg-indigo-500"
          >
            Continue as {user.email || user.id}
          </button>
          <button
            type="button"
            onClick={() => {
              void signOut();
            }}
            className="rounded-lg border border-slate-300 px-3 py-2 font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Use a different account
          </button>
        </div>
      </AuthCard>
    );
  }

  if (user && desktop && desktopState) {
    return (
      <AuthCard title="Signed in">
        {handoffError ? (
          <FormError message={handoffError} />
        ) : handoffCode ? (
          <>
            <p className="text-sm text-slate-600">
              Redirecting you back to the app… If nothing happens in a few seconds (common in
              development builds, and on Linux where the URL scheme is often unregistered),
              copy this code and paste it into the app&apos;s sign-in screen instead:
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

  // Signing in here *is* the approval, so the confirm screen is skipped and the
  // effect above runs the handoff. Navigating to `next` instead would race it:
  // the route change unmounts this component mid-request.
  async function handleStubSubmit(e: React.FormEvent) {
    e.preventDefault();
    signInStub(userId.trim() || "dev-user");
    if (handoff) {
      setApproved(true);
      return;
    }
    router.replace(next);
  }

  async function handleSupabaseSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await signInSupabase(email, password);
      if (handoff) {
        setApproved(true);
        return;
      }
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
