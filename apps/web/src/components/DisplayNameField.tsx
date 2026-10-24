"use client";

import { useState } from "react";
import { updateMemberDisplayName } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { WorkspaceMember } from "@/lib/types";

/** One member's display-name input. A blank value clears the name. */
export function DisplayNameField({
  workspaceId,
  member,
  label,
  onSaved,
}: {
  workspaceId: string;
  member: WorkspaceMember;
  label: string;
  onSaved?: (member: WorkspaceMember) => void;
}) {
  const { authHeaders } = useAuth();
  const [value, setValue] = useState(member.display_name ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    try {
      const saved = await updateMemberDisplayName(
        workspaceId,
        member.user_id,
        value.trim() || null,
        authHeaders(),
      );
      setStatus("saved");
      onSaved?.(saved);
    } catch {
      setStatus("error");
    }
  }

  const id = `display-name-${member.user_id}`;
  return (
    <form onSubmit={submit} className="flex items-center gap-2">
      <label htmlFor={id} className="text-sm font-medium text-slate-700">
        {label}
      </label>
      <input
        id={id}
        value={value}
        maxLength={80}
        onChange={(e) => {
          setValue(e.target.value);
          setStatus("idle");
        }}
        className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
      />
      <button
        type="submit"
        disabled={status === "saving"}
        className="rounded-md bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-50"
      >
        Save
      </button>
      {status === "saved" && <span className="text-sm text-emerald-700">Saved</span>}
      {status === "error" && <span className="text-sm text-rose-700">Could not save</span>}
    </form>
  );
}
