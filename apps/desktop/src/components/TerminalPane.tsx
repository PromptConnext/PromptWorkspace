import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ENGINE_URL } from "../api";

// The developer surface (ADR 0007): a real shell in the project directory.
// Developers run their own agent CLI here — their tools, their auth. Commits
// mentioning a task ref (e.g. "T003: ...") sync back into the graph.
export default function TerminalPane({ projectId }: { projectId: string }) {
  const ref = useRef<HTMLDivElement>(null);

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

  return <div className="terminal-pane" ref={ref} />;
}
