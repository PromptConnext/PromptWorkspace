// The `get_project_rules` payload.
//
// The clone is the authority. The cloud seeds these three files once and never
// overwrites them (apps/cloud/app/integrations/repo_seed.py), so the text on
// disk is what the project actually agreed to and what the developer's own
// agent would read if it looked. The stage document is fetched for exactly two
// purposes, both provenance: to stand in when the constitution is not on disk
// at all, and to say in one line when the two have diverged. Never a diff.

import { sameDocText, type CloudClient, type LoggerLike } from "@promptworkspace/cloud-client";
import type { ProjectCandidate } from "./projectResolve.ts";
import { readSeededDocs } from "./repoDocs.ts";

export async function buildProjectRules(
  root: string,
  project: ProjectCandidate,
  client: CloudClient,
  log: LoggerLike,
): Promise<string> {
  const docs = await readSeededDocs(root);
  const cloudConstitution = await constitutionFromCloud(project.projectId, client, log);

  const lines: string[] = [
    `# Coding rules for ${project.projectName} (${project.workspaceName})`,
    "",
    `- Project id: ${project.projectId}`,
    `- Workspace root: ${root}`,
  ];
  if (project.repoUrl) lines.push(`- Repository: ${project.repoUrl}`);
  lines.push(
    "",
    "These are the project's own seeded files, read from this clone. They are the",
    "authority: the cloud writes them once and never overwrites them, so edits in",
    "the repository win.",
    "",
  );

  for (const doc of docs) {
    lines.push(`## ${doc.label} (\`${doc.path}\`)`, "");
    if (doc.key === "constitution") {
      lines.push(...constitutionSection(doc.text, cloudConstitution));
      continue;
    }
    // Missing is stated, never omitted: "this project has no AGENTS.md" is an
    // answer an agent can act on, and silence is one it fills in by guessing.
    lines.push(doc.text ? doc.text.trim() : "_Not present in this clone._", "");
  }

  return lines.join("\n");
}

/** The constitution, plus the one line of provenance it has earned. */
function constitutionSection(onDisk: string | null, fromCloud: string | null): string[] {
  if (onDisk === null) {
    if (fromCloud === null) {
      return [
        "_Not present in this clone, and the cloud has no constitution for this project._",
        "",
      ];
    }
    return [
      "_Not present in this clone — shown from the cloud's constitution stage document._",
      "",
      fromCloud.trim(),
      "",
    ];
  }
  const note =
    fromCloud === null
      ? "_From this clone. The cloud's constitution stage document was not available to compare._"
      : sameDocText(onDisk, fromCloud)
        ? "_From this clone, and unchanged from the cloud's constitution stage document._"
        : "_From this clone, which has diverged from the cloud's constitution stage " +
          "document. The file is the authority; the cloud copy is provenance only._";
  return [note, "", onDisk.trim(), ""];
}

async function constitutionFromCloud(
  projectId: string,
  client: CloudClient,
  log: LoggerLike,
): Promise<string | null> {
  try {
    const stage = await client.getStageDocument(projectId, "constitution");
    return stage.content || null;
  } catch (err) {
    // Provenance is a nicety. Losing it must never cost the developer the
    // three files that are sitting right there on disk.
    log.info(`constitution unavailable from cloud: ${String(err)}`);
    return null;
  }
}
