"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createLineLinkCode,
  disconnectLine,
  getLineStatus,
  sendLineTest,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { LineLinkCode, ProjectLineStatus } from "@/lib/types";

const POLL_MS = 5_000;

const ERROR_COPY: Record<string, string> = {
  line_send_failed: "Could not send the test message. Try again.",
  line_not_connected: "Connect a LINE group first.",
  line_not_configured: "LINE notifications are not set up on this server.",
  admin_required: "Only workspace admins can change this.",
};

const UNKNOWN_ERROR = "Something went wrong. Try again.";

/** Known codes get their copy; any other server code is not shown raw. */
function errorCopy(e: unknown, fallback: string): string {
  const message = e instanceof Error ? e.message : "";
  if (!message) return fallback;
  return ERROR_COPY[message] ?? UNKNOWN_ERROR;
}

/** LINE's add-friend link for a bot's basic id ("@abc" → ".../%40abc"). */
function botLink(basicId: string): string {
  return `https://line.me/R/ti/p/%40${encodeURIComponent(basicId.replace(/^@/, ""))}`;
}

const BUTTON =
  "rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50";

/** Connects a project to a LINE group (plan 0032). Everyone sees the status;
 * only workspace admins get the actions. */
export function LineNotificationsPanel({
  projectId,
  isAdmin,
}: {
  projectId: string;
  isAdmin: boolean;
}) {
  const { authHeaders } = useAuth();
  const headersRef = useRef(authHeaders);
  headersRef.current = authHeaders;

  const [status, setStatus] = useState<ProjectLineStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState<LineLinkCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [testSent, setTestSent] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await getLineStatus(projectId, headersRef.current());
      if (!mounted.current) return;
      setStatus(next);
      setLoadError(null);
      if (next.connected) setCode(null);
    } catch (e) {
      if (mounted.current) setLoadError(errorCopy(e, "Could not load LINE status."));
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while a code is shown. The interval is torn down when the code is
  // cleared (connected, cancelled, expired) and on unmount.
  const expiresAt = code?.expires_at ?? null;
  useEffect(() => {
    if (!expiresAt) return;
    const expiry = new Date(expiresAt).getTime();
    const id = setInterval(() => {
      if (Date.now() >= expiry) {
        setCode(null);
        return;
      }
      void refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [expiresAt, refresh]);

  async function run(action: () => Promise<void>, fallback: string) {
    setActionError(null);
    setTestSent(false);
    setBusy(true);
    try {
      await action();
    } catch (e) {
      if (mounted.current) setActionError(errorCopy(e, fallback));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const connect = () =>
    run(async () => {
      setCode(await createLineLinkCode(projectId, headersRef.current()));
    }, "Could not create a link code.");

  const disconnect = () =>
    run(async () => {
      await disconnectLine(projectId, headersRef.current());
      await refresh();
    }, "Could not disconnect.");

  const test = () =>
    run(async () => {
      await sendLineTest(projectId, headersRef.current());
      if (mounted.current) setTestSent(true);
    }, "Could not send the test message. Try again.");

  let body: React.ReactNode = null;
  if (status && !status.configured) {
    body = (
      <p className="text-sm text-slate-600">LINE notifications are not set up on this server.</p>
    );
  } else if (status?.connected) {
    const since = status.linked_at
      ? ` since ${new Date(status.linked_at).toLocaleDateString()}`
      : "";
    body = (
      <>
        <p className="text-sm text-slate-700">
          Connected to {status.group_name || "a LINE group"}
          {since}.
        </p>
        {isAdmin && (
          <div className="mt-3 flex gap-2">
            <button type="button" className={BUTTON} disabled={busy} onClick={test}>
              Send test message
            </button>
            <button type="button" className={BUTTON} disabled={busy} onClick={disconnect}>
              Disconnect
            </button>
          </div>
        )}
        {testSent && <p className="mt-2 text-sm text-emerald-700">Test message sent.</p>}
      </>
    );
  } else if (status && code && isAdmin) {
    body = (
      <>
        <p className="text-sm text-slate-700">
          1. Add the PromptWorkspace bot to your LINE group
          {code.bot_basic_id && (
            <>
              {" ("}
              <a
                href={botLink(code.bot_basic_id)}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                {code.bot_basic_id}
              </a>
              )
            </>
          )}
          .
        </p>
        <p className="mt-1 text-sm text-slate-700">
          2. Type this in the group:{" "}
          <code className="rounded bg-slate-100 px-1.5 py-0.5">link {code.code}</code>
        </p>
        <p className="mt-1 text-xs text-slate-500">
          The code expires at {new Date(code.expires_at).toLocaleTimeString()}.
        </p>
        <div className="mt-3 flex gap-2">
          <button type="button" className={BUTTON} disabled={busy} onClick={() => void refresh()}>
            Check connection
          </button>
          <button type="button" className={BUTTON} onClick={() => setCode(null)}>
            Cancel
          </button>
        </div>
      </>
    );
  } else if (status) {
    body = isAdmin ? (
      <>
        <p className="text-sm text-slate-600">
          Send this project&apos;s decisions, ready-to-verify tasks and discussion comments to your
          team&apos;s LINE group.
        </p>
        <button type="button" className={`${BUTTON} mt-3`} disabled={busy} onClick={connect}>
          Connect LINE group
        </button>
      </>
    ) : (
      <p className="text-sm text-slate-600">Not connected to a LINE group.</p>
    );
  }

  return (
    <section className="mb-8 rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">LINE notifications</h2>
      {loadError && (
        <p role="alert" className="text-sm text-rose-700">
          {loadError}
        </p>
      )}
      {!loadError && !status && <p className="text-sm text-slate-500">Loading…</p>}
      {body}
      {actionError && (
        <p role="alert" className="mt-2 text-sm text-rose-700">
          {actionError}
        </p>
      )}
    </section>
  );
}
