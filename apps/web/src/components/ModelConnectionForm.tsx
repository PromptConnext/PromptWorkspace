"use client";

import { useState } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCloudGet } from "@/lib/hooks";
import type { ModelConnectionStatus } from "@/lib/types";

// Workspace-level assistant model (apps/cloud/app/api/assistant.py).
//
// The assistant needs two things from one connection: a chat model to answer
// with, and an embedding model to ground the answer in this workspace's
// artifacts (ADR 0011). The cloud health-checks the key by embedding a probe
// string before storing anything, so a rejected key never reaches the database
// and the failures worth naming below are the ones a user can act on.

const DEFAULTS = {
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  embedModel: "text-embedding-3-small",
  embedDim: "1536",
  dailyTokenBudget: "200000",
};

// The assistant resolves BYO first, then the deployment's managed tier. Only
// "none" is a dead end — and it is worth stating plainly, because an
// unconfigured workspace looks identical to a working one until someone asks
// a question and gets nothing.
function StatusNote({ status }: { status: ModelConnectionStatus }) {
  if (status.chat_source === "none") {
    return (
      <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3">
        <p className="text-sm font-medium text-red-700">No model connected</p>
        <p className="mt-1 text-xs text-red-600">
          The assistant cannot answer questions about this workspace until a model is connected
          below. There is no fallback model on this deployment — chat will fail, and nothing new is
          being indexed for search.
        </p>
      </div>
    );
  }

  if (status.chat_source === "managed") {
    return (
      <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
        <p className="text-sm text-slate-900">Using the platform model</p>
        <p className="mt-1 text-xs text-slate-500">
          {status.embed_source === "none"
            ? "The assistant can answer questions about task status and progress, but not about the content of your documents — that needs an embedding model. Connect one below to enable it."
            : "This workspace has no model of its own and is answering on the platform model. Connect your own below to use a different provider or your own budget."}
        </p>
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className="text-sm text-slate-900">
        Connected to <span className="font-medium">{status.connection?.model}</span>
        <span className="text-slate-500"> via {status.connection?.provider}</span>
      </p>
      <p className="mt-1 text-xs text-slate-500">
        Embedding with {status.connection?.embed_model} ({status.connection?.embed_dim} dimensions).
        Daily budget {status.connection?.daily_token_budget.toLocaleString()} tokens.
      </p>
    </div>
  );
}

export function ModelConnectionForm({ workspaceId }: { workspaceId: string }) {
  const { authHeaders } = useAuth();
  const { data: status, refetch } = useCloudGet<ModelConnectionStatus>(
    `/workspaces/${workspaceId}/model-connection`,
  );
  const [provider, setProvider] = useState(DEFAULTS.provider);
  const [baseUrl, setBaseUrl] = useState(DEFAULTS.baseUrl);
  const [model, setModel] = useState(DEFAULTS.model);
  const [embedModel, setEmbedModel] = useState(DEFAULTS.embedModel);
  const [embedDim, setEmbedDim] = useState(DEFAULTS.embedDim);
  const [dailyTokenBudget, setDailyTokenBudget] = useState(DEFAULTS.dailyTokenBudget);
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/workspaces/${workspaceId}/model-connection`, authHeaders(), {
        method: "POST",
        body: JSON.stringify({
          provider: provider.trim(),
          base_url: baseUrl.trim(),
          model: model.trim(),
          embed_model: embedModel.trim(),
          embed_dim: Number(embedDim),
          api_key: apiKey.trim(),
          daily_token_budget: Number(dailyTokenBudget),
        }),
      });
      setApiKey("");
      refetch();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="mb-10 rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="mb-1 text-sm font-medium text-slate-900">Assistant model</h2>
      <p className="mb-4 text-xs text-slate-500">
        The assistant answers questions about this workspace&apos;s projects, grounded in the
        documents and tasks you have synced. It needs a chat model to answer with and an embedding
        model to search with — both from one API key, which is verified before it is saved and
        stored encrypted.
      </p>

      {status && <StatusNote status={status} />}

      <form onSubmit={handleSubmit} className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-slate-500">Provider</span>
          <input
            type="text"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-slate-500">API base URL</span>
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            className="rounded-lg border border-slate-300 px-3 py-2 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-slate-500">Chat model</span>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-slate-500">Embedding model</span>
          <input
            type="text"
            value={embedModel}
            onChange={(e) => setEmbedModel(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-slate-500">Embedding dimensions</span>
          <input
            type="number"
            value={embedDim}
            onChange={(e) => setEmbedDim(e.target.value)}
            min={1}
            className="rounded-lg border border-slate-300 px-3 py-2 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-slate-500">Daily token budget</span>
          <input
            type="number"
            value={dailyTokenBudget}
            onChange={(e) => setDailyTokenBudget(e.target.value)}
            min={1}
            className="rounded-lg border border-slate-300 px-3 py-2 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          <span className="text-slate-500">API key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-…"
            autoComplete="off"
            className="rounded-lg border border-slate-300 px-3 py-2 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
            required
          />
        </label>
        <div className="sm:col-span-2">
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700 disabled:opacity-60"
          >
            {pending ? "Verifying…" : status?.configured ? "Replace connection" : "Connect"}
          </button>
        </div>
      </form>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {status?.configured && (
        <p className="mt-3 text-xs text-slate-500">
          Changing the embedding model or its dimensions means existing search indexes no longer
          match — reindex each project afterwards so content questions keep working.
        </p>
      )}
    </section>
  );
}

// The cloud validates the URL and live-tests the key before storing anything,
// so these are the failures a user can actually act on.
function messageFor(err: unknown): string {
  const detail = err instanceof ApiError ? err.message : "";
  if (detail.includes("base_url_must_be_https")) {
    return "The API base URL must start with https://.";
  }
  if (detail.includes("model_connection_health_check_failed")) {
    return "That key and model could not be used to generate an embedding. Check the key, the base URL, and that the embedding model name is exactly right.";
  }
  if (detail.includes("RAG_KEY_ENCRYPTION_KEY")) {
    return "This deployment cannot store model keys yet — RAG_KEY_ENCRYPTION_KEY is not configured on the server.";
  }
  return detail || "Failed to save the model connection.";
}
