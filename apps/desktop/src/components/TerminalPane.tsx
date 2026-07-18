import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ENGINE_URL, getLocalLlmEnv, withToken } from "../api";

// The developer surface (ADR 0007): a real shell in the project directory.
// Developers run their own agent CLI here — their tools, their auth. Commits
// mentioning a task ref (e.g. "T003: ...") sync back into the graph.
export default function TerminalPane({ projectId }: { projectId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [setup, setSetup] = useState<{ model: string; commands: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
      withToken(`${ENGINE_URL.replace(/^http/, "ws")}/engine/projects/${projectId}/terminal`),
    );
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
      term.dispose();
    };
  }, [projectId]);

  // Show the exact exports that point Claude Code / Codex at the connected
  // model via our façade — developers paste them into this shell themselves.
  const showSetup = async () => {
    setError(null);
    if (setup) {
      setSetup(null);
      return;
    }
    try {
      const { model, env } = await getLocalLlmEnv();
      const commands = Object.entries(env)
        .map(([k, v]) => `export ${k}='${v}'`)
        .join("\n");
      setSetup({ model, commands });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const copy = async () => {
    if (!setup) return;
    await navigator.clipboard.writeText(setup.commands);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="terminal-wrap">
      <div className="terminal-toolbar">
        <button type="button" onClick={showSetup}>
          {setup ? "Hide model setup" : "Point Claude Code at your model"}
        </button>
        {error && <span className="error">{error}</span>}
      </div>
      {setup && (
        <div className="setup-panel">
          <p className="muted">
            Paste these into this shell, then run <code>claude</code> — it will use{" "}
            <strong>{setup.model}</strong> through PromptConnext's translation layer (tool
            calls included). A developer who prefers their own Claude account can skip this.
          </p>
          <pre>{setup.commands}</pre>
          <button type="button" onClick={copy}>
            {copied ? "Copied ✓" : "Copy"}
          </button>
        </div>
      )}
      <div className="terminal-pane" ref={ref} />
    </div>
  );
}
