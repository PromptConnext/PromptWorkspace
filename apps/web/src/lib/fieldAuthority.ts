// Mirrors the static FIELD_AUTHORITY map in
// apps/cloud/app/models/schemas.py (M3). Not exposed via any endpoint — it's
// fixed domain knowledge, not per-workspace config. Keep in sync by hand.

export type Authority = "pz" | "pmo" | "shared";

export const FIELD_AUTHORITY: Record<string, Record<string, Authority>> = {
  tasks: {
    title: "shared",
    status: "pz",
    acceptance_criteria: "pz",
    feature_tag: "pmo",
    assignee: "pmo",
    sprint: "pmo",
  },
  requirements: { title: "shared", description: "shared", status: "pz" },
  spec_documents: { content: "pz", status: "pz", version: "pz" },
  artifacts: { uri: "pz", commit_sha: "pz", kind: "pz" },
  agent_runs: { action: "pz", status: "pz", evidence: "pz" },
};

// Fields absent from the map default to "pz" (see schemas.py comment).
export function authorityOf(entity: keyof typeof FIELD_AUTHORITY, field: string): Authority {
  return FIELD_AUTHORITY[entity]?.[field] ?? "pz";
}
