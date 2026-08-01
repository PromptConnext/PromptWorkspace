"use client";

import { useState } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCloudGet } from "@/lib/hooks";
import type { GithubConnection } from "@/lib/types";

// Workspace-level GitHub credential (apps/cloud/app/api/github.py).
//
// Replaces the old "GitHub App installation" form, which asked for an
// installation ID nobody could produce by hand and a single repo name — wrong
// at workspace scope, since the cloud creates one repo per project at
// tech-review exit (ADR 0017).

const EXPIRY_WARN_DAYS = 30;

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

function ExpiryNote({ expiresAt }: { expiresAt: string | null }) {
  if (!expiresAt) {
    return (
      <p className="text-xs text-slate-500">
        This token has no expiry date. Consider setting one and rotating it periodically.
      </p>
    );
  }
  const days = daysUntil(expiresAt);
  const date = new Date(expiresAt).toLocaleDateString();
  if (days < 0) {
    return (
      <p className="text-xs font-medium text-red-600">
        Token expired on {date}. Repository creation and indexing will fail until it is replaced.
      </p>
    );
  }
  if (days <= EXPIRY_WARN_DAYS) {
    return (
      <p className="text-xs font-medium text-amber-700">
        Token expires on {date} — {days} day{days === 1 ? "" : "s"} left. Replace it before then to
        avoid interruption.
      </p>
    );
  }
  return <p className="text-xs text-slate-500">Token expires on {date}.</p>;
}

export function GithubConnectionForm({ workspaceId }: { workspaceId: string }) {
  const { authHeaders } = useAuth();
  const { data: connection, refetch } = useCloudGet<GithubConnection>(
    `/workspaces/${workspaceId}/integrations/github`,
  );
  const [owner, setOwner] = useState("");
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connected = connection?.connected ?? false;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await apiFetch<GithubConnection>(
        `/workspaces/${workspaceId}/integrations/github`,
        authHeaders(),
        { method: "PUT", body: JSON.stringify({ owner: owner.trim(), token: token.trim() }) },
      );
      setToken("");
      setOwner("");
      refetch();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setPending(false);
    }
  }

  async function handleDisconnect() {
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/workspaces/${workspaceId}/integrations/github`, authHeaders(), {
        method: "DELETE",
      });
      refetch();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="mb-10 rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="mb-1 text-sm font-medium text-slate-900">GitHub connection</h2>
      <p className="mb-4 text-xs text-slate-500">
        PromptConnext creates a repository for each project and commits its plan, specification
        and agent context. Provide a{" "}
        <a
          href="https://github.com/settings/personal-access-tokens"
          target="_blank"
          rel="noreferrer"
          className="underline hover:text-slate-900"
        >
          fine-grained personal access token
        </a>{" "}
        with <strong>Contents</strong>, <strong>Administration</strong> and{" "}
        <strong>Webhooks</strong> write access for the organisation below. Set its repository access
        to <strong>All repositories</strong> — each project gets a repository created after the
        token is issued, and a token scoped to selected repositories cannot write to those.
      </p>

      {connected && (
        <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <p className="text-sm text-slate-900">
            Connected to <span className="font-medium">{connection?.owner}</span>
            {connection?.account_login ? (
              <span className="text-slate-500"> as @{connection.account_login}</span>
            ) : null}
          </p>
          <div className="mt-1">
            <ExpiryNote expiresAt={connection?.token_expires_at ?? null} />
          </div>
          <button
            type="button"
            onClick={handleDisconnect}
            disabled={pending}
            className="mt-3 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-60"
          >
            Disconnect
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-1 min-w-[10rem] flex-col gap-1 text-sm">
          <span className="text-slate-500">Organisation or account</span>
          <input
            type="text"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            placeholder="my-org"
            className="rounded-lg border border-slate-300 px-3 py-2 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
            required
          />
        </label>
        <label className="flex flex-1 min-w-[14rem] flex-col gap-1 text-sm">
          <span className="text-slate-500">Personal access token</span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="github_pat_…"
            autoComplete="off"
            className="rounded-lg border border-slate-300 px-3 py-2 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
            required
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700 disabled:opacity-60"
        >
          {pending ? "Verifying…" : connected ? "Replace token" : "Connect"}
        </button>
      </form>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </section>
  );
}

// The cloud verifies the token against GitHub before storing it, so these are
// the failures a user can actually act on — worth naming rather than showing
// a raw error code.
function messageFor(err: unknown): string {
  const detail = err instanceof ApiError ? err.message : "";
  if (detail.includes("github_token_rejected")) {
    return "GitHub rejected that token. Check it was copied in full and has not expired.";
  }
  if (detail.includes("github_owner_not_accessible")) {
    return "That token cannot access this organisation. Check the token's resource owner and that it grants repository access.";
  }
  if (detail.includes("github_unreachable")) {
    return "Could not reach GitHub just now. Try again in a moment.";
  }
  return detail || "Failed to save the GitHub connection.";
}
