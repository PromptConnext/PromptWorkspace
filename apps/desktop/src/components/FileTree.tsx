import { useEffect, useState } from "react";
import { getFileTree, type FileNode } from "../api";

function TreeNode({
  node,
  onOpen,
  activePath,
  dirty,
}: {
  node: FileNode;
  onOpen: (path: string) => void;
  activePath: string | null;
  dirty: Set<string>;
}) {
  const [open, setOpen] = useState(false);
  if (node.dir) {
    return (
      <li>
        <button className="tree-row dir" type="button" onClick={() => setOpen((v) => !v)}>
          {open ? "▾" : "▸"} {node.name}
        </button>
        {open && node.children && (
          <ul className="tree-children">
            {node.children.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                onOpen={onOpen}
                activePath={activePath}
                dirty={dirty}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        className={`tree-row file ${activePath === node.path ? "active" : ""}`}
        onClick={() => onOpen(node.path)}
      >
        {node.name}
        {dirty.has(node.path) && <span className="dot" title="unsaved / changed" />}
      </button>
    </li>
  );
}

export default function FileTree({
  projectId,
  onOpen,
  activePath,
  dirty,
  refreshKey,
}: {
  projectId: string;
  onOpen: (path: string) => void;
  activePath: string | null;
  dirty: Set<string>;
  refreshKey: number;
}) {
  const [tree, setTree] = useState<FileNode[]>([]);

  useEffect(() => {
    getFileTree(projectId)
      .then((r) => setTree(r.tree))
      .catch(() => setTree([]));
  }, [projectId, refreshKey]);

  return (
    <ul className="tree-root">
      {tree.length === 0 && <li className="muted">Empty project</li>}
      {tree.map((node) => (
        <TreeNode key={node.path} node={node} onOpen={onOpen} activePath={activePath} dirty={dirty} />
      ))}
    </ul>
  );
}
