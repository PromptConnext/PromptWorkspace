import { useCallback, useEffect, useState } from "react";
import {
  approveStage,
  getGraph,
  listModels,
  runScope,
  runSpec,
  runTaskImplementation,
  runTasks,
  listAgents,
  type Graph,
  type Project,
} from "../api";
import ConnectForm from "./ConnectForm";
import GraphView from "./GraphView";
import TerminalPane from "./TerminalPane";
import EditorPane from "./EditorPane";
import SpecDoc, { extractClarifications } from "./SpecDoc";
import Clarifications from "./Clarifications";
import AgentPicker from "./AgentPicker";
import ConstitutionSetup from "./ConstitutionSetup";

function stageOf(graph: Graph | null, name: string) {
  return graph?.stages.find((s) => s.stage === name);
}

export default function ThreeS({ project }: { project: Project }) {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [hasCodeModel, setHasCodeModel] = useState(true);
  const [hasAgent, setHasAgent] = useState(false);
  const [tab, setTab] = useState<"threes" | "graph" | "editor" | "terminal">("threes");
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setGraph(await getGraph(project.id));
    const models = await listModels();
    setHasCodeModel(models.connections.some((c) => c.role === "code" && c.healthy));
    const a = await listAgents().catch(() => ({ agents: [] }));
    setHasAgent(a.agents.some((x) => x.installed));
  }, [project.id]);

  // A task can be implemented if a coding model is connected OR an external
  // agent (which may bring its own model) is available.
  const canImplement = hasCodeModel || hasAgent;

  useEffect(() => {
    refresh().catch((err) => setError((err as Error).message));
  }, [refresh]);

  const scope = stageOf(graph, "scope");
  const spec = stageOf(graph, "spec");
  const scopeApproved = scope?.gate_passed === 1;
  const specApproved = spec?.gate_passed === 1;
  const tasks =
    graph?.requirements.flatMap((r) => r.specDocuments.flatMap((s) => s.tasks)) ?? [];
  const doneCount = tasks.filter((t) => t.status === "done").length;
  const clarifications = extractClarifications(output);

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

  // Regenerate the current stage with reviewer-supplied feedback (used by both
  // the free-text refine box and the interactive clarification answers).
  const regenerateWith = async (fb: string) => {
    if (!scopeApproved) {
      await act("scope", () => runScope(project.id, description, appendOutput, fb), true);
    } else if (!specApproved) {
      await act("spec", () => runSpec(project.id, appendOutput, fb), true);
    }
    setFeedback("");
  };

  // Handoff for developers using their own agent (in the Terminal tab or
  // anywhere): a paste-ready prompt; the commit-ref convention closes the loop.
  const copyContext = async (task: { id: string; title: string; feature_tag?: string | null }) => {
    const ref = (task.feature_tag ?? "").split(" ")[0] || "the task";
    await navigator.clipboard.writeText(
      [
        `Implement task ${ref}: ${task.title}`,
        `Context: specs/001/spec.md (specification), specs/001/plan.md (plan), specs/001/tasks.md (full task list).`,
        `Implement ONLY this task. Mention ${ref} in your commit message so PromptConnext tracks it automatically.`,
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
      {tab === "graph" && (
        <GraphView graph={graph} projectId={project.id} workspaceId={project.cloud_workspace_id} />
      )}
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

          {tasks.length > 0 && (
            <div className="progress">
              <div className="progress-label">
                Implementation — {doneCount} of {tasks.length} tasks done
              </div>
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{ width: `${(doneCount / tasks.length) * 100}%` }}
                />
              </div>
            </div>
          )}

          {!scopeApproved && <ConstitutionSetup projectId={project.id} />}

          {!scopeApproved && (
            <div className="stage-panel">
              <h3>Scope — what should this project achieve?</h3>
              <textarea
                rows={5}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe the goal in plain business terms…"
              />
              {scope?.status === "awaiting_approval" && (
                <label className="refine">
                  Want changes? Describe them, then Regenerate.
                  <textarea
                    rows={2}
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    placeholder="e.g. also support mobile push notifications"
                  />
                </label>
              )}
              <div className="row">
                <button
                  type="button"
                  disabled={busy !== null || !description.trim()}
                  onClick={async () => {
                    await act(
                      "scope",
                      () => runScope(project.id, description, appendOutput, feedback || undefined),
                      true,
                    );
                    setFeedback("");
                  }}
                >
                  {busy === "scope"
                    ? "Generating…"
                    : scope?.status === "awaiting_approval"
                      ? "Regenerate"
                      : "Generate specification"}
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
              <h3>Spec — review the project plan</h3>
              {spec?.status === "awaiting_approval" && (
                <label className="refine">
                  Want changes to the plan? Describe them, then Regenerate.
                  <textarea
                    rows={2}
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    placeholder="e.g. use PostgreSQL instead of SQLite"
                  />
                </label>
              )}
              <div className="row">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={async () => {
                    await act(
                      "spec",
                      () => runSpec(project.id, appendOutput, feedback || undefined),
                      true,
                    );
                    setFeedback("");
                  }}
                >
                  {busy === "spec"
                    ? "Generating plan…"
                    : spec?.status === "awaiting_approval"
                      ? "Regenerate"
                      : "Generate plan"}
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
              <AgentPicker projectId={project.id} />
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
                            disabled={busy !== null || !canImplement}
                            title={canImplement ? undefined : "Connect a coding model or install an agent CLI"}
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
              {!canImplement && (
                <>
                  <p>
                    To implement, either install a coding-agent CLI (above) or connect a coding
                    model for the built-in fallback.
                  </p>
                  <ConnectForm role="code" onConnected={() => refresh()} />
                </>
              )}
            </div>
          )}

          {clarifications.length > 0 && (
            <Clarifications
              questions={clarifications}
              busy={busy !== null}
              onAnswer={regenerateWith}
            />
          )}

          {output && (
            <div className="stage-panel">
              <h3>
                {!scopeApproved
                  ? "Draft specification"
                  : !specApproved
                    ? "Project plan"
                    : "Latest output"}
              </h3>
              <SpecDoc content={output} streaming={busy !== null} />
            </div>
          )}
          {error && <p className="error">{error}</p>}
        </>
      )}
    </section>
  );
}
