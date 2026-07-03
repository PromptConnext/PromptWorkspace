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

function outPathFor(kind: "specify" | "plan"): string {
  return kind === "specify" ? "specs/001/spec.md" : "specs/001/plan.md";
}

function driverPrompt(kind: "specify" | "plan"): string {
  const doc = template(kind === "specify" ? "spec-template.md" : "plan-template.md");
  const outPath = outPathFor(kind);
  return [
    `You are the ${kind === "specify" ? "specification" : "implementation-planning"} engine inside PromptZone.`,
    `Fill in the following template completely, based on the user's input. Replace every placeholder. Do not leave template markers like [FEATURE NAME] or $ARGUMENTS in the output. Mark genuine unknowns with [NEEDS CLARIFICATION: question].`,
    ``,
    `TEMPLATE:`,
    doc,
    ``,
    `OUTPUT FORMAT (mandatory): return each file as a fenced block that starts with \`\`\`file:<relative-path> and ends with \`\`\`. Produce exactly one file at ${outPath}. The first line of the file must be a markdown H1 title. No prose outside the fenced block.`,
  ].join("\n");
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
  kind: "specify" | "plan",
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
  for (const file of files) {
    const abs = join(projectPath, file.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.content);
  }
  const firstLine = files[0].content.split("\n").find((l) => l.startsWith("# "));
  const title = firstLine ? firstLine.replace(/^#\s*/, "").trim() : userInput.slice(0, 80);

  execFileSync("git", ["add", "-A"], { cwd: projectPath });
  execFileSync(
    "git",
    ["commit", "-m", `promptzone: ${kind} output`, "--no-gpg-sign"],
    { cwd: projectPath, stdio: "pipe" },
  );

  return { files, title, raw: result.content };
}
