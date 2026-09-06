// apps/web/src/components/project/PreviewPanel.tsx
//
// The business user's view of the running application (ADR 0021).
//
// Deliberately not role-gated: finding the live application without a
// development environment is the reason this feature exists.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getDeploymentStatus } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { DeploymentStatus } from "@/lib/types";
import { useIsWorkspaceAdmin } from "@/lib/workspace";
import { BuildHistory } from "./BuildHistory";
import {
  buildVersions,
  isPreviewReadyMessage,
  relativeTime,
  resolvePreview,
  shortSha,
} from "./previewState";

const POLL_MS = 3000;
// Bounds "stuck", not "slow" — the effect below resets this whenever the
// pending count actually moves, so a deploy that is genuinely progressing
// keeps buying time. Without it, a deploy whose webhook delivery never
// arrives would leave every open tab polling until it closes.
const MAX_POLLS_WITHOUT_PROGRESS = 300; // ~15 minutes at POLL_MS
// How long to wait for the embedded page to announce itself before falling
// back to the link card. Generous enough for a cold static host; short
// enough that a blocked frame does not look like a hang.
const HANDSHAKE_MS = 4000;

function Spinner({ label }: { label: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      className="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600"
    />
  );
}

function LinkCard({
  url,
  status,
  reason,
  isAdmin,
}: {
  url: string;
  status: DeploymentStatus;
  reason: string | null;
  isAdmin: boolean;
}) {
  const sha = shortSha(status.last_deploy?.commit_sha);
  const at = status.last_deploy?.created_at;
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <p className="text-sm font-medium text-slate-900">The live application is ready.</p>
      {reason && <p className="mt-1 text-xs text-slate-500">{reason}</p>}
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
      >
        Open in a new tab
      </a>
      <p className="mt-3 break-all text-xs text-slate-500">{url}</p>
      {at && <p className="mt-1 text-xs text-slate-500">Published {relativeTime(at)}</p>}
      {/* ADR 0023 decision 6: a commit and a run link are a Tech Lead's tools,
          not a business user's. The moment a member has to understand a merge
          to read the preview, the feature has failed its stated purpose. */}
      {isAdmin && sha && (
        <p className="mt-1 text-xs text-slate-500">
          Built from commit <code>{sha}</code>
          {status.last_deploy?.run_url && (
            <>
              {" · "}
              <a
                href={status.last_deploy.run_url}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                build log
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );
}

export function PreviewPanel({
  projectId,
  workspaceId,
}: {
  projectId: string;
  workspaceId: string;
}) {
  const isAdmin = useIsWorkspaceAdmin(workspaceId);
  const { authHeaders } = useAuth();
  const [status, setStatus] = useState<DeploymentStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [handshake, setHandshake] = useState<"pending" | "confirmed" | "timed-out">("pending");
  const pollsLeft = useRef(MAX_POLLS_WITHOUT_PROGRESS);
  const [exhausted, setExhausted] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getDeploymentStatus(projectId, authHeaders()));
    } catch {
      // Leave the last-known status in place: a transient failure should not
      // blank a preview the user is looking at.
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pending = status?.pending ?? 0;

  // Poll only while the server says something is in flight, and stop the
  // moment it is not. Re-running on every change of `pending` is what
  // refreshes the stuck-budget — real progress buys more time, a frozen
  // count does not. Same shape as ReindexPanel's loop, and for the same
  // reason: every number shown comes from the server. There is no progress
  // bar here, because a deploy's duration is not something we know.
  useEffect(() => {
    if (pending <= 0) return;
    pollsLeft.current = MAX_POLLS_WITHOUT_PROGRESS;
    setExhausted(false);
    const id = setInterval(() => {
      if (pollsLeft.current <= 0) {
        clearInterval(id);
        setExhausted(true);
        return;
      }
      pollsLeft.current -= 1;
      void refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [pending, refresh]);

  const view = resolvePreview(status, handshake);
  const url = view.url;

  // The only positive proof an embed worked. See previewState.ts for why
  // nothing else in the browser can answer this.
  useEffect(() => {
    if (view.mode !== "embed" || !url) return;
    setHandshake("pending");
    function onMessage(event: MessageEvent) {
      if (url && isPreviewReadyMessage(event.data, event.origin, url)) {
        setHandshake("confirmed");
      }
    }
    window.addEventListener("message", onMessage);
    const timer = setTimeout(
      () => setHandshake((h) => (h === "pending" ? "timed-out" : h)),
      HANDSHAKE_MS,
    );
    return () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
    };
    // Re-arms when the deployed URL changes, not on every status poll.
  }, [view.mode, url]);

  if (loading) {
    return <p className="text-sm text-slate-500">Loading preview…</p>;
  }

  if (view.mode === "empty") {
    return (
      <section className="rounded-lg border border-slate-200 p-4">
        <h3 className="text-sm font-medium text-slate-900">No live preview yet</h3>
        <p className="mt-1 text-xs text-slate-500">
          This project has no deployment template, so nothing is being built or deployed. A Tech
          Lead can choose one in the Planner before the repository is created.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {view.polling && <Spinner label="Deploy in progress" />}
          <h3 className="text-sm font-medium text-slate-900">
            {view.mode === "failed"
              ? "The latest deploy failed"
              : view.mode === "waiting"
                ? "Waiting for the first deploy"
                : view.mode === "building"
                  ? "Building the preview"
                  : "Live preview"}
          </h3>
        </div>
        {status?.template_name && (
          <p className="text-xs text-slate-500">{status.template_name}</p>
        )}
      </header>

      {view.mode === "failed" && status?.last_error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3">
          <p className="text-sm text-red-700">{status.last_error.message}</p>
          {isAdmin && status.last_error.run_url && (
            <a
              href={status.last_error.run_url}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block text-xs text-red-700 underline"
            >
              Open the build log
            </a>
          )}
          {url && (
            <p className="mt-2 text-xs text-red-700">
              The previous version is still available below.
            </p>
          )}
        </div>
      )}

      {(view.mode === "waiting" || view.mode === "building") && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm text-slate-700">
            {view.mode === "waiting"
              ? "The repository has been created. The first deploy starts on its own and usually takes a couple of minutes."
              : "A new version is being built and published."}
          </p>
          {exhausted && (
            <p className="mt-2 text-xs text-slate-500">
              Still building — last checked just now. If this looks stuck, the build log has the
              detail.
            </p>
          )}
          {isAdmin && status?.last_deploy?.run_url && (
            <a
              href={status.last_deploy.run_url}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block text-xs text-slate-600 underline"
            >
              Open the build log
            </a>
          )}
        </div>
      )}

      {url && view.mode === "embed" && (
        <>
          <iframe
            src={url}
            title="Live preview of the deployed application"
            className="h-[70vh] w-full rounded-lg border border-slate-200 bg-white"
            // allow-scripts + allow-same-origin together let a frame drop its
            // own sandbox. Acceptable here and nowhere else: this is a
            // first-party application the workspace itself deployed, not
            // untrusted content. allow-top-navigation is deliberately absent —
            // a preview must never be able to navigate the workspace away.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            referrerPolicy="no-referrer"
            loading="lazy"
          />
          <p className="text-xs text-slate-500">
            <a href={url} target="_blank" rel="noreferrer" className="underline">
              Open in a new tab
            </a>
            {" · "}
            <span className="break-all">{url}</span>
          </p>
        </>
      )}

      {url && (view.mode === "link" || view.mode === "failed") && status && (
        <LinkCard url={url} status={status} reason={view.fallbackReason} isAdmin={isAdmin} />
      )}

      <BuildHistory versions={buildVersions(status)} isAdmin={isAdmin} />
    </section>
  );
}
