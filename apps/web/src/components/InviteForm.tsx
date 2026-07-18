"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { InvitationCreateResponse, Role } from "@/lib/types";

export function InviteForm({
  workspaceId,
  onInvited,
}: {
  workspaceId: string;
  onInvited: () => void;
}) {
  const { authHeaders } = useAuth();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualLink, setManualLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setManualLink(null);
    setCopied(false);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Enter a valid email address.");
      return;
    }
    setPending(true);
    try {
      const res = await apiFetch<InvitationCreateResponse>(
        `/workspaces/${workspaceId}/invitations`,
        authHeaders(),
        { method: "POST", body: JSON.stringify({ email, role }) },
      );
      setEmail("");
      if (!res.email_sent) {
        setManualLink(res.accept_url);
      }
      onInvited();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  async function copyLink() {
    if (!manualLink) return;
    await navigator.clipboard.writeText(manualLink);
    setCopied(true);
  }

  return (
    <section className="mb-10">
      <h2 className="mb-3 text-sm font-medium text-slate-500">Invite someone</h2>
      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-slate-700">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="person@example.com"
            className="rounded border border-slate-300 px-3 py-2"
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-slate-700">Role</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="rounded border border-slate-300 px-3 py-2"
          >
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-60"
        >
          {pending ? "Sending…" : "Send invite"}
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {manualLink && (
        <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
          <p className="text-amber-800">
            Couldn&apos;t email this address automatically (they may already have an account).
            Share this invite link with them:
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded bg-white px-2 py-1 text-xs">
              {manualLink}
            </code>
            <button
              type="button"
              onClick={copyLink}
              className="rounded border border-slate-300 px-2 py-1 text-xs"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
