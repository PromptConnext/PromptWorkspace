import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ENGINE_URL, getLocalLlmEnv, listModels } from "../api";

// The developer surface (ADR 0007): a real shell in the project directory.
// Developers run their own agent CLI here — their tools, their auth. Commits
// mentioning a task ref (e.g. "T003: ...") sync back into the graph.
export default function TerminalPane({ projectId }: { projectId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [hasModel, setHasModel] = useState(false);
  const [wired, setWired] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    listModels()
      .then((r) => setHasModel(r.connections.some((c) => c.healthy)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const el = ref.current!;
    const term = new XTerm({
      fontSize: 13,
      fontFamily: "Menlo, Monaco, monospace",
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    const safeFit = () => {
      try {
        if (el.clientWidth > 0 && el.clientHeight > 0) fit.fit();
      } catch {
        // hidden pane — retry on next resize
      }
    };
    safeFit();

    const ws = new WebSocket(
      `${ENGINE_URL.replace(/^http/, "ws")}/engine/projects/${projectId}/terminal`,
    );
    wsRef.current = ws;
    ws.onopen = () =>
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    ws.onmessage = (e) =>
      term.write((JSON.parse(e.data as string) as { data: string }).data);
    ws.onclose = () => term.write("\r\n[terminal session ended]\r\n");

    const onData = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "input", data }));
    });
    const onResize = term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
    });
    const observer = new ResizeObserver(safeFit);
    observer.observe(el);

    return () => {
      observer.disconnect();
      onData.dispose();
      onResize.dispose();
      ws.close();
      wsRef.current = null;
      term.dispose();
    };
  }, [projectId]);

  // Inject the env that points Claude Code / Codex in THIS shell at the
  // connected local model (via our façade). The command is typed visibly so
  // the developer sees exactly what changed — no hidden magic.
  const useLocalModel = async () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      const { model, env } = await getLocalLlmEnv();
      const exports = Object.entries(env)
        .map(([k, v]) => `export ${k}='${v}'`)
        .join(" ");
      ws.send(
        JSON.stringify({
          type: "input",
          data: `${exports} && echo '→ claude/codex in this shell now use ${model} (via PromptZone)'\n`,
        }),
      );
      setWired(true);
      setNote(`This shell is wired to ${model}. Run \`claude\` to use it.`);
    } catch (err) {
      setNote((err as Error).message);
    }
  };

  return (
    <div className="terminal-wrap">
      <div className="terminal-toolbar">
        <button
          type="button"
          disabled={!hasModel || wired}
          title={hasModel ? undefined : "Connect a model first (Skill stage)"}
          onClick={useLocalModel}
        >
          {wired ? "Local model wired ✓" : "Use local model here"}
        </button>
        {note && <span className="muted">{note}</span>}
      </div>
      <div className="terminal-pane" ref={ref} />
    </div>
  );
}
