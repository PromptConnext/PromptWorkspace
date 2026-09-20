// The AI coding rules, read from the clone — not from an API.
//
// The cloud seeds these three files into the repository once, at tech-review
// exit (apps/cloud/app/integrations/repo_seed.py), under a preamble that says
// "edit freely — never overwritten". So the file and the cloud's stage document
// drift by design, and git is the distribution channel. Reading the clone is
// also simply correct: it is the same text the developer's own agent will read.
//
// The stage document is still fetched, but only as provenance — one line of
// state when the two have diverged, never a diff view.
//
// The path list and the drift comparison live in @promptconnext/pz-cloud
// because apps/mcp's `get_project_rules` answers the same question over
// `node:fs` (plan 0025 §2). Only the reader is local to this file, and only
// because `vscode.workspace.fs` is the reader an editor should use.

import * as vscode from "vscode";
import { SEEDED_DOCS, sameDocText, seededDocFor, type CloudClient, type SeededDocKey } from "@promptconnext/pz-cloud";
import type { OutputLogger } from "../util/log.ts";

export { SEEDED_DOCS, type SeededDocKey };

export interface RepoDocContents {
  key: SeededDocKey;
  label: string;
  path: string;
  text: string | null;
}

export class RepoDocs {
  private readonly client: CloudClient;
  private readonly log: OutputLogger;

  constructor(
    client: CloudClient,
    log: OutputLogger,
  ) {
    this.client = client;
    this.log = log;
  }

  /** All three files for a folder, missing ones reported as null rather than
   *  omitted — "this project has no AGENTS.md" is information. */
  async readAll(folder: vscode.Uri): Promise<RepoDocContents[]> {
    const out: RepoDocContents[] = [];
    for (const doc of SEEDED_DOCS) {
      out.push({
        key: doc.key,
        label: doc.label,
        path: doc.path,
        text: await readFile(vscode.Uri.joinPath(folder, doc.path)),
      });
    }
    return out;
  }

  /** The constitution text for a project, preferring the clone. Used by
   *  copy-task-context, where a stale-but-present rule beats no rule. */
  async read(projectId: string, key: SeededDocKey): Promise<string | null> {
    const doc = seededDocFor(key);
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const text = await readFile(vscode.Uri.joinPath(folder.uri, doc.path));
      if (text) return text;
    }
    if (key !== "constitution") return null;
    try {
      const stage = await this.client.getStageDocument(projectId, "constitution");
      return stage.content || null;
    } catch (err) {
      this.log.info(`constitution unavailable from cloud: ${String(err)}`);
      return null;
    }
  }

  /** True when the cloud's constitution has moved on from the seeded file.
   *  Whitespace-normalised, because a reflow is not a change of rules. */
  async constitutionDrifted(
    projectId: string,
    folder: vscode.Uri,
  ): Promise<boolean | undefined> {
    const onDisk = await readFile(
      vscode.Uri.joinPath(folder, seededDocFor("constitution").path),
    );
    if (onDisk === null) return undefined;
    try {
      const stage = await this.client.getStageDocument(projectId, "constitution");
      if (!stage.content) return undefined;
      return !sameDocText(stage.content, onDisk);
    } catch {
      return undefined;
    }
  }
}

async function readFile(uri: vscode.Uri): Promise<string | null> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
