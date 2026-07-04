// File access for the integrated editor (ADR 0007 developer surface). Every
// path is resolved and jailed inside the project directory — a request for
// "../../etc/passwd" or an absolute path must never escape. Browser-facing, so
// it also rides the global origin allowlist (ADR 0008).
import { Hono } from "hono";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  readdirSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { db } from "../db.ts";

export const files = new Hono();

const IGNORED = new Set([".git", "node_modules", ".DS_Store"]);
const MAX_READ_BYTES = 2_000_000;

function getProjectPath(id: string): string | null {
  const row = db.prepare("SELECT path FROM projects WHERE id = ?").get(id) as
    | { path: string }
    | undefined;
  return row?.path ?? null;
}

// Resolve a client-supplied relative path and refuse anything that escapes the
// project root. A lexical resolve+startsWith blocks "../" traversal but NOT a
// symlink *inside* the repo pointing out (e.g. `link -> /etc`, then
// `link/passwd`). So we canonicalize with realpath: for an existing target,
// realpath follows every symlink and must land inside root; for a new file
// (write), we realpath the deepest existing ancestor instead and confirm the
// not-yet-created remainder has no traversal.
function safeJoin(root: string, rel: string): string | null {
  let rootReal: string;
  try {
    rootReal = realpathSync(resolve(root));
  } catch {
    return null;
  }
  const target = resolve(rootReal, rel);

  let existing = target;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return null;
    existing = parent;
  }

  let existingReal: string;
  try {
    existingReal = realpathSync(existing);
  } catch {
    return null;
  }
  if (existingReal !== rootReal && !existingReal.startsWith(rootReal + sep)) return null;

  const remainder = relative(existing, target);
  if (remainder.split(sep).includes("..")) return null;
  return remainder ? join(existingReal, remainder) : existingReal;
}

type TreeNode = { name: string; path: string; dir: boolean; children?: TreeNode[] };

function buildTree(root: string, dir: string, depth: number): TreeNode[] {
  if (depth > 8) return [];
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => !IGNORED.has(e.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const nodes: TreeNode[] = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const rel = relative(root, abs);
    if (entry.isDirectory()) {
      nodes.push({ name: entry.name, path: rel, dir: true, children: buildTree(root, abs, depth + 1) });
    } else {
      nodes.push({ name: entry.name, path: rel, dir: false });
    }
  }
  return nodes;
}

files.get("/engine/projects/:id/files", (c) => {
  const root = getProjectPath(c.req.param("id") ?? "");
  if (!root) return c.json({ error: "project not found" }, 404);
  return c.json({ tree: buildTree(root, root, 0) });
});

files.get("/engine/projects/:id/file", (c) => {
  const root = getProjectPath(c.req.param("id") ?? "");
  if (!root) return c.json({ error: "project not found" }, 404);
  const rel = c.req.query("path");
  if (!rel) return c.json({ error: "path query param required" }, 400);
  const abs = safeJoin(root, rel);
  if (!abs) return c.json({ error: "path escapes project root" }, 400);
  try {
    if (statSync(abs).size > MAX_READ_BYTES) {
      return c.json({ error: "file too large to open in editor" }, 413);
    }
    return c.json({ path: rel, content: readFileSync(abs, "utf8") });
  } catch {
    return c.json({ error: "file not found or unreadable" }, 404);
  }
});

files.put("/engine/projects/:id/file", async (c) => {
  const root = getProjectPath(c.req.param("id") ?? "");
  if (!root) return c.json({ error: "project not found" }, 404);
  const body = await c.req.json<{ path?: string; content?: string }>();
  if (!body.path || typeof body.content !== "string") {
    return c.json({ error: "path and content are required" }, 400);
  }
  const abs = safeJoin(root, body.path);
  if (!abs) return c.json({ error: "path escapes project root" }, 400);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body.content);
  return c.json({ path: body.path, saved: true });
});

// Uncommitted files, so the editor and graph can show what changed (used by the
// dirty-state indicator; the graph's task sync stays commit-based).
files.get("/engine/projects/:id/status", (c) => {
  const root = getProjectPath(c.req.param("id") ?? "");
  if (!root) return c.json({ error: "project not found" }, 404);
  try {
    const changed = execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: root })
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((line) => ({ state: line.slice(0, 2).trim(), path: line.slice(3).trim() }));
    return c.json({ changed });
  } catch {
    return c.json({ changed: [] });
  }
});
