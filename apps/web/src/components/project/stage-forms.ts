// apps/web/src/components/project/stage-forms.ts
//
// Structured input for the Spec Kit stages the Planner asks a human to fill
// in. The cloud's generation endpoint takes one opaque `user_input` string
// (app/api/generation.py), so the shape lives here on the client: each field
// maps onto a section the stage's own template already expects, and
// `composeStageInput()` renders the answers back down to the markdown blob
// the endpoint wants. No API change is needed for this to work.
//
// Field sets are deliberately stage-shaped, not generic:
//   constitution — the project's standing rules (principles, quality bar, workflow)
//   specify — business framing (who, why, journeys, success), no technology
//   plan    — the plan template's own "Technical Context" block, field for field
//   tasks   — nothing; it is derived from the spec and the plan (see TASKS_INPUT)

import type { StageKind } from "@/lib/types";

export type StageField = {
  key: string;
  label: string;
  hint?: string;
  placeholder?: string;
  type: "text" | "textarea" | "select";
  options?: string[];
  required?: boolean;
  rows?: number;
};

// The constitution is the only project-level document — it has no graph entity
// and no stage gates it, but it steers every later generation and is what
// AGENTS.md is seeded from at repo creation
// (apps/cloud/app/integrations/repo_seed.py). The fields mirror
// constitution-template.md's own sections: principles, then two free sections,
// then governance.
export const CONSTITUTION_FIELDS: StageField[] = [
  {
    key: "principles",
    label: "Engineering principles",
    hint: "One per line — the rules a reviewer may reject a change over.",
    placeholder:
      "Test-first: no implementation before a failing test\nEvery feature ships behind a flag\nSimplicity over cleverness",
    type: "textarea",
    rows: 4,
    required: true,
  },
  {
    key: "quality",
    label: "Quality bar",
    hint: "What must be true before code merges.",
    placeholder: "Unit + integration tests on every change; no lint or type errors; reviewed by one other engineer",
    type: "textarea",
    rows: 2,
  },
  {
    key: "standards",
    label: "Technology & security standards",
    hint: "Stack rules, dependency policy, data-handling requirements.",
    placeholder: "TypeScript everywhere; no new runtime dependency without review; secrets never in the repo",
    type: "textarea",
    rows: 2,
  },
  {
    key: "workflow",
    label: "Development workflow",
    hint: "Branching, review, and release process.",
    placeholder: "Trunk-based with short-lived branches; squash merge; release from main behind CI",
    type: "textarea",
    rows: 2,
  },
  {
    key: "governance",
    label: "Governance",
    hint: "Who may amend these rules, and how.",
    placeholder: "Amendments need Tech Lead approval and a note in the changelog",
    type: "text",
  },
];

export const SPECIFY_FIELDS: StageField[] = [
  {
    key: "feature_name",
    label: "What are we building?",
    hint: "A short name for the feature or product slice.",
    placeholder: "Thai QR payment checkout",
    type: "text",
    required: true,
  },
  {
    key: "problem",
    label: "Problem it solves",
    hint: "What hurts today, and why it is worth fixing now.",
    placeholder: "Customers abandon checkout because card payment is the only option…",
    type: "textarea",
    rows: 3,
    required: true,
  },
  {
    key: "users",
    label: "Who is it for?",
    hint: "The people who will use this, and what they are trying to get done.",
    placeholder: "Retail shoppers on mobile; finance staff reconciling payments",
    type: "textarea",
    rows: 2,
    required: true,
  },
  {
    key: "journeys",
    label: "Key user journeys",
    hint: "One per line, most important first — each line becomes a prioritised user story.",
    placeholder:
      "Shopper pays an order with a QR code and sees it confirmed\nFinance staff export a day's payments",
    type: "textarea",
    rows: 4,
    required: true,
  },
  {
    key: "success",
    label: "How will we know it worked?",
    hint: "Measurable outcomes, not features.",
    placeholder: "Checkout abandonment drops below 20%; payments settle within 5 minutes",
    type: "textarea",
    rows: 2,
  },
  {
    key: "out_of_scope",
    label: "Explicitly out of scope",
    hint: "Anything a reader might otherwise assume is included.",
    placeholder: "Refunds, recurring billing, in-store terminals",
    type: "textarea",
    rows: 2,
  },
  {
    key: "constraints",
    label: "Business constraints & assumptions",
    hint: "Deadlines, regulation, budget, existing commitments.",
    placeholder: "Must launch before the November campaign; BOT e-payment rules apply",
    type: "textarea",
    rows: 2,
  },
];

// Mirrors the "Technical Context" block of
// apps/cloud/app/generation/templates/plan-template.md, so the model fills a
// section it was already asked for rather than inferring it from prose.
export const PLAN_FIELDS: StageField[] = [
  {
    key: "project_type",
    label: "Project type",
    type: "select",
    required: true,
    options: [
      "Web application",
      "API / backend service",
      "CLI tool",
      "Library / SDK",
      "Mobile app",
      "Desktop app",
      "Data pipeline",
      "Other",
    ],
  },
  {
    key: "language",
    label: "Language / runtime version",
    placeholder: "TypeScript on Node 24; Python 3.12",
    type: "text",
    required: true,
  },
  {
    key: "dependencies",
    label: "Primary frameworks & dependencies",
    placeholder: "Next.js 16, FastAPI, Tailwind v4",
    type: "textarea",
    rows: 2,
    required: true,
  },
  {
    key: "storage",
    label: "Storage",
    hint: "Leave blank if the feature stores nothing.",
    placeholder: "Postgres via Supabase",
    type: "text",
  },
  {
    key: "testing",
    label: "Testing",
    placeholder: "vitest, pytest, Playwright",
    type: "text",
  },
  {
    key: "target_platform",
    label: "Target platform",
    placeholder: "Linux container on Railway; modern browsers",
    type: "text",
  },
  {
    key: "architecture",
    label: "Architecture / approach notes",
    hint: "Existing services to reuse, integration points, anything already decided.",
    placeholder: "Reuse the existing payments service; webhook callback from the PSP",
    type: "textarea",
    rows: 3,
  },
  {
    key: "performance",
    label: "Performance goals",
    placeholder: "p95 under 200 ms; 500 checkouts per minute",
    type: "text",
  },
  {
    key: "constraints",
    label: "Technical constraints",
    placeholder: "No new infrastructure; must run offline-capable",
    type: "text",
  },
  {
    key: "scale",
    label: "Scale / scope",
    placeholder: "10k monthly orders; 6 screens",
    type: "text",
  },
];

export const STAGE_FIELDS: Partial<Record<StageKind, StageField[]>> = {
  constitution: CONSTITUTION_FIELDS,
  specify: SPECIFY_FIELDS,
  plan: PLAN_FIELDS,
};

// Which stages the prefill endpoint accepts — mirrors the Literal on
// app/api/generation.py::prefill. A PRD describes a product, not a team's
// standing engineering rules, so the constitution is authored, not drafted.
export const PREFILLABLE_STAGES: StageKind[] = ["specify", "plan"];

// `tasks` takes no human input — the breakdown is derived from the spec and
// the plan, which the endpoint already injects as context. The request body
// still needs a non-empty `user_input` (it is the fallback document title in
// parse_stage_output), so this stands in for one.
export const TASKS_INPUT =
  "Break the approved specification and implementation plan into an ordered, " +
  "dependency-aware task list.";

export type StageAnswers = Record<string, string>;

export function requiredFieldsFilled(fields: StageField[], answers: StageAnswers): boolean {
  return fields.every((f) => !f.required || (answers[f.key] ?? "").trim().length > 0);
}

/**
 * Render the answers as the markdown blob sent as `user_input`. Blank optional
 * fields are listed at the end rather than dropped silently: the driver prompt
 * tells the model to mark genuine unknowns `[NEEDS CLARIFICATION: …]`, and it
 * can only do that for a gap it can see.
 */
export function composeStageInput(fields: StageField[], answers: StageAnswers): string {
  const filled: string[] = [];
  const missing: string[] = [];

  for (const field of fields) {
    const value = (answers[field.key] ?? "").trim();
    if (value) filled.push(`## ${field.label}\n\n${value}`);
    else missing.push(field.label);
  }

  const parts = [filled.join("\n\n")];
  if (missing.length > 0) {
    parts.push(
      `## Not provided\n\nThe author left these blank — do not invent them; mark each as ` +
        `[NEEDS CLARIFICATION] where the template needs it:\n` +
        missing.map((label) => `- ${label}`).join("\n"),
    );
  }
  return parts.filter(Boolean).join("\n\n");
}

export function stageDraftKey(projectId: string, stage: StageKind): string {
  return `pz:stage-input:${projectId}:${stage}`;
}
