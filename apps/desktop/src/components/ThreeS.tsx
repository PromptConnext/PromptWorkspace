import { useCallback, useEffect, useState } from "react";
import {
  approveStage,
  getGraph,
  listModels,
  runScope,
  runSpec,
  runTaskImplementation,
  runTasks,
  type Graph,
  type Project,
} from "../api";
import ConnectForm from "./ConnectForm";
import GraphView from "./GraphView";
import TerminalPane from "./TerminalPane";
import EditorPane from "./EditorPane";

function stageOf(graph: Graph | null, name: string) {
  return graph?.stages.find((s) => s.stage === name);
}

export default function ThreeS({ project }: { project: Project }) {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [hasCodeModel, setHasCodeModel] = useState(true);
  const [tab, setTab] = useState<"threes" | "graph" | "editor" | "terminal">("threes");
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setGraph(await getGraph(project.id));
    const models = await listModels();
    setHasCodeModel(models.connections.some((c) => c.role === "code" && c.healthy));
  }, [project.id]);

  useEffect(() => {
    refresh().catch((err) => setError((err as Error).message));
  }, [refresh]);

  const scope = stageOf(graph, "scope");
  const spec = stageOf(graph, "spec");
  const scopeApproved = scope?.gate_passed === 1;
  const specApproved = spec?.gate_passed === 1;
  const tasks =
    graph?.requirements.flatMap((r) => r.specDocuments.flatMap((s) => s.tasks)) ?? [];

  const act = async (label: string, fn: () => Promise<unknown>, streams = false) => {
    setBusy(label);
    setError(null);
    if (streams) setOutput("");
    try {
      const res = await fn();
      const content = (res as { content?: string })?.content;
      if (content) setOutput(content);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const appendOutput = (delta: string) => setOutput((prev) => (prev ?? "") + delta);

  // Handoff for developers using their own agent (in the Terminal tab or
  // anywhere): a paste-ready prompt; the commit-ref convention closes the loop.
  const copyContext = async (task: { id: string; title: string; feature_tag?: string | null }) => {
    const ref = (task.feature_tag ?? "").split(" ")[0] || "the task";
    await navigator.clipboard.writeText(
      [
        `Implement task ${ref}: ${task.title}`,
        `Context: specs/001/spec.md (specification), specs/001/plan.md (plan), specs/001/tasks.md (full task list).`,
        `Implement ONLY this task. Mention ${ref} in your commit message so PromptZone tracks it automatically.`,
      ].join("\n"),
    );
    setCopied(task.id);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <section className="threes">
      <header className="threes-header">
        <h2>{project.name}</h2>
        <nav>
          <button
            type="button"
            className={tab === "threes" ? "active" : ""}
            onClick={() => setTab("threes")}
          >
            3S Workflow
          </button>
          <button
            type="button"
            className={tab === "graph" ? "active" : ""}
            onClick={() => setTab("graph")}
          >
            Task Graph
          </button>
          <button
            type="button"
            className={tab === "editor" ? "active" : ""}
            onClick={() => setTab("editor")}
          >
            Editor
          </button>
          <button
            type="button"
            className={tab === "terminal" ? "active" : ""}
            onClick={() => setTab("terminal")}
          >
            Terminal
          </button>
        </nav>
      </header>

      {/* keep terminal + editor mounted so shell sessions and editor state
          survive tab switches */}
      <div style={{ display: tab === "terminal" ? "block" : "none" }}>
        <TerminalPane projectId={project.id} />
      </div>
      <div style={{ display: tab === "editor" ? "block" : "none" }}>
        <EditorPane projectId={project.id} />
      </div>
      {tab === "graph" && <GraphView graph={graph} />}
      {tab === "threes" && (
        <>
          <div className="stepper">
            <span className={`step ${scopeApproved ? "done" : "current"}`}>
              1 · Scope {scopeApproved ? "✓" : `(${scope?.status ?? "…"})`}
            </span>
            <span
              className={`step ${
                specApproved ? "done" : scopeApproved ? "current" : ""
              }`}
            >
              2 · Spec {specApproved ? "✓" : `(${spec?.status ?? "…"})`}
            </span>
            <span className={`step ${specApproved ? "current" : ""}`}>3 · Skill</span>
          </div>

          {!scopeApproved && (
            <div className="stage-panel">
              <h3>Scope — what should this project achieve?</h3>
              <textarea
                rows={5}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe the goal in plain business terms…"
              />
              <div className="row">
                <button
                  type="button"
                  disabled={busy !== null || !description.trim()}
                  onClick={() =>
                    act("scope", () => runScope(project.id, description, appendOutput), true)
                  }
                >
                  {busy === "scope" ? "Generating specification…" : "Generate"}
                </button>
                {scope?.status === "awaiting_approval" && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => act("approve-scope", () => approveStage(project.id, "scope"))}
                  >
                    Approve scope ✓
                  </button>
                )}
              </div>
            </div>
          )}

          {scopeApproved && !specApproved && (
            <div className="stage-panel">
              <h3>Spec — review the project specification</h3>
              <div className="row">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => act("spec", () => runSpec(project.id, appendOutput), true)}
                >
                  {busy === "spec" ? "Generating plan…" : "Generate plan"}
                </button>
                {spec?.status === "awaiting_approval" && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => act("approve-spec", () => approveStage(project.id, "spec"))}
                  >
                    Approve spec ✓
                  </button>
                )}
              </div>
            </div>
          )}

          {specApproved && (
            <div className="stage-panel">
              <h3>Skill — equip the project to build itself</h3>
              <div className="row">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => act("tasks", () => runTasks(project.id, appendOutput), true)}
                >
                  {busy === "tasks"
                    ? "Breaking spec into tasks…"
                    : tasks.length > 0
                      ? "Regenerate tasks"
                      : "Generate tasks"}
                </button>
              </div>
              {tasks.length > 0 && (
                <ul className="task-list">
                  {tasks.map((task) => (
                    <li key={task.id}>
                      <span>
                        {task.title}{" "}
                        <span className={`badge ${task.status}`}>{task.status}</span>
                      </span>
                      <span className="row">
                        <button type="button" onClick={() => copyContext(task)}>
                          {copied === task.id ? "Copied ✓" : "Copy context"}
                        </button>
                        {task.status !== "done" && (
                          <button
                            type="button"
                            disabled={busy !== null || !hasCodeModel}
                            title={hasCodeModel ? undefined : "Connect a coding model first"}
                            onClick={() =>
                              act(
                                `run-${task.id}`,
                                () => runTaskImplementation(task.id, appendOutput),
                                true,
                              )
                            }
                          >
                            {busy === `run-${task.id}` ? "Implementing…" : "Run"}
                          </button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {hasCodeModel ? (
                <p className="muted">
                  Coding model connected. Implementation execution is the next milestone.
                </p>
              ) : (
                <>
                  <p>
                    Implementation needs a model optimized for coding. Connect one now —
                    it's needed from this point on.
                  </p>
                  <ConnectForm role="code" onConnected={() => refresh()} />
                </>
              )}
            </div>
          )}

          {output && (
            <div className="stage-panel">
              <h3>Latest output</h3>
              <pre className="doc">{output}</pre>
            </div>
          )}
          {error && <p className="error">{error}</p>}
        </>
      )}
    </section>
  );
}
