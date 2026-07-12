import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS spec_documents (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL REFERENCES requirements(id),
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  approved_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL REFERENCES spec_documents(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo',
  feature_tag TEXT
);

CREATE TABLE IF NOT EXISTS acceptance_criteria (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL CHECK (kind IN ('code','pr','doc')),
  uri TEXT NOT NULL,
  commit_sha TEXT
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT REFERENCES tasks(id),
  model_connection_id TEXT REFERENCES model_connections(id),
  action TEXT NOT NULL,
  input_ref TEXT,
  output_ref TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  evidence TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS model_connections (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('plan','code','thai','other')),
  mode TEXT NOT NULL CHECK (mode IN ('api_key','subscription')),
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  model TEXT NOT NULL,
  credential_ref TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN ('git','jira','clickup','mcp','cloud')),
  config TEXT,
  required INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stage_states (
  project_id TEXT NOT NULL REFERENCES projects(id),
  stage TEXT NOT NULL CHECK (stage IN ('scope','spec','skill')),
  status TEXT NOT NULL DEFAULT 'not_started',
  gate_passed INTEGER NOT NULL DEFAULT 0,
  approver TEXT,
  PRIMARY KEY (project_id, stage)
);

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- M12: comments threaded on any graph node. project_id is stored directly
-- (like agent_runs, unlike requirements/tasks/artifacts, which reach it via
-- a join chain) since parent_node_type can point at four different tables —
-- joining through all of them just to scope by project isn't worth it.
-- The first local table needing updated_at/deleted_at: it's also the first
-- table this engine pulls from the cloud rather than only ever pushing, so
-- it needs the same tombstone/cursor shape the cloud side already has.
CREATE TABLE IF NOT EXISTS discussions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  parent_node_type TEXT NOT NULL,
  parent_node_id TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'pz' CHECK (source IN ('pz','pmo')),
  deleted_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function dataDir(): string {
  const dir =
    process.env.PROMPTZONE_DATA_DIR ??
    join(homedir(), "Library", "Application Support", "PromptZone");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const db = new DatabaseSync(join(dataDir(), "promptzone.db"));
db.exec("PRAGMA foreign_keys = ON;");
db.exec(SCHEMA);

export function getAppState(key: string): string | null {
  const row = db
    .prepare("SELECT value FROM app_state WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setAppState(key: string, value: string): void {
  db.prepare(
    "INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}
