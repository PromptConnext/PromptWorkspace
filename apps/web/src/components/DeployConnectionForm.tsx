"use client";

import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCloudGet } from "@/lib/hooks";
import type { DeployConnection } from "@/lib/types";

// Workspace-level deployment-provider credential (ADR 0021/0023,
// apps/cloud/app/api/deployments.py).
//
// Deliberately generic: every input below is rendered from the `fields` the
// server returns for the provider, so adding a provider stays "one PROVIDERS
// entry" and never reaches this file. That is the same seam SecretSpec/VarSpec
// give the templates — the provider decides what it needs, nothing here knows
// what Vercel or a Docker host are.

export function DeployConnectionForm({
  workspaceId,
  providerId,
  providerLabel,
}: {
  workspaceId: string;
  providerId: string;
  providerLabel: string;
}) {
  const { authHeaders } = useAuth();
  const path = `/workspaces/${workspaceId}/integrations/deploy/${providerId}`;
  const { data: connection, refetch } = useCloudGet<DeployConnection>(path);
  const [values, setValues] = useState<Record<string, string>>({});
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connected = connection?.connected ?? false;
  const fields = connection?.fields ?? [];

  // The server echoes back the non-secret identifiers already stored, so a
  // reconnect (rotating a token) does not make the admin retype the app name
  // or project id they set months ago.
  useEffect(() => {
    if (connection) setValues(connection.values ?? {});
  }, [connection]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await apiFetch<DeployConnection>(path, authHeaders(), {
        method: "PUT",
        body: JSON.stringify({
          token: token.trim(),
          values: Object.fromEntries(
            Object.entries(values).map(([k, v]) => [k, v.trim()]),
          ),
        }),
      });
      setToken("");
      refetch();
    } catch (err) {
      setError(messageFor(err, providerLabel));
    } finally {
      setPending(false);
    }
  }

  async function handleDisconnect() {
    setError(null);
    setPending(true);
    try {
      await apiFetch(path, authHeaders(), { method: "DELETE" });
      setToken("");
      refetch();
    } catch (err) {
      setError(messageFor(err, providerLabel));
    } finally {
      setPending(false);
    }
  }

  return (
    // Named region rather than a bare div: with several providers on the page
    // every input label ("Deploy token") repeats, so the provider name is what
    // tells a screen reader — and anyone else — which credential is being typed.
    <section
      aria-labelledby={`deploy-provider-${providerId}`}
      className="rounded-lg border border-slate-200 p-4"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3
          id={`deploy-provider-${providerId}`}
          className="text-sm font-medium text-slate-900"
        >
          {providerLabel}
        </h3>
        <span
          className={
            connected
              ? "rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700"
              : "rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500"
          }
        >
          {connected ? "Connected" : "Not connected"}
        </span>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
        {fields.map((field) => (
          <label
            key={field.name}
            className="flex min-w-[10rem] flex-1 flex-col gap-1 text-sm"
          >
            <span className="text-slate-500">{field.label}</span>
            <input
              type={field.secret ? "password" : "text"}
              value={values[field.name] ?? ""}
              onChange={(e) =>
                setValues((prev) => ({ ...prev, [field.name]: e.target.value }))
              }
              autoComplete="off"
              className="rounded-lg border border-slate-300 px-3 py-2 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
              required
            />
          </label>
        ))}
        <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-sm">
          <span className="text-slate-500">{connection?.token_label ?? "Deploy token"}</span>
          {/* A textarea when the provider says its secret spans lines: an SSH
              private key pasted into a single-line input loses its newlines,
              and the failure then surfaces on a deploy rather than here. */}
          {connection?.token_multiline ? (
            <textarea
              value={token}
              onChange={(e) => setToken(e.target.value)}
              rows={4}
              spellCheck={false}
              autoComplete="off"
              className="rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
              required
            />
          ) : (
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              className="rounded-lg border border-slate-300 px-3 py-2 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
              required
            />
          )}
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60"
        >
          {/* Just "Replace" once connected: the field above already names the
              secret, and casing a provider-supplied label into a sentence
              reads badly for both "Deploy token" and "SSH private key". */}
          {pending ? "Verifying…" : connected ? "Replace" : "Connect"}
        </button>
        {connected && (
          <button
            type="button"
            onClick={handleDisconnect}
            disabled={pending}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-60"
          >
            Disconnect
          </button>
        )}
      </form>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </section>
  );
}

// The cloud verifies the credential against the provider before storing it, so
// these are the failures an admin can actually act on. `deploy_project_not_found`
// is the one worth spelling out: nothing in a pipeline creates the provider's
// project, and a valid token pointed at a project that does not exist looks
// identical to a bad token unless we say otherwise.
function messageFor(err: unknown, providerLabel: string): string {
  const detail = err instanceof ApiError ? err.message : "";
  if (detail.includes("deploy_token_rejected")) {
    return `${providerLabel} rejected that token. Check it was copied in full and has not expired.`;
  }
  if (detail.includes("deploy_project_not_found")) {
    return `That token works, but ${providerLabel} has no project with the id above. Create the project in ${providerLabel} first, then connect it here.`;
  }
  if (detail.includes("deployment_provider_unreachable")) {
    return `Could not reach ${providerLabel} just now. Try again in a moment.`;
  }
  // The Docker host's two shape checks. Both are mistakes made while pasting,
  // and both would otherwise surface as a failed deploy days later.
  if (detail.includes("deploy_host_key_invalid")) {
    return "That does not look like a host key. Run `ssh-keyscan <host>` and paste one line of its output.";
  }
  if (detail.includes("provider_fields_required")) {
    return "Fill in every field above before connecting.";
  }
  if (detail.includes("provider_is_platform_owned")) {
    return `${providerLabel} is managed by PromptConnext — there is nothing to connect.`;
  }
  return detail || `Failed to save the ${providerLabel} connection.`;
}
