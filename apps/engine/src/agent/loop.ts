// The minimal viable "agent loop" (plan M2, gap G1): Spec Kit's command
// wrappers assume a full coding-agent harness (shell scripts, $ARGUMENTS,
// multi-turn tool use). The skeleton drives the *document templates* directly:
// one chat call, files returned as ```file:<path> fenced blocks, engine writes
// them and commits. If BYO models can't fill the template acceptably this way,
// that failure is the milestone's finding — see docs/decisions.
import { mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { chatStream, type ChatMessage, type ModelConnection } from "../gateway/index.ts";

const templatesDir = join(import.meta.dirname, "templates");

function template(name: string): string {
  return readFileSync(join(templatesDir, name), "utf8");
}

const FILE_BLOCK = /```file:([^\n]+)\n([\s\S]*?)```/g;

export type StageOutput = {
  files: { path: string; content: string }[];
  title: string;
  raw: string;
};

export type StageKind = "specify" | "plan" | "tasks";

const STAGES: Record<StageKind, { template: string; role: string; outPath: string }> = {
  specify: {
    template: "spec-template.md",
    role: "specification",
    outPath: "specs/001/spec.md",
  },
  plan: {
    template: "plan-template.md",
    role: "implementation-planning",
    outPath: "specs/001/plan.md",
  },
  tasks: {
    template: "tasks-template.md",
    role: "task-breakdown",
    outPath: "specs/001/tasks.md",
  },
};

function outPathFor(kind: StageKind): string {
  return STAGES[kind].outPath;
}

function driverPrompt(kind: StageKind): string {
  const stage = STAGES[kind];
  const doc = template(stage.template);
  return [
    `You are the ${stage.role} engine inside PromptZone.`,
    `Fill in the following template completely, based on the user's input. Replace every placeholder. Do not leave template markers like [FEATURE NAME] or $ARGUMENTS in the output. Mark genuine unknowns with [NEEDS CLARIFICATION: question].`,
    ...(kind === "tasks"
      ? [
          `Every task line MUST keep the exact checklist shape \`- [ ] T001 [P] Description\` ([P] only when parallelizable) so the platform can ingest it.`,
        ]
      : []),
    ``,
    `TEMPLATE:`,
    doc,
    ``,
    `OUTPUT FORMAT (mandatory): return each file as a fenced block that starts with \`\`\`file:<relative-path> and ends with \`\`\`. Produce exactly one file at ${stage.outPath}. The first line of the file must be a markdown H1 title. No prose outside the fenced block.`,
  ].join("\n");
}

// Pull `- [ ] T001 [P] Description` checklist lines out of a tasks.md.
export function parseTaskLines(
  doc: string,
): { ref: string; title: string; parallel: boolean }[] {
  const tasks: { ref: string; title: string; parallel: boolean }[] = [];
  for (const line of doc.split("\n")) {
    const m = /^\s*[-*] \[[ xX]?\] (T\d+)\s+(\[P\]\s+)?(.+)$/.exec(line);
    if (m) tasks.push({ ref: m[1], title: m[3].trim(), parallel: Boolean(m[2]) });
  }
  return tasks;
}

function parseFiles(raw: string): StageOutput["files"] {
  const files: StageOutput["files"] = [];
  for (const match of raw.matchAll(FILE_BLOCK)) {
    const path = match[1].trim();
    if (path.includes("..") || path.startsWith("/")) continue;
    files.push({ path, content: match[2] });
  }
  return files;
}

// Thinking models (qwen3, deepseek-r1, ...) prepend reasoning the parser must
// never see.
function stripThinking(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

// Fallback for models that write a good document but ignore the file-block
// wrapper (the most common real-model failure): unwrap a plain markdown fence
// if present, then take everything from the first H1 onward.
function extractDocument(raw: string): string | null {
  let text = raw.trim();
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/m.exec(text);
  if (fenced && fenced[0].length > text.length * 0.8) text = fenced[1].trim();
  const h1 = text.indexOf("\n# ");
  if (h1 >= 0 && !text.startsWith("# ")) text = text.slice(h1 + 1);
  return text.startsWith("# ") && text.length > 80 ? text : null;
}

export async function runStage(
  kind: StageKind,
  conn: ModelConnection,
  projectPath: string,
  userInput: string,
  onDelta: (text: string) => void = () => {},
): Promise<StageOutput> {
  const messages: ChatMessage[] = [
    { role: "system", content: driverPrompt(kind) },
    { role: "user", content: userInput },
  ];
  const result = await chatStream(conn, messages, onDelta);
  const cleaned = stripThinking(result.content);
  let files = parseFiles(cleaned);
  if (files.length === 0) {
    const doc = extractDocument(cleaned);
    if (doc) files = [{ path: outPathFor(kind), content: doc }];
  }
  if (files.length === 0) {
    throw new Error(
      "model output contained neither file blocks nor a recognizable markdown document",
    );
  }
  writeFiles(projectPath, files);
  const firstLine = files[0].content.split("\n").find((l) => l.startsWith("# "));
  const title = firstLine ? firstLine.replace(/^#\s*/, "").trim() : userInput.slice(0, 80);

  commitAll(projectPath, `promptzone: ${kind} output`);

  return { files, title, raw: result.content };
}

function writeFiles(projectPath: string, files: StageOutput["files"]): void {
  for (const file of files) {
    const abs = join(projectPath, file.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.content);
  }
}

export function commitAll(projectPath: string, message: string): string {
  execFileSync("git", ["add", "-A"], { cwd: projectPath });
  return commitStaged(projectPath, message);
}

// Commit exactly these paths — agent mode must not sweep up unrelated files
// (e.g. tooling state) with a blanket add.
export function commitFiles(projectPath: string, files: string[], message: string): string {
  execFileSync("git", ["add", "--", ...files], { cwd: projectPath });
  return commitStaged(projectPath, message);
}

function commitStaged(projectPath: string, message: string): string {
  const head = () =>
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectPath }).toString().trim();
  // A regenerate that produces identical files stages nothing — don't fail
  // (and don't create an empty commit); just return the current HEAD.
  const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
    cwd: projectPath,
  })
    .toString()
    .trim();
  if (!staged) {
    try {
      return head();
    } catch {
      return ""; // repo with no commits yet and nothing to stage
    }
  }
  execFileSync("git", ["commit", "-m", message, "--no-gpg-sign"], {
    cwd: projectPath,
    stdio: "pipe",
  });
  return head();
}

// Implementation kick-off (architecture §3.2 POST /engine/tasks/{id}/run):
// single-shot codegen with the repo snapshot in context. The model cannot
// read files interactively — complete-file outputs only. A multi-turn tool
// loop is the known upgrade path (ADR 0005).
export async function runImplementation(
  conn: ModelConnection,
  projectPath: string,
  taskLabel: string,
  context: string,
  onDelta: (text: string) => void = () => {},
): Promise<{ files: StageOutput["files"]; raw: string; commitSha: string }> {
  const system = [
    "You are the implementation engine inside PromptZone. Complete the given task by writing code into the repository.",
    "Always write COMPLETE file contents — partial edits or diffs are not accepted. Keep changes scoped to the task.",
    "OUTPUT FORMAT (mandatory): return each created or modified file as a fenced block that starts with ```file:<relative-path> and ends with ```. No prose outside fenced blocks.",
  ].join("\n");
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: context },
  ];
  const result = await chatStream(conn, messages, onDelta);
  const files = parseFiles(stripThinking(result.content));
  if (files.length === 0) {
    throw new Error("model output contained no file blocks — nothing to apply");
  }
  writeFiles(projectPath, files);
  const commitSha = commitAll(projectPath, `promptzone: ${taskLabel}`);
  return { files, raw: result.content, commitSha };
}
