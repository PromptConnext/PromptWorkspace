// Derived view: repo_seed.py's table of paths written at repo creation.
// The create-repository endpoint returns only the Project, not a file list,
// so this mirrors the cloud's fixed seed set for display purposes — in the
// repo_created banner (Planner.tsx) and in the import gate's consent step
// (NewProjectDialog.tsx), which is why this lives in its own module rather
// than staying private to Planner.
import type { Project } from "@/lib/types";

// build_seed_files() — unconditional, every project.
export const SEEDED_FILES = [
  "AGENTS.md",
  "README.md",
  "docs/scope.md",
  "docs/architecture.md",
  "docs/tasks.md",
  "docs/conventions.md",
  ".specify/memory/constitution.md",
];

// build_deployment_files()'s workflow path. Conditional, not a fixed member
// of SEEDED_FILES: repo_seed.py only writes it when the project has a
// deployment template selected (Project.deployment_config), same gating as
// docs/policy-scope.md below.
export const DEPLOY_WORKFLOW_PATH = ".github/workflows/deploy.yml";

// Only seeded when the project has a non-empty policy scope (repo_seed.py),
// so it is listed conditionally rather than as a fixed member of SEEDED_FILES.
export function hasPolicyScope(project: Project): boolean {
  const scope = project.policy_scope;
  return !!scope && (scope.selected.length > 0 || scope.custom_text.trim().length > 0);
}

// Only seeded when a deployment template is selected (repo_seed.py's
// build_deployment_files early-returns otherwise).
export function hasDeploymentTemplate(project: Project): boolean {
  return !!project.deployment_config;
}
