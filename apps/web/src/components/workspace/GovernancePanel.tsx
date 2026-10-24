"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { DisciplinePanel } from "@/components/workspace/DisciplinePanel";
import { UsagePanel } from "@/components/workspace/UsagePanel";
import { PolicyScopeEditor } from "@/components/policy/PolicyScopeEditor";
import { putGovernance } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCloudGet } from "@/lib/hooks";
import type {
  GovernanceReport,
  PolicyScope,
  PolicyTemplateOut,
  ProjectCheck,
  WorkspaceGovernance,
} from "@/lib/types";

const OWNER_HATS = ["business_owner", "tech_steward"];

const DETAIL_MESSAGES: Record<string, string> = {
  admin_required: "Only a workspace admin can change this setting.",
  custom_text_too_long: "Custom policy text is too long. Keep it under 20,000 characters.",
  unknown_policy_template: "One of the selected templates is no longer available. Refresh the page.",
  unknown_hat: "One of the required roles is not recognised.",
};

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

// Where a failing check is fixed, keyed off the check id the server emits.
function fixLink(
  workspaceId: string,
  projectId: string,
  check: ProjectCheck,
): { href: string; label: string } {
  const base = `/w/${workspaceId}/p/${projectId}`;
  if (check.id.startsWith("hat_")) return { href: `${base}/settings`, label: "Assign roles" };
  if (check.id.startsWith("policy_")) {
    return { href: `${base}?tab=planner`, label: "Review policy scope" };
  }
  return { href: `${base}?tab=decisions`, label: "Open decisions" };
}

function Switch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-800">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

export function GovernancePanel({ workspaceId }: { workspaceId: string }) {
  const { authHeaders } = useAuth();
  const governance = useCloudGet<WorkspaceGovernance>(`/workspaces/${workspaceId}/governance`);
  const report = useCloudGet<GovernanceReport>(`/workspaces/${workspaceId}/governance/report`);
  const templates = useCloudGet<PolicyTemplateOut[]>("/policy-templates");

  const [scope, setScope] = useState<PolicyScope | null>(null);
  const [hats, setHats] = useState<string[]>(OWNER_HATS);
  const [seeded, setSeeded] = useState(true);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const loaded = governance.data;
  useEffect(() => {
    if (!loaded) return;
    setScope(loaded.policy_scope);
    setHats(loaded.required_hats);
    setSeeded(loaded.require_seeded_rules);
  }, [loaded]);

  async function save() {
    if (!scope) return;
    setStatus("saving");
    setError(null);
    try {
      await putGovernance(
        workspaceId,
        { policy_scope: scope, required_hats: hats, require_seeded_rules: seeded },
        authHeaders(),
      );
      setStatus("saved");
      governance.refetch();
      report.refetch();
    } catch (err) {
      const message = (err as Error).message;
      setStatus("error");
      setError(DETAIL_MESSAGES[message] ?? message);
    }
  }

  function setOwnerHats(on: boolean) {
    setHats((prev) => {
      const rest = prev.filter((h) => !OWNER_HATS.includes(h));
      return on ? [...OWNER_HATS, ...rest] : rest;
    });
    setStatus("idle");
  }

  return (
    <section className="mb-10 rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="mb-1 text-sm font-medium text-slate-900">AI governance</h2>
      <p className="mb-4 text-xs text-slate-500">
        The policy scope and rules every project in this workspace is held to.
      </p>

      {governance.error && (
        <p className="mb-3 text-xs text-red-600">
          {DETAIL_MESSAGES[governance.error] ?? governance.error}
        </p>
      )}

      {loaded && (
        <p className="mb-3 text-xs text-slate-600">
          {`Applies to ${plural(loaded.inheriting_unfrozen, "project", "projects")}.`}
          {loaded.own_scope.length > 0 && (
            <>
              {" "}
              {loaded.own_scope.length === 1
                ? "1 project uses its own scope"
                : `${loaded.own_scope.length} projects use their own scope`}
              {`: ${loaded.own_scope.join(", ")}.`}
            </>
          )}
        </p>
      )}

      {scope && (
        <PolicyScopeEditor
          scope={scope}
          templates={templates.data}
          readOnly={false}
          onSave={() => {}}
          onEdit={(next) => {
            setScope(next);
            setStatus("idle");
          }}
        />
      )}

      <div className="mb-4 mt-3 space-y-2">
        <Switch
          label="Every project needs a business owner and a tech steward"
          checked={OWNER_HATS.every((h) => hats.includes(h))}
          onChange={setOwnerHats}
        />
        <Switch
          label="Every project's repository must carry its rules"
          checked={seeded}
          onChange={(next) => {
            setSeeded(next);
            setStatus("idle");
          }}
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!scope || status === "saving"}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-700 disabled:opacity-60"
        >
          Save
        </button>
        <p className="text-xs text-slate-500">
          {status === "saving" && "Saving…"}
          {status === "saved" && "Saved"}
          {status === "error" && error && <span className="text-red-600">{error}</span>}
        </p>
      </div>

      {report.data && report.data.projects.length > 0 && (
        <ul className="mt-5 space-y-2 border-t border-slate-100 pt-4">
          {report.data.projects.map((p) => {
            const failing = p.checks.filter((c) => !c.ok);
            return (
              <li key={p.project_id} className="text-sm">
                <span className="font-medium text-slate-900">{p.name}</span>
                {failing.length === 0 ? (
                  <span className="ml-2 text-xs text-green-700">
                    Follows workspace rules (repository not checked here)
                  </span>
                ) : (
                  <ul className="mt-1 space-y-0.5">
                    {failing.map((c) => {
                      const fix = fixLink(workspaceId, p.project_id, c);
                      return (
                        <li key={c.id} className="text-xs text-amber-700">
                          {c.text}{" "}
                          <Link href={fix.href} className="underline hover:text-amber-900">
                            {fix.label}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {report.data && (
        <>
          <UsagePanel usage={report.data.usage ?? []} />
          {report.data.discipline && <DisciplinePanel discipline={report.data.discipline} />}
        </>
      )}
    </section>
  );
}
