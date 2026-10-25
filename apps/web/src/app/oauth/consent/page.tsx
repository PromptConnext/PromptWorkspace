"use client";

// The browser half of hosted MCP OAuth (docs/superpowers/specs/
// 2026-10-24-hosted-mcp-oauth-design.md, "The flow the user sees"). The cloud's
// /oauth/authorize redirects here with an opaque request id; this page shows
// who is asking and records the user's answer with their Supabase bearer.
//
// Everything the client declared about itself (name, logo, homepage) is
// untrusted: it is rendered as text, and URLs only when they are https. The
// first line is the one an attacker would want to forge, so it is driven by
// the server's `loopback` / `verified` verdict, never by `client_name`.
// next.config.ts forbids framing this route.

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { ApiError, approveConsent, denyConsent, getConsent } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { ConsentView } from "@/lib/types";

const EXPIRED = "This request has expired. Start the connection again from your agent.";
const ANSWERED = "This request was already answered.";
const SCOPES_SENTENCE =
  "It can read and update your tasks and planning documents, and submit drafts for review, in these workspaces:";

function httpsOnly(url: string | null): string | null {
  return url && url.startsWith("https://") ? url : null;
}

// redirect_to is built by the cloud from a registered redirect URI, but it is
// handed straight to location.assign, where a script URL would run in our
// origin. Refuse those outright rather than trust the server never to emit one.
const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "vbscript:", "blob:", "file:"]);
function safeRedirect(target: string): boolean {
  try {
    return !BLOCKED_SCHEMES.has(new URL(target).protocol);
  } catch {
    return false;
  }
}

function messageFor(err: unknown): string {
  if (err instanceof ApiError && err.status === 404) return EXPIRED;
  if (err instanceof ApiError && err.status === 409) return ANSWERED;
  return err instanceof Error ? err.message : "Something went wrong.";
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="ml-2 inline-block rounded-full bg-emerald-100 px-2 py-0.5 align-middle text-xs font-medium text-emerald-800">
      {children}
    </span>
  );
}

function Headline({ view }: { view: ConsentView }) {
  if (view.loopback) {
    return (
      <h1 className="text-lg font-semibold text-slate-900">
        <span>An app on this computer wants to connect to PromptWorkspace.</span>
        <Chip>Verified: loopback</Chip>
      </h1>
    );
  }
  if (view.verified && view.vendor) {
    return (
      <h1 className="text-lg font-semibold text-slate-900">
        <span>{`${view.vendor} wants to connect to PromptWorkspace.`}</span>
        <Chip>Verified</Chip>
      </h1>
    );
  }
  return (
    <div>
      <h1 className="text-lg font-semibold text-amber-700">
        {`Unverified app — it will redirect to ${view.redirect_host}`}
      </h1>
      <p className="mt-1 text-sm text-slate-500">{view.client_name}</p>
    </div>
  );
}

function ConsentBody({ requestId }: { requestId: string }) {
  const { authHeaders } = useAuth();
  const [view, setView] = useState<ConsentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getConsent(requestId, authHeaders())
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch((err) => {
        if (!cancelled) setError(messageFor(err));
      });
    return () => {
      cancelled = true;
    };
    // authHeaders changes identity on every token refresh; the view does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId]);

  async function decide(action: typeof approveConsent) {
    setBusy(true);
    setError(null);
    try {
      const { redirect_to } = await action(requestId, authHeaders());
      if (!safeRedirect(redirect_to)) {
        setError("The app returned an address this page will not open.");
        setBusy(false);
        return;
      }
      window.location.assign(redirect_to);
    } catch (err) {
      setError(messageFor(err));
      setBusy(false);
    }
  }

  if (!view) {
    return error ? (
      <p role="alert" className="text-sm text-slate-700">
        {error}
      </p>
    ) : (
      <p className="text-sm text-slate-500">Loading…</p>
    );
  }

  const logo = httpsOnly(view.logo_uri);
  const homepage = httpsOnly(view.client_uri);
  const showName = view.loopback || (view.verified && view.vendor);

  return (
    <div className="space-y-5">
      <Headline view={view} />

      {(logo || homepage || showName) && (
        <div className="flex items-center gap-3">
          {logo && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logo}
              alt={`${view.client_name} logo`}
              width={40}
              height={40}
              referrerPolicy="no-referrer"
              className="h-10 w-10 rounded"
            />
          )}
          <div className="min-w-0 text-sm">
            {showName && <p className="font-medium text-slate-900">{view.client_name}</p>}
            {homepage && (
              <a
                href={homepage}
                rel="noopener noreferrer nofollow"
                target="_blank"
                className="break-all text-indigo-600 hover:underline"
              >
                {homepage}
              </a>
            )}
          </div>
        </div>
      )}

      <div className="text-sm text-slate-700">
        <p>{SCOPES_SENTENCE}</p>
        <ul className="mt-2 list-disc pl-5">
          {view.workspaces.map((w) => (
            <li key={w.id}>{w.name}</li>
          ))}
        </ul>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
        <span className="text-sm text-slate-500">{`Signed in as ${view.account_email}`}</span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide(denyConsent)}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            Deny
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide(approveConsent)}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}

function ConsentScreen() {
  const params = useSearchParams();
  const requestId = params.get("request");
  const next = `/oauth/consent?request=${encodeURIComponent(requestId ?? "")}`;

  return (
    <main className="mx-auto max-w-lg px-4 py-16">
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        {requestId ? (
          <RequireAuth next={next}>
            <ConsentBody requestId={requestId} />
          </RequireAuth>
        ) : (
          <p role="alert" className="text-sm text-slate-700">
            {EXPIRED}
          </p>
        )}
      </div>
    </main>
  );
}

export default function ConsentPage() {
  return (
    <Suspense fallback={null}>
      <ConsentScreen />
    </Suspense>
  );
}
