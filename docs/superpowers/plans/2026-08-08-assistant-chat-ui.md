# Assistant Chat UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `apps/web` a project-scoped RAG assistant panel that consumes the existing (and currently unreachable) `POST /projects/{id}/assistant/chat` SSE endpoint.

**Architecture:** A slide-over panel opened from the Discussion tab. A new frame-based SSE reader (`lib/sse.ts`) decodes the endpoint's three frame kinds — `facts`, `message`, `citations` — into per-turn state held by `useAssistantChat`. Answers are ephemeral: nothing is persisted, nothing is posted to the discussion thread. One two-line `apps/cloud` change exposes stage-document ids so citations can be labeled.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript (strict), Tailwind, vitest + happy-dom + `@testing-library/react`. Cloud side: FastAPI + pydantic, pytest, ruff.

**Spec:** `docs/superpowers/specs/2026-08-08-assistant-chat-ui-design.md`

## Global Constraints

- Branch is `feat/web-assistant-chat-ui`. Do not commit to `main`.
- `apps/web` is TypeScript **strict** (`tsconfig.json:11`). No `any` in committed code.
- `src/lib/types.ts` mirrors `apps/cloud/app/models/schemas.py` field-for-field. It is a read-only client mirror, not an independent schema — do not invent fields.
- Do **not** modify `src/lib/planner-sse.ts`, `src/components/project/useStageGeneration.ts`, or `src/components/project/Planner.tsx`. Migrating the Planner onto the new reader is explicitly out of scope.
- Web tests run with `pnpm --dir apps/web vitest run`. Typecheck with `pnpm --dir apps/web tsc --noEmit`.
- Cloud tests run with `cd apps/cloud && pytest`; lint with `ruff check .` (line-length 100).
- Internal links use `next/link` in `apps/web` (the locale-aware `@/i18n/navigation` rule applies to `apps/corp` only).
- Assistant answers are **never** written to any cloud endpoint. The panel is read-only apart from the reindex button in Task 8.
- Tailwind classes follow the existing components' palette: `slate-*` for chrome, `red-600` for errors, `bg-slate-900 text-white` for primary buttons.

---

### Task 1: Expose stage-document ids from the cloud

Citations of type `stage_documents` carry a `node_id`, but `StageDocumentOut` currently returns only `stage`, `content`, and `updated_at`. Without the id there is no way to map a citation back to a stage name. This task adds it.

**Files:**
- Modify: `apps/cloud/app/api/stage_documents.py:32-35` (model), `:52-54` (GET return sites), `:79` (PATCH return site)
- Test: `apps/cloud/tests/test_stage_documents.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `GET /projects/{project_id}/stage-documents/{stage}` and `PATCH …` both return an extra field `id: str | None`. `None` only when no stage document exists yet.

- [ ] **Step 1: Write the failing test**

Append to `apps/cloud/tests/test_stage_documents.py`:

```python
def test_get_stage_document_returns_id_after_save(client, project_id):
    client.patch(
        f"/projects/{project_id}/stage-documents/specify",
        json={"content": "# Spec"},
    )
    res = client.get(f"/projects/{project_id}/stage-documents/specify")
    assert res.status_code == 200
    body = res.json()
    assert body["id"]
    assert isinstance(body["id"], str)


def test_get_stage_document_id_is_none_when_absent(client, project_id):
    res = client.get(f"/projects/{project_id}/stage-documents/constitution")
    assert res.status_code == 200
    assert res.json()["id"] is None


def test_patch_stage_document_returns_same_id_on_update(client, project_id):
    first = client.patch(
        f"/projects/{project_id}/stage-documents/plan", json={"content": "a"}
    ).json()
    second = client.patch(
        f"/projects/{project_id}/stage-documents/plan", json={"content": "b"}
    ).json()
    assert first["id"] == second["id"]
```

Read the top of `test_stage_documents.py` first and reuse its existing fixture names. If the fixtures there are named differently than `client` / `project_id`, use the file's own names rather than adding new fixtures.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/cloud && pytest tests/test_stage_documents.py -v -k "id"`
Expected: FAIL with `KeyError: 'id'`.

- [ ] **Step 3: Add the field and populate it**

In `apps/cloud/app/api/stage_documents.py`:

```python
class StageDocumentOut(BaseModel):
    # Present so the web client can map a stage_documents citation
    # (app/api/assistant.py) back to a stage name — the RAG citation carries
    # the row id, and stage name is what a reader recognises. None when no
    # document has been saved for this stage yet.
    id: str | None
    stage: str
    content: str
    updated_at: str | None
```

Then update all three construction sites:

```python
    if doc is None:
        return StageDocumentOut(id=None, stage=stage, content="", updated_at=None)
    return StageDocumentOut(
        id=doc.id, stage=stage, content=doc.content, updated_at=doc.updated_at.isoformat()
    )
```

and in `update_stage_document`:

```python
    return StageDocumentOut(
        id=doc.id, stage=stage, content=doc.content, updated_at=doc.updated_at.isoformat()
    )
```

- [ ] **Step 4: Run the full cloud suite**

Run: `cd apps/cloud && pytest -q && ruff check .`
Expected: all pass. `test_stage_documents.py`, `test_stage_access.py`, `test_stage_documents_rag.py`, `test_prefill.py` and `test_generation.py` all touch this endpoint — if any assert on an exact response body dict, add `"id"` to the expected shape rather than loosening the assertion.

- [ ] **Step 5: Commit**

```bash
git add apps/cloud/app/api/stage_documents.py apps/cloud/tests/test_stage_documents.py
git commit -m "feat(cloud): return stage-document id so citations can resolve a stage name"
```

---

### Task 2: Frame-based SSE reader

`parseSseLine` in `src/lib/planner-sse.ts` has no frame boundary, so a mid-stream `event: facts` corrupts the frames after it. This task builds a correct reader. It is pure — no fetch, no DOM — so it is tested in isolation.

**Files:**
- Create: `apps/web/src/lib/sse.ts`
- Test: `apps/web/src/lib/sse.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type SseFrame = { event: string; data: unknown };
  export function parseFrames(buffer: string): { frames: SseFrame[]; rest: string };
  ```
  Task 5 calls `parseFrames` with an accumulating decoded string and keeps `rest` for the next chunk.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/sse.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseFrames } from "./sse";

// Frames are separated by a blank line, exactly as
// apps/cloud/app/api/assistant.py writes them ("…\n\n").
function frames(...raw: string[]): string {
  return raw.map((r) => r + "\n\n").join("");
}

describe("parseFrames", () => {
  it("keeps a named mid-stream event from leaking into the frames after it", () => {
    const buffer = frames(
      'event: facts\ndata: {"title":"Login"}',
      'data: {"delta":"Two of "}',
      'data: {"delta":"four tasks"}',
      'event: citations\ndata: {"citations":[]}',
    );

    const { frames: out, rest } = parseFrames(buffer);

    expect(rest).toBe("");
    expect(out.map((f) => f.event)).toEqual(["facts", "message", "message", "citations"]);
    expect(out[0].data).toEqual({ title: "Login" });
    expect(out[1].data).toEqual({ delta: "Two of " });
  });

  it("returns an incomplete trailing frame as rest and emits it once completed", () => {
    const first = parseFrames('data: {"delta":"a"}\n\ndata: {"del');
    expect(first.frames).toEqual([{ event: "message", data: { delta: "a" } }]);
    expect(first.rest).toBe('data: {"del');

    const second = parseFrames(first.rest + 'ta":"b"}\n\n');
    expect(second.frames).toEqual([{ event: "message", data: { delta: "b" } }]);
    expect(second.rest).toBe("");
  });

  it("handles CRLF line endings", () => {
    const { frames: out } = parseFrames('event: facts\r\ndata: {"a":1}\r\n\r\n');
    expect(out).toEqual([{ event: "facts", data: { a: 1 } }]);
  });

  it("holds back a trailing CR that may be half of a split CRLF", () => {
    const first = parseFrames('data: {"delta":"a"}\r\n\r');
    expect(first.frames).toHaveLength(0);
    // CRLF inside the buffer is normalised; only the dangling CR is held back.
    expect(first.rest).toBe('data: {"delta":"a"}\n\r');

    const second = parseFrames(first.rest + "\n");
    expect(second.frames).toEqual([{ event: "message", data: { delta: "a" } }]);
    expect(second.rest).toBe("");
  });

  it("ignores comment lines and strips one leading space after data:", () => {
    const { frames: out } = parseFrames(': keep-alive\ndata: {"delta":"x"}\n\n');
    expect(out).toEqual([{ event: "message", data: { delta: "x" } }]);
  });

  it("joins multi-line data with a newline", () => {
    // The split falls between JSON tokens, not inside a string literal: JSON
    // forbids a raw newline inside a string, so a payload split mid-string
    // could never be reassembled by any reader. This passes only if the join
    // is a real newline, which is what the SSE spec requires.
    const { frames: out } = parseFrames('data: {"delta":\ndata: "hello"}\n\n');
    expect((out[0].data as { delta: string }).delta).toBe("hello");
  });

  it("passes unknown event names through unchanged", () => {
    const { frames: out } = parseFrames('event: something_new\ndata: {}\n\n');
    expect(out[0].event).toBe("something_new");
  });

  it("drops a frame with unparseable JSON without discarding later frames", () => {
    const { frames: out } = parseFrames('data: not json\n\ndata: {"delta":"ok"}\n\n');
    expect(out).toEqual([{ event: "message", data: { delta: "ok" } }]);
  });

  it("returns empty results for an empty buffer", () => {
    expect(parseFrames("")).toEqual({ frames: [], rest: "" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --dir apps/web vitest run src/lib/sse.test.ts`
Expected: FAIL — `Failed to resolve import "./sse"`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/lib/sse.ts`:

```ts
// Server-sent-event frame reader.
//
// Distinct from lib/planner-sse.ts, which parses one line at a time and has no
// frame boundary. That works for app/api/generation.py, whose only named events
// (done, error) are terminal, but corrupts app/api/assistant.py's stream, which
// emits `event: facts` mid-stream and then continues with bare data: deltas.
// Framing on the blank line is what makes the event name reset correctly.

export type SseFrame = { event: string; data: unknown };

export function parseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  // A trailing CR may be the first half of a CRLF split across two network
  // chunks. Normalising it now would invent a line break, so hold it back.
  let pending = "";
  let text = buffer;
  if (text.endsWith("\r")) {
    pending = "\r";
    text = text.slice(0, -1);
  }

  const blocks = text.replace(/\r\n/g, "\n").split("\n\n");
  // The final block is either empty (buffer ended on a frame boundary) or a
  // partial frame still arriving — either way it is not ready to emit.
  const trailing = blocks.pop() ?? "";

  const frames: SseFrame[] = [];
  for (const block of blocks) {
    const frame = parseBlock(block);
    if (frame) frames.push(frame);
  }

  return { frames, rest: trailing + pending };
}

function parseBlock(block: string): SseFrame | null {
  let event = "message";
  const data: string[] = [];

  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      // The SSE spec strips exactly one leading space, not all whitespace.
      data.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }

  if (data.length === 0) return null;

  try {
    return { event, data: JSON.parse(data.join("\n")) };
  } catch {
    // A malformed payload costs one frame, not the rest of the stream.
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --dir apps/web vitest run src/lib/sse.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/sse.ts apps/web/src/lib/sse.test.ts
git commit -m "feat(web): add frame-based SSE reader for the assistant stream"
```

---

### Task 3: Assistant types

**Files:**
- Modify: `apps/web/src/lib/types.ts` (append near the `ModelConnectionStatus` block at `:186`; update `StageDocumentOut` at `:256`)

**Interfaces:**
- Consumes: Task 1's `id` field on the stage-document response.
- Produces: `Citation`, `CitationSource`, `LineageAgentRun`, `LineageFacts`, and `StageDocumentOut.id`. Tasks 4-8 all import these.

- [ ] **Step 1: Add the types**

Append to `apps/web/src/lib/types.ts`:

```ts
// RAG assistant (apps/cloud/app/api/assistant.py, ADR 0011).
//
// One Citation type covers all three retrieval kinds, discriminated by
// `source` (schemas.py:610). "vector" is a retrieved embedding chunk;
// "graph" is a whole-node reference from the exact lineage walk, where
// chunk_index is meaningless and always 0; "code" is a fetch-on-demand code
// chunk, and repo/path/start_line/end_line are set only for that kind — the
// code text itself is never persisted (ADR 0011: no source at rest).
export type CitationSource = "vector" | "graph" | "code";

export interface Citation {
  node_type: string;
  node_id: string;
  chunk_index: number;
  source: CitationSource;
  // Required, not optional: the cloud serializes with `model_dump()` and no
  // `exclude_none`/`exclude_unset` (app/api/assistant.py:265,298,301,303), so
  // every key is always on the wire — `null` on a non-code citation, never
  // absent.
  repo: string | null;
  path: string | null;
  start_line: number | null;
  end_line: number | null;
}

export interface LineageAgentRun {
  id: string;
  status: AgentRunStatus;
}

// Computed by a graph walk (app/rag/lineage.py), not generated by a model —
// which is why the panel renders it as its own card rather than as prose.
// Which fields are populated depends on `scope`, so zero values are
// "not applicable here", not "none of them".
export interface LineageFacts {
  scope: "requirement" | "task" | "project";
  node_type: string | null;
  node_id: string | null;
  title: string;
  status: string | null;
  specs_total: number;
  tasks_total: number;
  tasks_done: number;
  task_status_counts: Record<string, number>;
  artifacts_total: number;
  agent_runs: LineageAgentRun[];
}
```

Then update the existing interface at `:256`:

```ts
export interface StageDocumentOut {
  // null until a document has been saved for this stage.
  id: string | null;
  stage: StageKind;
  content: string;
  updated_at: string | null;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --dir apps/web tsc --noEmit`
Expected: PASS. `Planner.tsx` reads `.content` and `.updated_at` from `getStageDocument` and never constructs a `StageDocumentOut` literal, so adding a required field does not break it. If the typecheck does report an error in `Planner.tsx`, stop and report it rather than editing that file — it is out of scope per the Global Constraints.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/types.ts
git commit -m "feat(web): add assistant citation and lineage-facts types"
```

---

### Task 4: Node label resolution

`useNodeLabels` currently lives inside `DiscussionThread.tsx` and covers four node types. Citations can reference seven. This task extracts it and adds citation-specific labeling.

**Files:**
- Create: `apps/web/src/lib/node-labels.ts`
- Modify: `apps/web/src/components/project/DiscussionThread.tsx` (delete the local `useNodeLabels` at `:16-27`, import from the new module)
- Test: `apps/web/src/lib/node-labels.test.ts`

**Interfaces:**
- Consumes: `Citation` from Task 3.
- Produces:
  ```ts
  export type NodeLabels = Map<string, string>;
  export function useNodeLabels(graph: ProjectGraph): NodeLabels;
  export function citationLabel(
    citation: Citation,
    labels: NodeLabels,
    documentTitles: Map<string, string>,   // document id -> title
    stageNames: Map<string, string>,       // stage-document id -> stage name
  ): { kind: string; text: string };
  ```
  Task 6's `CitationList` calls `citationLabel`. Task 7 passes the maps down.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/node-labels.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { citationLabel } from "./node-labels";
import type { Citation, NodeLabels } from "./node-labels";

const labels: NodeLabels = new Map([
  ["requirements:r1", "Requirement: Login must support SSO"],
  ["tasks:t1", "Task: Wire the OAuth callback"],
]);

// repo/path/start_line/end_line are required-and-nullable on Citation, so the
// base object must supply them explicitly — `Partial` overrides layer on top.
function cite(over: Partial<Citation>): Citation {
  return {
    node_type: "requirements",
    node_id: "r1",
    chunk_index: 0,
    source: "vector",
    repo: null,
    path: null,
    start_line: null,
    end_line: null,
    ...over,
  };
}

describe("citationLabel", () => {
  it("uses the graph label for a graph-backed node type", () => {
    expect(citationLabel(cite({}), labels, new Map(), new Map())).toEqual({
      kind: "requirement",
      text: "Login must support SSO",
    });
  });

  it("labels a task from the graph", () => {
    const c = cite({ node_type: "tasks", node_id: "t1" });
    expect(citationLabel(c, labels, new Map(), new Map()).text).toBe("Wire the OAuth callback");
  });

  it("resolves an uploaded document from the document title map", () => {
    const c = cite({ node_type: "documents", node_id: "d1" });
    const docs = new Map([["d1", "PRD-v2.pdf"]]);
    expect(citationLabel(c, labels, docs, new Map())).toEqual({
      kind: "document",
      text: "PRD-v2.pdf",
    });
  });

  it("resolves a stage document to its stage name", () => {
    const c = cite({ node_type: "stage_documents", node_id: "s1" });
    const stages = new Map([["s1", "specify"]]);
    expect(citationLabel(c, labels, new Map(), stages)).toEqual({
      kind: "planning doc",
      text: "specify",
    });
  });

  it("renders a code citation as path and line range", () => {
    const c = cite({
      node_type: "code",
      node_id: "c1",
      source: "code",
      repo: "acme/api",
      path: "app/api/auth.py",
      start_line: 40,
      end_line: 72,
    });
    expect(citationLabel(c, labels, new Map(), new Map())).toEqual({
      kind: "code",
      text: "acme/api · app/api/auth.py:40-72",
    });
  });

  it("degrades an unresolvable node to its type and a short id", () => {
    const c = cite({ node_type: "pull_requests", node_id: "4a91c2ff-0000-0000-0000-000000000000" });
    expect(citationLabel(c, labels, new Map(), new Map())).toEqual({
      kind: "pull request",
      text: "4a91c2ff",
    });
  });

  it("degrades a graph type whose node is missing from the graph", () => {
    const c = cite({ node_id: "gone-1234-5678" });
    expect(citationLabel(c, labels, new Map(), new Map()).text).toBe("gone-123");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --dir apps/web vitest run src/lib/node-labels.test.ts`
Expected: FAIL — `Failed to resolve import "./node-labels"`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/lib/node-labels.ts`:

```ts
"use client";

// (nodeType, nodeId) -> human label. Lifted out of DiscussionThread so the
// assistant panel's citation chips can reuse it instead of building a second
// map, and extended to the node types RAG_NODE_TYPES can cite
// (apps/cloud/app/rag/source.py:43) but ProjectGraph does not carry.

import { useMemo } from "react";
import type { Citation, ProjectGraph } from "./types";

export type { Citation };
export type NodeLabels = Map<string, string>;

export function useNodeLabels(graph: ProjectGraph): NodeLabels {
  return useMemo(() => {
    const labels: NodeLabels = new Map();
    for (const r of graph.requirements)
      labels.set(`requirements:${r.id}`, `Requirement: ${r.title}`);
    for (const s of graph.spec_documents) labels.set(`spec_documents:${s.id}`, `Spec v${s.version}`);
    for (const t of graph.tasks) labels.set(`tasks:${t.id}`, `Task: ${t.title}`);
    for (const a of graph.artifacts) labels.set(`artifacts:${a.id}`, `Artifact: ${a.uri}`);
    for (const d of graph.discussions) labels.set(`discussions:${d.id}`, `Comment by ${d.author}`);
    return labels;
  }, [graph]);
}

// Reader-facing name for each node_type a citation can carry.
const KIND: Record<string, string> = {
  requirements: "requirement",
  spec_documents: "spec",
  tasks: "task",
  discussions: "comment",
  documents: "document",
  stage_documents: "planning doc",
  pull_requests: "pull request",
  code: "code",
};

// The graph labels carry a "Requirement: " / "Task: " style prefix for the
// discussion picker's flat <select>. Chips already show the kind separately,
// so strip it rather than rendering "requirement · Requirement: …".
function stripPrefix(label: string): string {
  const idx = label.indexOf(": ");
  return idx === -1 ? label : label.slice(idx + 2);
}

export function citationLabel(
  citation: Citation,
  labels: NodeLabels,
  documentTitles: Map<string, string>,
  stageNames: Map<string, string>,
): { kind: string; text: string } {
  const kind = KIND[citation.node_type] ?? citation.node_type;

  if (citation.source === "code") {
    const range =
      citation.start_line != null && citation.end_line != null
        ? `:${citation.start_line}-${citation.end_line}`
        : "";
    const path = citation.path ?? citation.node_id;
    return { kind: "code", text: citation.repo ? `${citation.repo} · ${path}${range}` : `${path}${range}` };
  }

  if (citation.node_type === "documents") {
    const title = documentTitles.get(citation.node_id);
    if (title) return { kind, text: title };
  }

  if (citation.node_type === "stage_documents") {
    const stage = stageNames.get(citation.node_id);
    if (stage) return { kind, text: stage };
  }

  const label = labels.get(`${citation.node_type}:${citation.node_id}`);
  if (label) return { kind, text: stripPrefix(label) };

  // Nothing resolved it — a shortened id still lets someone match it against
  // an API response, which a truncated UUID prefix does well enough.
  return { kind, text: citation.node_id.slice(0, 8) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --dir apps/web vitest run src/lib/node-labels.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Update DiscussionThread to use the extracted hook**

In `apps/web/src/components/project/DiscussionThread.tsx`, delete the local `useNodeLabels` function together with the three-line comment block above it (`// (nodeType, nodeId) -> human label…` through the closing brace of the function, `:13-27`), and drop `useMemo` from the `react` import — keep `useState`, which `ComposeBox` already uses. Then add:

```ts
import { useNodeLabels } from "@/lib/node-labels";
```

Then make one behavioral fix in `ComposeBox`, because the extended hook now feeds two consumers with different needs — citation chips need `discussions` labels, this picker must not offer them as targets:

```ts
    // A comment cannot parent a comment: the cloud rejects it with 422
    // invalid_parent_node_type (_VALID_PARENT_TYPES, app/api/discussions.py:30).
    const options = [...labels.entries()].filter(([key]) => !key.startsWith("discussions:"));
```

Add a test locking this in — render `DiscussionThread` with a graph carrying at least one task and one discussion, assert the compose `<select>` offers the task and offers nothing sourced from a discussion.

Leave everything else in that file unchanged.

- [ ] **Step 6: Verify nothing regressed**

Run: `pnpm --dir apps/web vitest run && pnpm --dir apps/web tsc --noEmit`
Expected: PASS. The discussion tests must still pass — the label map's behavior is unchanged for the four types they exercise.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/node-labels.ts apps/web/src/lib/node-labels.test.ts \
        apps/web/src/components/project/DiscussionThread.tsx
git commit -m "refactor(web): extract node-label resolution and extend it for citations"
```

---

### Task 5: The chat hook

**Files:**
- Create: `apps/web/src/components/project/useAssistantChat.ts`
- Test: `apps/web/src/components/project/useAssistantChat.test.ts`

**Interfaces:**
- Consumes: `parseFrames` (Task 2); `Citation`, `LineageFacts` (Task 3).
- Produces:
  ```ts
  export type AssistantErrorKind = "no_model" | "embed_mismatch" | "budget" | "cut_off" | "other";
  export interface AssistantError { kind: AssistantErrorKind; message: string }
  export interface Turn {
    id: number;
    question: string;
    facts: LineageFacts | null;
    answer: string;
    citations: Citation[];
    status: "streaming" | "done" | "error";
    error: AssistantError | null;
  }
  export function useAssistantChat(projectId: string): {
    turns: Turn[];
    busy: boolean;
    ask: (question: string) => Promise<void>;
    retry: (turnId: number) => Promise<void>;
    reset: () => void;
  };
  ```
  Tasks 6 and 7 consume `Turn` and `AssistantError`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/project/useAssistantChat.test.ts`:

```ts
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAssistantChat } from "./useAssistantChat";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ Authorization: "Bearer test" }) }),
}));

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

// Frames, not lines. apps/cloud/app/api/assistant.py terminates every frame
// with a blank line; joining with a single "\n" (as useStageGeneration.test.ts
// does for the other endpoint) would produce zero complete frames here.
function sseBody(...frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f + "\n\n"));
      controller.close();
    },
  });
}

function mockStream(...frames: string[]) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    body: sseBody(...frames),
  }) as unknown as typeof fetch;
}

function mockFailure(status: number, detail: string) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({ detail }),
  }) as unknown as typeof fetch;
}

describe("useAssistantChat", () => {
  it("accumulates deltas into one turn and records citations", async () => {
    mockStream(
      'data: {"delta":"Two of "}',
      'data: {"delta":"four tasks."}',
      'event: citations\ndata: {"citations":[{"node_type":"tasks","node_id":"t1","chunk_index":0,"source":"vector"}]}',
    );

    const { result } = renderHook(() => useAssistantChat("p1"));
    await act(async () => {
      await result.current.ask("how is it going?");
    });

    const turn = result.current.turns[0];
    expect(turn.question).toBe("how is it going?");
    expect(turn.answer).toBe("Two of four tasks.");
    expect(turn.citations).toHaveLength(1);
    expect(turn.status).toBe("done");
  });

  it("stores lineage facts from the facts frame", async () => {
    mockStream(
      'event: facts\ndata: {"scope":"requirement","node_type":"requirements","node_id":"r1","title":"Login","status":"in_progress","specs_total":2,"tasks_total":4,"tasks_done":2,"task_status_counts":{"todo":1},"artifacts_total":3,"agent_runs":[]}',
      'data: {"delta":"Two of four."}',
    );

    const { result } = renderHook(() => useAssistantChat("p1"));
    await act(async () => {
      await result.current.ask("status?");
    });

    expect(result.current.turns[0].facts?.title).toBe("Login");
    expect(result.current.turns[0].facts?.tasks_done).toBe(2);
  });

  it("treats the budget-exhausted-with-facts stream as a success, not an error", async () => {
    // apps/cloud/app/api/assistant.py:267-282 — 200 with a canned delta.
    mockStream(
      'event: facts\ndata: {"scope":"task","node_type":"tasks","node_id":"t1","title":"T","status":"todo","specs_total":0,"tasks_total":0,"tasks_done":0,"task_status_counts":{},"artifacts_total":0,"agent_runs":[]}',
      'data: {"delta":"Daily assistant budget reached — showing lineage facts only."}',
      'event: citations\ndata: {"citations":[]}',
    );

    const { result } = renderHook(() => useAssistantChat("p1"));
    await act(async () => {
      await result.current.ask("status?");
    });

    expect(result.current.turns[0].status).toBe("done");
    expect(result.current.turns[0].error).toBeNull();
    expect(result.current.turns[0].facts).not.toBeNull();
  });

  it("classifies a missing model connection", async () => {
    mockFailure(400, "model_connection_not_configured");
    const { result } = renderHook(() => useAssistantChat("p1"));
    await act(async () => {
      await result.current.ask("x");
    });
    expect(result.current.turns[0].error?.kind).toBe("no_model");
    expect(result.current.turns[0].status).toBe("error");
  });

  it("classifies an embed-model mismatch from the detail prefix", async () => {
    // The 409 detail is a full sentence, not a bare identifier
    // (apps/cloud/app/api/assistant.py:243-252) — matching must be by prefix.
    mockFailure(
      409,
      "embed_model_mismatch: this project's chunks were embedded with 'a'; reindex required before switching to 'b' (POST /projects/p1/assistant/reindex)",
    );
    const { result } = renderHook(() => useAssistantChat("p1"));
    await act(async () => {
      await result.current.ask("x");
    });
    expect(result.current.turns[0].error?.kind).toBe("embed_mismatch");
  });

  it("classifies the hard budget rejection", async () => {
    mockFailure(429, "daily_token_budget_exceeded");
    const { result } = renderHook(() => useAssistantChat("p1"));
    await act(async () => {
      await result.current.ask("x");
    });
    expect(result.current.turns[0].error?.kind).toBe("budget");
  });

  it("keeps partial text and flags a stream that ended without citations", async () => {
    mockStream('data: {"delta":"half an ans"}');
    const { result } = renderHook(() => useAssistantChat("p1"));
    await act(async () => {
      await result.current.ask("x");
    });
    expect(result.current.turns[0].answer).toBe("half an ans");
    expect(result.current.turns[0].status).toBe("error");
    expect(result.current.turns[0].error?.kind).toBe("cut_off");
  });

  it("is busy while streaming and idle afterwards", async () => {
    // The stream is held open on a gate so `busy` can be observed mid-flight;
    // asserting it only before and after would pass even if it never flipped.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encoder = new TextEncoder();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode('data: {"delta":"a"}\n\n'));
          await gate;
          controller.enqueue(encoder.encode('event: citations\ndata: {"citations":[]}\n\n'));
          controller.close();
        },
      }),
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useAssistantChat("p1"));
    expect(result.current.busy).toBe(false);

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.ask("x");
    });
    await waitFor(() => expect(result.current.busy).toBe(true));

    await act(async () => {
      release();
      await pending;
    });
    expect(result.current.busy).toBe(false);
  });

  it("clears turns on reset", async () => {
    mockStream('data: {"delta":"a"}', 'event: citations\ndata: {"citations":[]}');
    const { result } = renderHook(() => useAssistantChat("p1"));
    await act(async () => {
      await result.current.ask("x");
    });
    act(() => result.current.reset());
    expect(result.current.turns).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --dir apps/web vitest run src/components/project/useAssistantChat.test.ts`
Expected: FAIL — `Failed to resolve import "./useAssistantChat"`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/components/project/useAssistantChat.ts`:

```ts
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { CLOUD_API_URL } from "@/lib/config";
import { parseFrames } from "@/lib/sse";
import type { Citation, LineageFacts } from "@/lib/types";

export type AssistantErrorKind = "no_model" | "embed_mismatch" | "budget" | "cut_off" | "other";

export interface AssistantError {
  kind: AssistantErrorKind;
  message: string;
}

export interface Turn {
  id: number;
  question: string;
  facts: LineageFacts | null;
  answer: string;
  citations: Citation[];
  status: "streaming" | "done" | "error";
  error: AssistantError | null;
}

// The 400 and 429 details are bare identifiers, but the 409's is a full
// sentence beginning "embed_model_mismatch:" (app/api/assistant.py:243-252).
// Matching by equality would drop it into the generic branch and lose the
// reindex affordance, which is the only reason that branch exists.
function classify(status: number, detail: string): AssistantError {
  if (detail.startsWith("model_connection_not_configured")) {
    return { kind: "no_model", message: "No model is connected for this workspace." };
  }
  if (detail.startsWith("embed_model_mismatch")) {
    return {
      kind: "embed_mismatch",
      message: "This project was indexed with a different embedding model.",
    };
  }
  if (detail.startsWith("daily_token_budget_exceeded")) {
    return { kind: "budget", message: "Daily assistant budget reached. Try again tomorrow." };
  }
  return { kind: "other", message: detail || `Request failed (${status}).` };
}

export function useAssistantChat(projectId: string) {
  const { authHeaders } = useAuth();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const nextId = useRef(0);
  const abort = useRef<AbortController | null>(null);

  // Closing the panel or navigating away stops the read. The server keeps
  // generating and still bills for it — this only stops us listening.
  useEffect(() => () => abort.current?.abort(), []);

  const patch = useCallback((id: number, change: Partial<Turn>) => {
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...change } : t)));
  }, []);

  const run = useCallback(
    async (turnId: number, question: string) => {
      setBusy(true);
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;

      try {
        const res = await fetch(`${CLOUD_API_URL}/projects/${projectId}/assistant/chat`, {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders() },
          body: JSON.stringify({ question }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => ({}));
          const detail = (body as { detail?: string }).detail ?? "";
          patch(turnId, { status: "error", error: classify(res.status, detail) });
          return;
        }

        const reader = res.body.getReader();
        // stream: true is what makes a multi-byte character split across two
        // network chunks decode correctly rather than as replacement chars.
        const decoder = new TextDecoder();
        let buf = "";
        let answer = "";
        let sawCitations = false;

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const { frames, rest } = parseFrames(buf);
          buf = rest;

          for (const frame of frames) {
            if (frame.event === "facts") {
              patch(turnId, { facts: frame.data as LineageFacts });
            } else if (frame.event === "message") {
              const delta = (frame.data as { delta?: string }).delta;
              if (delta) {
                answer += delta;
                patch(turnId, { answer });
              }
            } else if (frame.event === "citations") {
              sawCitations = true;
              patch(turnId, {
                citations: (frame.data as { citations: Citation[] }).citations ?? [],
              });
            }
            // Unknown event kinds are ignored so a newer server degrades this
            // tab to prose instead of breaking it.
          }
        }

        if (sawCitations) {
          patch(turnId, { status: "done" });
        } else {
          // The citations frame is the stream's only completion marker. Its
          // absence means the generator died mid-body — keep what arrived.
          patch(turnId, {
            status: "error",
            error: { kind: "cut_off", message: "The answer was cut off." },
          });
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        patch(turnId, {
          status: "error",
          error: { kind: "other", message: (err as Error).message || "Network error." },
        });
      } finally {
        setBusy(false);
      }
    },
    [projectId, authHeaders, patch],
  );

  const ask = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (!trimmed) return;
      const id = nextId.current++;
      setTurns((prev) => [
        ...prev,
        {
          id,
          question: trimmed,
          facts: null,
          answer: "",
          citations: [],
          status: "streaming",
          error: null,
        },
      ]);
      await run(id, trimmed);
    },
    [run],
  );

  const retry = useCallback(
    async (turnId: number) => {
      let question = "";
      setTurns((prev) =>
        prev.map((t) => {
          if (t.id !== turnId) return t;
          question = t.question;
          return { ...t, facts: null, answer: "", citations: [], status: "streaming", error: null };
        }),
      );
      if (question) await run(turnId, question);
    },
    [run],
  );

  const reset = useCallback(() => {
    abort.current?.abort();
    setTurns([]);
  }, []);

  return { turns, busy, ask, retry, reset };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --dir apps/web vitest run src/components/project/useAssistantChat.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/project/useAssistantChat.ts \
        apps/web/src/components/project/useAssistantChat.test.ts
git commit -m "feat(web): add the assistant chat hook over the SSE endpoint"
```

---

### Task 6: Fact card and citation list

**Files:**
- Create: `apps/web/src/components/project/AssistantFactCard.tsx`
- Create: `apps/web/src/components/project/CitationList.tsx`
- Test: `apps/web/src/components/project/AssistantFactCard.test.tsx`
- Test: `apps/web/src/components/project/CitationList.test.tsx`

**Interfaces:**
- Consumes: `LineageFacts`, `Citation` (Task 3); `citationLabel`, `NodeLabels` (Task 4).
- Produces:
  ```tsx
  export function AssistantFactCard({ facts }: { facts: LineageFacts }): React.JSX.Element;
  export function CitationList(props: {
    citations: Citation[];
    labels: NodeLabels;
    documentTitles: Map<string, string>;
    stageNames: Map<string, string>;
  }): React.JSX.Element | null;
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/project/AssistantFactCard.test.tsx`:

```tsx
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AssistantFactCard } from "./AssistantFactCard";
import type { LineageFacts } from "@/lib/types";

function facts(over: Partial<LineageFacts> = {}): LineageFacts {
  return {
    scope: "requirement",
    node_type: "requirements",
    node_id: "r1",
    title: "Login must support SSO",
    status: "in_progress",
    specs_total: 2,
    tasks_total: 4,
    tasks_done: 2,
    task_status_counts: { todo: 1, in_progress: 1, verified: 2 },
    artifacts_total: 3,
    agent_runs: [{ id: "a1", status: "failed" }],
    ...over,
  };
}

describe("AssistantFactCard", () => {
  it("shows the title and status", () => {
    render(<AssistantFactCard facts={facts()} />);
    expect(screen.getByText("Login must support SSO")).toBeInTheDocument();
    expect(screen.getByText(/in_progress/)).toBeInTheDocument();
  });

  it("marks the card as coming from the graph, not the model", () => {
    render(<AssistantFactCard facts={facts()} />);
    expect(screen.getByText(/from the task graph/i)).toBeInTheDocument();
  });

  it("renders the task counts", () => {
    render(<AssistantFactCard facts={facts()} />);
    expect(screen.getByText(/2 specs · 4 tasks · 2 done · 3 artifacts/)).toBeInTheDocument();
  });

  it("omits zero-valued fields rather than printing 0", () => {
    render(
      <AssistantFactCard
        facts={facts({ specs_total: 0, artifacts_total: 0, agent_runs: [], task_status_counts: {} })}
      />,
    );
    expect(screen.queryByText(/specs/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/artifacts/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/agent runs?/i)).not.toBeInTheDocument();
  });

  it("omits the status line when status is null", () => {
    render(<AssistantFactCard facts={facts({ status: null })} />);
    expect(screen.queryByText(/status/i)).not.toBeInTheDocument();
  });
});
```

Create `apps/web/src/components/project/CitationList.test.tsx`:

```tsx
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CitationList } from "./CitationList";
import type { Citation } from "@/lib/types";
import type { NodeLabels } from "@/lib/node-labels";

const labels: NodeLabels = new Map([["tasks:t1", "Task: Wire the OAuth callback"]]);

const empty = new Map<string, string>();

// repo/path/start_line/end_line are required-and-nullable on Citation, so the
// base object must supply them explicitly — `Partial` overrides layer on top.
function cite(over: Partial<Citation>): Citation {
  return {
    node_type: "tasks",
    node_id: "t1",
    chunk_index: 0,
    source: "vector",
    repo: null,
    path: null,
    start_line: null,
    end_line: null,
    ...over,
  };
}

describe("CitationList", () => {
  it("renders nothing when there are no citations", () => {
    const { container } = render(
      <CitationList citations={[]} labels={labels} documentTitles={empty} stageNames={empty} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("dedupes the same node cited at several chunk indexes", () => {
    render(
      <CitationList
        citations={[cite({ chunk_index: 0 }), cite({ chunk_index: 1 }), cite({ chunk_index: 2 })]}
        labels={labels}
        documentTitles={empty}
        stageNames={empty}
      />,
    );
    expect(screen.getAllByText("Wire the OAuth callback")).toHaveLength(1);
  });

  it("orders code citations after graph citations", () => {
    render(
      <CitationList
        citations={[
          cite({ node_type: "code", node_id: "c1", source: "code", path: "a.py", start_line: 1, end_line: 5 }),
          cite({}),
        ]}
        labels={labels}
        documentTitles={empty}
        stageNames={empty}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Wire the OAuth callback");
    expect(items[1]).toHaveTextContent("a.py:1-5");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --dir apps/web vitest run src/components/project/AssistantFactCard.test.tsx src/components/project/CitationList.test.tsx`
Expected: FAIL — unresolved imports.

- [ ] **Step 3: Write AssistantFactCard**

Create `apps/web/src/components/project/AssistantFactCard.tsx`:

```tsx
"use client";

// Exact counts from the lineage graph walk (apps/cloud/app/rag/lineage.py) —
// not model output. Rendered as its own card so a reader can tell which part
// of the answer is computed and which part is generated.
//
// Which fields a walk populates depends on its scope, so a zero means "not
// applicable to this scope", not "none". Printing zeros makes a valid
// project-scope card look broken, so they are omitted.

import type { LineageFacts } from "@/lib/types";

export function AssistantFactCard({ facts }: { facts: LineageFacts }) {
  const counts: string[] = [];
  if (facts.specs_total > 0) counts.push(`${facts.specs_total} specs`);
  if (facts.tasks_total > 0) counts.push(`${facts.tasks_total} tasks`);
  if (facts.tasks_done > 0) counts.push(`${facts.tasks_done} done`);
  if (facts.artifacts_total > 0) counts.push(`${facts.artifacts_total} artifacts`);

  const breakdown = Object.entries(facts.task_status_counts).filter(([, n]) => n > 0);
  const failedRuns = facts.agent_runs.filter((r) => r.status === "failed").length;

  return (
    <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm">
      <p className="text-xs uppercase tracking-wide text-slate-500">from the task graph</p>
      <p className="mt-1 font-medium text-slate-900">{facts.title}</p>
      {facts.status && <p className="text-xs text-slate-600">status · {facts.status}</p>}

      {counts.length > 0 && <p className="mt-2 text-slate-700">{counts.join(" · ")}</p>}

      {breakdown.length > 0 && (
        <p className="mt-1 text-xs text-slate-600">
          {breakdown.map(([status, n]) => `${status} ${n}`).join(" · ")}
        </p>
      )}

      {facts.agent_runs.length > 0 && (
        <p className="mt-1 text-xs text-slate-600">
          {facts.agent_runs.length} agent runs
          {failedRuns > 0 && ` · ${failedRuns} failed`}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Write CitationList**

Create `apps/web/src/components/project/CitationList.tsx`:

```tsx
"use client";

// Sources behind an answer. Chips are labels, not links: the graph types would
// need selection props threaded into GraphBrowser and TaskBoard, and code
// chips are deferred rather than impossible — Citation carries repo/path/lines
// precisely so a client can link to the Git host later.

import { citationLabel, type NodeLabels } from "@/lib/node-labels";
import type { Citation } from "@/lib/types";

export function CitationList({
  citations,
  labels,
  documentTitles,
  stageNames,
}: {
  citations: Citation[];
  labels: NodeLabels;
  documentTitles: Map<string, string>;
  stageNames: Map<string, string>;
}) {
  if (citations.length === 0) return null;

  // vector_search runs at top_k=8, so one node commonly comes back at several
  // chunk indexes. To a reader that is one source, not three.
  const seen = new Set<string>();
  const unique = citations.filter((c) => {
    const key = `${c.node_type}:${c.node_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const ordered = [
    ...unique.filter((c) => c.source !== "code"),
    ...unique.filter((c) => c.source === "code"),
  ];

  return (
    <div className="mt-2">
      <p className="text-xs uppercase tracking-wide text-slate-500">Sources</p>
      <ul className="mt-1 flex flex-col gap-1">
        {ordered.map((c) => {
          const { kind, text } = citationLabel(c, labels, documentTitles, stageNames);
          return (
            <li key={`${c.node_type}:${c.node_id}`} className="text-xs text-slate-600">
              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-700">
                {kind}
              </span>{" "}
              {text}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --dir apps/web vitest run src/components/project/AssistantFactCard.test.tsx src/components/project/CitationList.test.tsx`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/project/AssistantFactCard.tsx \
        apps/web/src/components/project/AssistantFactCard.test.tsx \
        apps/web/src/components/project/CitationList.tsx \
        apps/web/src/components/project/CitationList.test.tsx
git commit -m "feat(web): add the assistant fact card and citation list"
```

---

### Task 7: The panel, and wiring it into the Discussion tab

**Files:**
- Create: `apps/web/src/components/project/AssistantPanel.tsx`
- Modify: `apps/web/src/components/project/DiscussionThread.tsx` (add the `[Ask]` trigger and the panel; accept a new `workspaceId` prop)
- Modify: `apps/web/src/app/w/[workspaceId]/p/[projectId]/page.tsx:81-83` (pass `workspaceId` to `DiscussionThread`)
- Test: `apps/web/src/components/project/AssistantPanel.test.tsx`

**Interfaces:**
- Consumes: `useAssistantChat`, `Turn`, `AssistantError` (Task 5); `AssistantFactCard`, `CitationList` (Task 6); `useNodeLabels` (Task 4); `listDocuments`, `getStageDocument` (existing, `lib/api.ts`).
- Produces:
  ```tsx
  export function AssistantPanel(props: {
    open: boolean;
    onClose: () => void;
    graph: ProjectGraph;
    workspaceId: string;
    projectId: string;
  }): React.JSX.Element | null;
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/project/AssistantPanel.test.tsx`:

```tsx
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantPanel } from "./AssistantPanel";
import type { ProjectGraph } from "@/lib/types";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ Authorization: "Bearer test" }) }),
}));

vi.mock("@/lib/api", () => ({
  listDocuments: vi.fn().mockResolvedValue([]),
  getStageDocument: vi.fn().mockResolvedValue({ id: null, stage: "specify", content: "", updated_at: null }),
}));

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  vi.clearAllMocks();
});

const graph = {
  project: { id: "p1", name: "Proj" },
  requirements: [],
  spec_documents: [],
  tasks: [],
  artifacts: [],
  agent_runs: [],
  discussions: [],
} as unknown as ProjectGraph;

function sseBody(...frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f + "\n\n"));
      controller.close();
    },
  });
}

function panel(open = true) {
  return render(
    <AssistantPanel
      open={open}
      onClose={vi.fn()}
      graph={graph}
      workspaceId="w1"
      projectId="p1"
    />,
  );
}

describe("AssistantPanel", () => {
  it("renders nothing when closed", () => {
    const { container } = panel(false);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the empty state before any question", () => {
    panel();
    expect(screen.getByText(/grounded in this project/i)).toBeInTheDocument();
  });

  it("streams an answer and shows its citations", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: sseBody(
        'data: {"delta":"Two of four."}',
        'event: citations\ndata: {"citations":[{"node_type":"pull_requests","node_id":"4a91c2ff-aaaa","chunk_index":0,"source":"vector"}]}',
      ),
    }) as unknown as typeof fetch;

    panel();
    await userEvent.type(screen.getByRole("textbox"), "how is it going?");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(screen.getByText("Two of four.")).toBeInTheDocument());
    expect(screen.getByText("pull request")).toBeInTheDocument();
  });

  it("offers a workspace settings link when no model is connected", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ detail: "model_connection_not_configured" }),
    }) as unknown as typeof fetch;

    panel();
    await userEvent.type(screen.getByRole("textbox"), "x");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() =>
      expect(screen.getByText(/no model is connected/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: /workspace settings/i })).toHaveAttribute(
      "href",
      "/w/w1/settings",
    );
  });

  it("deep-links to the reindex section on an embed-model mismatch", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ detail: "embed_model_mismatch: this project's chunks were embedded with 'a'" }),
    }) as unknown as typeof fetch;

    panel();
    await userEvent.type(screen.getByRole("textbox"), "x");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() =>
      expect(screen.getByRole("link", { name: /reindex/i })).toHaveAttribute(
        "href",
        "/w/w1/p/p1/settings#assistant-index",
      ),
    );
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(
      <AssistantPanel open onClose={onClose} graph={graph} workspaceId="w1" projectId="p1" />,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
```

If `@testing-library/user-event` is not already a dependency, add it: `pnpm --dir apps/web add -D @testing-library/user-event`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --dir apps/web vitest run src/components/project/AssistantPanel.test.tsx`
Expected: FAIL — `Failed to resolve import "./AssistantPanel"`.

- [ ] **Step 3: Write the panel**

Create `apps/web/src/components/project/AssistantPanel.tsx`:

```tsx
"use client";

// Project-scoped RAG assistant (ADR 0011). Answers are ephemeral: they live
// here for the session and are cleared on close. Nothing is posted to the
// discussion thread — an assistant answer stored as a Discussion row would be
// embedded back into the project's own corpus by app/rag/queue.py.
//
// Every request is single-turn: ChatRequest is {question} with no history
// field (app/models/schemas.py:626), so the transcript below is display state
// only and pronoun follow-ups will be answered without prior context.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { getStageDocument, listDocuments } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useNodeLabels } from "@/lib/node-labels";
import type { ProjectGraph, StageKind } from "@/lib/types";
import { AssistantFactCard } from "./AssistantFactCard";
import { CitationList } from "./CitationList";
import { useAssistantChat, type AssistantError, type Turn } from "./useAssistantChat";

const STAGES: StageKind[] = ["constitution", "specify", "plan", "tasks"];

function ErrorBlock({
  error,
  workspaceId,
  projectId,
  onRetry,
}: {
  error: AssistantError;
  workspaceId: string;
  projectId: string;
  onRetry: () => void;
}) {
  return (
    <div className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
      <p>{error.message}</p>
      {error.kind === "no_model" && (
        <Link href={`/w/${workspaceId}/settings`} className="mt-1 inline-block underline">
          Workspace settings
        </Link>
      )}
      {error.kind === "embed_mismatch" && (
        <Link
          href={`/w/${workspaceId}/p/${projectId}/settings#assistant-index`}
          className="mt-1 inline-block underline"
        >
          Reindex this project
        </Link>
      )}
      {/* Retry only where retrying can plausibly change the outcome. A missing
          model, a mismatched index and an exhausted budget are all unchanged
          by asking again. */}
      {(error.kind === "other" || error.kind === "cut_off") && (
        <button type="button" onClick={onRetry} className="mt-1 block underline">
          Retry
        </button>
      )}
    </div>
  );
}

export function AssistantPanel({
  open,
  onClose,
  graph,
  workspaceId,
  projectId,
}: {
  open: boolean;
  onClose: () => void;
  graph: ProjectGraph;
  workspaceId: string;
  projectId: string;
}) {
  const { authHeaders } = useAuth();
  const labels = useNodeLabels(graph);
  const { turns, busy, ask, retry, reset } = useAssistantChat(projectId);
  const [question, setQuestion] = useState("");
  const [documentTitles, setDocumentTitles] = useState<Map<string, string>>(new Map());
  const [stageNames, setStageNames] = useState<Map<string, string>>(new Map());
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const resolved = useRef(false);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Neither documents nor stage documents are ProjectGraph members, so their
  // titles need their own fetches. Fired once, lazily, the first time a
  // citation actually needs them — not on open.
  const needsLookup = turns.some((t) =>
    t.citations.some((c) => c.node_type === "documents" || c.node_type === "stage_documents"),
  );

  useEffect(() => {
    if (!needsLookup || resolved.current) return;
    resolved.current = true;
    let cancelled = false;

    listDocuments(projectId, authHeaders())
      .then((docs) => {
        if (!cancelled) setDocumentTitles(new Map(docs.map((d) => [d.id, d.title])));
      })
      .catch(() => {
        // A failed lookup costs the chip its title, not the answer.
      });

    Promise.all(
      STAGES.map((stage) =>
        getStageDocument(projectId, stage, authHeaders())
          .then((doc) => [doc.id, stage] as const)
          .catch(() => [null, stage] as const),
      ),
    ).then((pairs) => {
      if (cancelled) return;
      const map = new Map<string, string>();
      for (const [id, stage] of pairs) if (id) map.set(id, stage);
      setStageNames(map);
    });

    return () => {
      cancelled = true;
    };
  }, [needsLookup, projectId, authHeaders]);

  const close = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = question;
    setQuestion("");
    await ask(q);
  }

  return (
    <aside
      role="dialog"
      aria-modal="true"
      aria-label="Project assistant"
      className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-slate-200 bg-white shadow-xl sm:w-[400px]"
    >
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">Ask about this project</h2>
        <button type="button" onClick={close} className="text-sm text-slate-500 hover:text-slate-900">
          Close
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3" aria-live="polite">
        {turns.length === 0 && (
          <p className="text-sm text-slate-500">
            Answers are grounded in this project&apos;s synced requirements, specs, tasks and
            planning documents.
          </p>
        )}

        <ul className="flex flex-col gap-4">
          {turns.map((turn: Turn) => (
            <li key={turn.id} className="flex flex-col gap-2">
              <p className="text-sm font-medium text-slate-900">{turn.question}</p>
              {turn.facts && <AssistantFactCard facts={turn.facts} />}
              {turn.answer && (
                <p className="whitespace-pre-wrap text-sm text-slate-700">{turn.answer}</p>
              )}
              {turn.error && (
                <ErrorBlock
                  error={turn.error}
                  workspaceId={workspaceId}
                  projectId={projectId}
                  onRetry={() => retry(turn.id)}
                />
              )}
              <CitationList
                citations={turn.citations}
                labels={labels}
                documentTitles={documentTitles}
                stageNames={stageNames}
              />
            </li>
          ))}
        </ul>
      </div>

      <form onSubmit={submit} className="border-t border-slate-200 p-3">
        <textarea
          ref={inputRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={2}
          disabled={busy}
          placeholder="Ask a self-contained question…"
          className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm disabled:bg-slate-50"
        />
        <button
          type="submit"
          disabled={busy || !question.trim()}
          className="mt-2 rounded bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {busy ? "Asking…" : "Send"}
        </button>
      </form>
    </aside>
  );
}
```

- [ ] **Step 4: Wire it into DiscussionThread**

In `apps/web/src/components/project/DiscussionThread.tsx`, add the import, the new prop, panel state, and the trigger:

```tsx
import { useState } from "react";
import { AssistantPanel } from "./AssistantPanel";
```

Change the component signature and body:

```tsx
export function DiscussionThread({
  graph,
  workspaceId,
  projectId,
  onPosted,
}: {
  graph: ProjectGraph;
  workspaceId: string;
  projectId: string;
  onPosted: () => void;
}) {
  const labels = useNodeLabels(graph);
  const [askOpen, setAskOpen] = useState(false);
  const sorted = [...graph.discussions].sort((a, b) =>
    (a.updated_at ?? "").localeCompare(b.updated_at ?? ""),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setAskOpen(true)}
          className="rounded border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 hover:border-slate-300"
        >
          Ask the assistant
        </button>
      </div>

      <ComposeBox graph={graph} labels={labels} projectId={projectId} onPosted={onPosted} />

      {/* …existing thread list, unchanged… */}

      <AssistantPanel
        open={askOpen}
        onClose={() => setAskOpen(false)}
        graph={graph}
        workspaceId={workspaceId}
        projectId={projectId}
      />
    </div>
  );
}
```

Keep the existing thread-list JSX exactly as it is — only the wrapper, the trigger, and the panel are new.

- [ ] **Step 5: Pass workspaceId from the project page**

In `apps/web/src/app/w/[workspaceId]/p/[projectId]/page.tsx:81-83`:

```tsx
            {tab === "Discussion" && (
              <DiscussionThread
                graph={graph}
                workspaceId={workspaceId}
                projectId={projectId}
                onPosted={refetch}
              />
            )}
```

`TaskBoard` on the line above already takes `workspaceId` the same way, so this matches the established shape.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `pnpm --dir apps/web vitest run && pnpm --dir apps/web tsc --noEmit`
Expected: PASS. If `DiscussionThread.test.tsx` exists and renders the component without `workspaceId`, add the prop to its render calls.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/project/AssistantPanel.tsx \
        apps/web/src/components/project/AssistantPanel.test.tsx \
        apps/web/src/components/project/DiscussionThread.tsx \
        "apps/web/src/app/w/[workspaceId]/p/[projectId]/page.tsx"
git commit -m "feat(web): add the assistant slide-over panel to the Discussion tab"
```

---

### Task 8: Admin hook and the reindex control

**Files:**
- Modify: `apps/web/src/lib/api.ts` (add `reindexProject`)
- Modify: `apps/web/src/lib/workspace.tsx` (add `useIsWorkspaceAdmin`)
- Modify: `apps/web/src/app/w/[workspaceId]/settings/page.tsx:18` (use the new hook)
- Modify: `apps/web/src/app/w/[workspaceId]/p/[projectId]/settings/page.tsx` (add the Assistant index section)
- Create: `apps/web/src/components/project/ReindexPanel.tsx`
- Test: `apps/web/src/components/project/ReindexPanel.test.tsx`

**Interfaces:**
- Consumes: `apiFetch` (existing).
- Produces:
  ```ts
  export function reindexProject(
    projectId: string,
    authHeaders: Record<string, string>,
  ): Promise<{ enqueued: number }>;
  export function useIsWorkspaceAdmin(workspaceId: string): boolean;
  export function ReindexPanel({ projectId }: { projectId: string }): React.JSX.Element;
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/project/ReindexPanel.test.tsx`:

```tsx
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReindexPanel } from "./ReindexPanel";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ Authorization: "Bearer test" }) }),
}));

const reindexProject = vi.fn();
vi.mock("@/lib/api", () => ({
  reindexProject: (...args: unknown[]) => reindexProject(...args),
}));

afterEach(() => vi.clearAllMocks());

describe("ReindexPanel", () => {
  it("asks for confirmation before spending on embeddings", async () => {
    render(<ReindexPanel projectId="p1" />);
    await userEvent.click(screen.getByRole("button", { name: /reindex project/i }));
    expect(reindexProject).not.toHaveBeenCalled();
    expect(screen.getByText(/one embedding call/i)).toBeInTheDocument();
  });

  it("reports the enqueued count using the server's number", async () => {
    reindexProject.mockResolvedValue({ enqueued: 142 });
    render(<ReindexPanel projectId="p1" />);
    await userEvent.click(screen.getByRole("button", { name: /reindex project/i }));
    await userEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    await waitFor(() => expect(screen.getByText(/142 items queued/i)).toBeInTheDocument());
  });

  it("surfaces a failure without claiming anything was queued", async () => {
    reindexProject.mockRejectedValue(new Error("forbidden"));
    render(<ReindexPanel projectId="p1" />);
    await userEvent.click(screen.getByRole("button", { name: /reindex project/i }));
    await userEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    await waitFor(() => expect(screen.getByText("forbidden")).toBeInTheDocument());
    expect(screen.queryByText(/queued/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir apps/web vitest run src/components/project/ReindexPanel.test.tsx`
Expected: FAIL — `Failed to resolve import "./ReindexPanel"`.

- [ ] **Step 3: Add the API function**

Append to `apps/web/src/lib/api.ts`:

```ts
// Enqueue-only: returns as soon as the embed jobs are queued, with no
// completion signal and no progress endpoint (apps/cloud/app/api/assistant.py).
// The UI must say "queued", never "indexed".
export function reindexProject(projectId: string, authHeaders: Record<string, string>) {
  return apiFetch<{ enqueued: number }>(`/projects/${projectId}/assistant/reindex`, authHeaders, {
    method: "POST",
  });
}
```

- [ ] **Step 4: Add the admin hook**

Append to `apps/web/src/lib/workspace.tsx`:

```tsx
// Whether the signed-in user administers this workspace. The server gates on
// this too (require_admin), so this only decides whether to *offer* a control —
// showing one to a member would just produce a 403 with worse copy.
export function useIsWorkspaceAdmin(workspaceId: string): boolean {
  const { user } = useAuth();
  const { data: members } = useCloudGet<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`);
  return !!members?.some((m) => m.user_id === user?.id && m.role === "admin");
}
```

Add the imports it needs at the top of that file:

```tsx
import { useCloudGet } from "./hooks";
import type { Workspace, WorkspaceMember } from "./types";
```

(`./hooks` imports `./api` and `./auth` only, so this introduces no import cycle.)

Then simplify `apps/web/src/app/w/[workspaceId]/settings/page.tsx:18` to use it, deleting the now-redundant `members` fetch and `user` reference if nothing else on that page uses them.

- [ ] **Step 5: Write ReindexPanel**

Create `apps/web/src/components/project/ReindexPanel.tsx`:

```tsx
"use client";

import { useState } from "react";
import { reindexProject } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export function ReindexPanel({ projectId }: { projectId: string }) {
  const { authHeaders } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [enqueued, setEnqueued] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    setEnqueued(null);
    try {
      const res = await reindexProject(projectId, authHeaders());
      setEnqueued(res.enqueued);
      setConfirming(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <section id="assistant-index" className="mt-10">
      <h2 className="text-lg font-medium text-slate-900">Assistant index</h2>
      <p className="mt-1 text-sm text-slate-600">
        Re-embeds this project&apos;s requirements, specs, tasks and planning documents. Needed
        after changing the workspace&apos;s embedding model.
      </p>

      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="mt-3 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:border-slate-400"
        >
          Reindex project
        </button>
      ) : (
        <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3 text-sm">
          <p className="text-slate-700">
            This makes one embedding call per requirement, spec, task and planning document in this
            project.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={run}
              disabled={running}
              className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              {running ? "Queuing…" : "Confirm"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={running}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-600"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* "Queued", never "indexed" — the endpoint returns before any embedding
          runs and there is nothing to poll. */}
      {enqueued !== null && (
        <p className="mt-2 text-sm text-slate-600">{enqueued} items queued for indexing.</p>
      )}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </section>
  );
}
```

- [ ] **Step 6: Mount it on the project settings page**

In `apps/web/src/app/w/[workspaceId]/p/[projectId]/settings/page.tsx`, add the imports and render the section below the heading:

```tsx
import { ReindexPanel } from "@/components/project/ReindexPanel";
import { useIsWorkspaceAdmin } from "@/lib/workspace";
```

Replace the inline `isAdmin` expression with `const isAdmin = useIsWorkspaceAdmin(workspaceId);` (dropping the now-unused `members` fetch and `useAuth` call if nothing else there needs them), then after the `<h1>`:

```tsx
        {isAdmin && <ReindexPanel projectId={projectId} />}
```

- [ ] **Step 7: Run the full suite and typecheck**

Run: `pnpm --dir apps/web vitest run && pnpm --dir apps/web tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/workspace.tsx \
        apps/web/src/components/project/ReindexPanel.tsx \
        apps/web/src/components/project/ReindexPanel.test.tsx \
        "apps/web/src/app/w/[workspaceId]/settings/page.tsx" \
        "apps/web/src/app/w/[workspaceId]/p/[projectId]/settings/page.tsx"
git commit -m "feat(web): add the admin reindex control for the assistant index"
```

---

### Task 9: End-to-end verification against a live cloud

Unit tests prove the client matches this plan's reading of the server. Only a real run proves it matches the server.

**Files:** none — this task changes no code.

- [ ] **Step 1: Start a local cloud**

```bash
cd apps/cloud
source .venv/bin/activate
export MANAGED_MODEL_ENABLED=true
export MANAGED_MODEL_API_KEY=<a real Typhoon key>
export RAG_KEY_ENCRYPTION_KEY=$(python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())")
uvicorn app.main:app --reload --port 8080
```

If no managed key is available, connect a BYO model instead via the web app's workspace settings — `resolve_assistant_models` accepts either. A chat model alone answers lineage questions; content questions additionally need an embedding model.

- [ ] **Step 2: Start the web app against it**

```bash
cd apps/web
NEXT_PUBLIC_CLOUD_API_URL=http://localhost:8080 pnpm dev
```

- [ ] **Step 3: Verify the lineage path**

Open a project with at least one requirement and a few tasks, go to the Discussion tab, click "Ask the assistant", and ask a status question (for example, "how is the login requirement doing?").

Expected: the fact card paints **before** any prose, its counts match the Tasks tab, and the prose streams in beneath it.

- [ ] **Step 4: Verify the content path and citations**

Ask a question about document content (for example, "what does the spec say about authentication?").

Expected: prose streams, then a Sources list appears. Confirm at least one chip resolves to a real title rather than a truncated id — this is what Tasks 1 and 4 exist for. If every chip shows a short id, the stage-document id from Task 1 is not reaching the client; check the network response for `/stage-documents/*`.

- [ ] **Step 5: Verify the no-model error path**

Disconnect the workspace model connection, ask a question, and confirm the panel shows "No model is connected for this workspace." with a working link to workspace settings.

- [ ] **Step 6: Verify the reindex control**

As a workspace admin, open project settings, click Reindex project, confirm, and check the count matches the project's node total. As a non-admin, confirm the section is absent.

- [ ] **Step 7: Record the result**

If everything passes, note it in the PR description. If the live framing differs from this plan's reading in any way, **stop and report it** — a mismatch means the spec's reading of `assistant.py` was wrong, and the fix belongs in `lib/sse.ts` or the hook, not in patched-over test expectations.

---

## Follow-ups (not in this plan)

- Migrate `Planner.tsx` onto `lib/sse.ts` and delete `planner-sse.ts`.
- A cloud batch resolver (`GET /projects/{id}/rag/nodes?ids=…`) to label `pull_requests` and replace the lazy per-type fetches in Task 7.
- Git-host links on code citation chips (`repo`/`path`/`start_line`/`end_line` already carry everything needed).
- Multi-turn conversation (needs `history` on `ChatRequest`, prompt assembly, and budget accounting).
- Sharing an answer into the discussion thread (needs `author_kind` on `Discussion` plus an embed opt-out).
