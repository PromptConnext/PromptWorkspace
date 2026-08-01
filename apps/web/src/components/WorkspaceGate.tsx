"use client";

// The `/` gate: resolves which workspace the session should enter.
// - pending invite -> show it first, so accepting always beats auto-entering
// - 0 memberships  -> empty state (get invited / create from desktop)
// - exactly 1      -> auto-enter it
// - remembered id  -> auto-resume it
// - many, none set -> picker
// Once an active workspace resolves, redirect into /w/{id}; the workspace pages
// own the actual content.
//
// The invite check runs *before* any auto-enter because a user who lands here
// instead of /invite/{token} (mangled link, or an auth provider that bounced
// them to the site root) would otherwise be swept into some other workspace
// with no way back to the invitation.

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { TopBar } from "@/components/TopBar";
import { ApiError, apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCloudGet } from "@/lib/hooks";
import { useWorkspace } from "@/lib/workspace";
import type { PendingInvitation, WorkspaceMember } from "@/lib/types";

export function WorkspaceGate() {
  const router = useRouter();
  const { authHeaders } = useAuth();
  const {
    memberships,
    activeWorkspace,
    loading,
    error,
    setActiveWorkspace,
    createWorkspace,
    refetch: refetchWorkspaces,
  } = useWorkspace();
  const {
    data: invitations,
    loading: invitesLoading,
    refetch: refetchInvites,
  } = useCloudGet<PendingInvitation[]>("/invitations/pending");
  const pendingInvites = invitations ?? [];
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [acceptingToken, setAcceptingToken] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  // Set by handleCreate so the redirect effect below can tell "just created by
  // this user" from "resolved on load" — the two want different destinations.
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);

  const handleAccept = async (token: string) => {
    setAcceptingToken(token);
    setAcceptError(null);
    try {
      const member = await apiFetch<WorkspaceMember>(
        `/invitations/${token}/accept`,
        authHeaders(),
        { method: "POST" },
      );
      setActiveWorkspace(member.workspace_id);
      refetchWorkspaces();
      router.replace(`/w/${member.workspace_id}`);
    } catch (err) {
      setAcceptError(err instanceof ApiError ? err.message : "Failed to accept invitation");
      refetchInvites();
    } finally {
      setAcceptingToken(null);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setCreateError(null);
    try {
      const workspace = await createWorkspace(name);
      setJustCreatedId(workspace.id);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Failed to create workspace");
    } finally {
      setCreating(false);
    }
  };

  // An outstanding invitation outranks every auto-resolve below: until it is
  // accepted or dismissed, this page stays put and shows it.
  const invitesBlocking = invitesLoading || pendingInvites.length > 0;

  // Auto-enter a single membership (no point showing a one-item picker).
  useEffect(() => {
    if (!loading && !invitesBlocking && !activeWorkspace && memberships.length === 1) {
      setActiveWorkspace(memberships[0].id);
    }
  }, [loading, invitesBlocking, activeWorkspace, memberships, setActiveWorkspace]);

  // Once resolved (remembered or just auto-entered), redirect into the workspace.
  //
  // A workspace the user just created is the exception: it goes to settings
  // instead. A brand-new workspace can't create project repositories until a
  // GitHub token is configured, and the moment right after naming it is the
  // one time the person is already thinking about setup — sending them to an
  // empty workspace home means discovering the requirement later, from a
  // failure. Both destinations resolve in this one effect rather than
  // handleCreate navigating separately, because `createWorkspace` sets the
  // active workspace itself: a second navigation would race this one.
  useEffect(() => {
    if (!activeWorkspace || invitesBlocking) return;
    router.replace(
      activeWorkspace.id === justCreatedId
        ? `/w/${activeWorkspace.id}/settings`
        : `/w/${activeWorkspace.id}`,
    );
  }, [activeWorkspace, invitesBlocking, justCreatedId, router]);

  if (loading || invitesLoading) {
    return <div className="p-6 text-sm text-slate-500">Loading…</div>;
  }
  if (error) {
    return <div className="p-6 text-sm text-red-600">{error}</div>;
  }

  if (pendingInvites.length > 0) {
    return (
      <>
        <TopBar />
        <main className="mx-auto max-w-2xl px-4 py-10">
          <h1 className="mb-2 text-xl font-semibold">You&apos;ve been invited</h1>
          <p className="mb-6 text-sm text-slate-500">
            Accept to join the workspace. You can switch between workspaces at any time from the
            selector in the top bar.
          </p>
          {acceptError && <p className="mb-3 text-sm text-red-600">{acceptError}</p>}
          <ul className="mb-6 flex flex-col gap-2">
            {pendingInvites.map((inv) => (
              <li
                key={inv.token}
                className="flex items-center gap-3 rounded border border-slate-200 bg-white px-4 py-3"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{inv.workspace_name}</span>
                  <span className="text-sm text-slate-500">as {inv.role}</span>
                </span>
                <button
                  type="button"
                  onClick={() => void handleAccept(inv.token)}
                  disabled={acceptingToken !== null}
                  className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
                >
                  {acceptingToken === inv.token ? "Accepting…" : "Accept"}
                </button>
              </li>
            ))}
          </ul>
          {memberships.length > 0 && (
            <button
              type="button"
              onClick={() => router.push(`/w/${memberships[0].id}`)}
              className="text-sm text-slate-500 underline hover:text-slate-900"
            >
              Skip for now
            </button>
          )}
        </main>
      </>
    );
  }

  if (activeWorkspace) {
    // redirect in flight
    return <div className="p-6 text-sm text-slate-500">Opening {activeWorkspace.name}…</div>;
  }

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="mb-6 text-xl font-semibold">Your workspaces</h1>
        {memberships.length === 0 ? (
          <p className="mb-6 text-sm text-slate-500">
            No workspaces yet. Ask an admin to invite you, or create one below.
          </p>
        ) : (
          <ul className="mb-6 flex flex-col gap-2">
            {memberships.map((w) => (
              <li key={w.id}>
                <button
                  type="button"
                  onClick={() => setActiveWorkspace(w.id)}
                  className="block w-full rounded border border-slate-200 bg-white px-4 py-3 text-left hover:border-slate-400"
                >
                  <span className="font-medium">{w.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={handleCreate} className="flex flex-col gap-2 border-t border-slate-200 pt-6">
          <label htmlFor="new-workspace-name" className="text-sm font-medium text-slate-700">
            Create a new workspace
          </label>
          <div className="flex gap-2">
            <input
              id="new-workspace-name"
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Workspace name"
              className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm"
              disabled={creating}
            />
            <button
              type="submit"
              disabled={creating || !newName.trim()}
              className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {creating ? "Creating…" : "Create"}
            </button>
          </div>
          {createError ? <p className="text-sm text-red-600">{createError}</p> : null}
        </form>
      </main>
    </>
  );
}
