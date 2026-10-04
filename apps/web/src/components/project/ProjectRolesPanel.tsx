"use client";

import { useState } from "react";
import { setProjectRole } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCloudGet } from "@/lib/hooks";
import type { ProjectHat, ProjectRoleOut, WorkspaceMember } from "@/lib/types";
import { memberFullName } from "./MemberChip";

const HAT_LABEL: Record<ProjectHat, string> = {
  business_owner: "Business owner",
  tech_steward: "Tech steward",
};

const HAT_HELP: Record<ProjectHat, string> = {
  business_owner: "Approves the intent and business decisions.",
  tech_steward: "Approves the delivery plan and technical decisions.",
};

/** Who wears each project hat (plan 0029 §5.2). Unassigned means workspace
 * admins decide for that hat. */
export function ProjectRolesPanel({
  projectId,
  workspaceId,
  isAdmin,
}: {
  projectId: string;
  workspaceId: string;
  isAdmin: boolean;
}) {
  const { authHeaders } = useAuth();
  const {
    data: roles,
    error: rolesError,
    loading: rolesLoading,
    refetch,
  } = useCloudGet<ProjectRoleOut[]>(`/projects/${projectId}/roles`);
  const {
    data: members,
    error: membersError,
    loading: membersLoading,
  } = useCloudGet<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function assign(hat: ProjectHat, userId: string) {
    setSaveError(null);
    setSaving(true);
    try {
      await setProjectRole(projectId, hat, userId === "" ? null : userId, authHeaders());
      refetch();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Could not update the role.");
    } finally {
      setSaving(false);
    }
  }

  const loadError = rolesError ?? membersError;
  const ready = roles != null && members != null;

  return (
    <section className="mb-8 rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">Decision roles</h2>
      <p className="mb-4 text-xs text-slate-500">Unassigned roles fall back to workspace admins.</p>
      {loadError && (
        <p role="alert" className="text-sm text-rose-700">
          {loadError}
        </p>
      )}
      {!loadError && !ready && (rolesLoading || membersLoading) && (
        <p className="text-sm text-slate-500">Loading…</p>
      )}
      {saveError && (
        <p role="alert" className="mb-3 text-sm text-rose-700">
          {saveError}
        </p>
      )}
      {ready && (
        <div className="flex flex-col gap-4">
          {roles.map((role) => (
            <div key={role.hat} className="flex flex-col gap-1 text-sm text-slate-700">
              <label htmlFor={`project-role-${role.hat}`}>{HAT_LABEL[role.hat]}</label>
              <select
                id={`project-role-${role.hat}`}
                value={role.user_id ?? ""}
                disabled={!isAdmin || saving}
                onChange={(e) => assign(role.hat, e.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm disabled:bg-slate-50"
              >
                <option value="">Workspace admins</option>
                {members.map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    {memberFullName(m)}
                  </option>
                ))}
              </select>
              <span className="text-xs text-slate-500">{HAT_HELP[role.hat]}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
