import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { getStatus, readFile, writeFile, type FileNode } from "../api";
import FileTree from "./FileTree";

// Monaco ships its own workers; wire them so the editor works offline inside
// the CSP-restricted webview (no CDN).
loader.config({ monaco });

type OpenTab = { path: string; content: string; dirty: boolean };

function languageFor(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    json: "json", md: "markdown", css: "css", html: "html", py: "python",
    rs: "rust", go: "go", sh: "shell", yml: "yaml", yaml: "yaml", toml: "ini",
  };
  return ext ? map[ext] : undefined;
}

// The developer surface (ADR 0007): file tree + Monaco tabs, the code half of
// the Cursor-like layout. Business users never come here.
export default function EditorPane({ projectId }: { projectId: string }) {
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [treeKey, setTreeKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = active;

  const refreshStatus = useCallback(() => {
    getStatus(projectId)
      .then((r) => setDirty((prev) => {
        const next = new Set(prev);
        for (const c of r.changed) next.add(c.path);
        return next;
      }))
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus, treeKey]);

  const open = async (path: string) => {
    setError(null);
    if (tabs.some((t) => t.path === path)) {
      setActive(path);
      return;
    }
    try {
      const { content } = await readFile(projectId, path);
      setTabs((prev) => [...prev, { path, content, dirty: false }]);
      setActive(path);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onChange = (value: string | undefined) => {
    const path = activeRef.current;
    if (path == null || value === undefined) return;
    setTabs((prev) =>
      prev.map((t) => (t.path === path ? { ...t, content: value, dirty: true } : t)),
    );
    setDirty((prev) => new Set(prev).add(path));
  };

  const save = useCallback(async () => {
    const path = activeRef.current;
    const tab = tabs.find((t) => t.path === path);
    if (!tab || !path) return;
    try {
      await writeFile(projectId, path, tab.content);
      setTabs((prev) => prev.map((t) => (t.path === path ? { ...t, dirty: false } : t)));
      setTreeKey((k) => k + 1); // refresh git status dots
    } catch (err) {
      setError((err as Error).message);
    }
  }, [projectId, tabs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  const close = (path: string) => {
    setTabs((prev) => prev.filter((t) => t.path !== path));
    if (active === path) {
      const rest = tabs.filter((t) => t.path !== path);
      setActive(rest.length ? rest[rest.length - 1].path : null);
    }
  };

  const activeTab = tabs.find((t) => t.path === active);
  const onTreeOpen = (node: FileNode | string) =>
    open(typeof node === "string" ? node : node.path);

  return (
    <div className="editor-layout">
      <aside className="file-tree">
        <FileTree
          projectId={projectId}
          onOpen={(p) => onTreeOpen(p)}
          activePath={active}
          dirty={dirty}
          refreshKey={treeKey}
        />
      </aside>
      <div className="editor-main">
        <div className="editor-tabs">
          {tabs.map((t) => (
            <div key={t.path} className={`editor-tab ${active === t.path ? "active" : ""}`}>
              <button type="button" onClick={() => setActive(t.path)}>
                {t.path.split("/").pop()}
                {t.dirty ? " •" : ""}
              </button>
              <button type="button" className="close" onClick={() => close(t.path)}>
                ×
              </button>
            </div>
          ))}
          {activeTab && (
            <button type="button" className="save-btn" onClick={() => void save()}>
              Save (⌘S)
            </button>
          )}
        </div>
        {error && <p className="error">{error}</p>}
        {activeTab ? (
          <Editor
            height="100%"
            theme="vs-dark"
            path={activeTab.path}
            language={languageFor(activeTab.path)}
            value={activeTab.content}
            onChange={onChange}
            options={{ minimap: { enabled: false }, fontSize: 13, automaticLayout: true }}
          />
        ) : (
          <p className="muted editor-empty">Open a file from the tree to start editing.</p>
        )}
      </div>
    </div>
  );
}
