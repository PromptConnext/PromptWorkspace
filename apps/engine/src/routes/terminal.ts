// Integrated terminal (ADR 0007): a real PTY in the project directory over a
// WebSocket. Developers implement inside PromptZone their own way — their own
// agent CLI, their own auth — instead of PromptZone driving an agent for them.
import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import pty from "node-pty";
import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { db } from "../db.ts";

// pnpm strips the exec bit from node-pty's prebuilt spawn-helper, which makes
// every pty.spawn die with "posix_spawnp failed" — restore it at startup.
try {
  const ptyDir = dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
  for (const arch of ["darwin-arm64", "darwin-x64"]) {
    const helper = join(ptyDir, "prebuilds", arch, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
} catch {
  // best effort — a real spawn failure will surface on first terminal open
}

type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export function registerTerminal(app: Hono, upgradeWebSocket: UpgradeWebSocket): void {
  app.get(
    "/engine/projects/:id/terminal",
    upgradeWebSocket((c) => {
      const project = db
        .prepare("SELECT id, path FROM projects WHERE id = ?")
        .get(c.req.param("id")) as { id: string; path: string } | undefined;

      let shell: pty.IPty | null = null;
      return {
        onOpen(_evt, ws) {
          if (!project) {
            ws.send(JSON.stringify({ type: "output", data: "project not found\r\n" }));
            ws.close();
            return;
          }
          shell = pty.spawn(process.env.SHELL ?? "/bin/zsh", ["-l"], {
            name: "xterm-256color",
            cols: 80,
            rows: 24,
            cwd: project.path,
            env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
          });
          shell.onData((data) => ws.send(JSON.stringify({ type: "output", data })));
          shell.onExit(() => ws.close());
        },
        onMessage(evt) {
          if (!shell) return;
          let msg: ClientMessage;
          try {
            msg = JSON.parse(String(evt.data));
          } catch {
            return;
          }
          if (msg.type === "input") shell.write(msg.data);
          else if (msg.type === "resize" && msg.cols > 0 && msg.rows > 0) {
            shell.resize(msg.cols, msg.rows);
          }
        },
        onClose() {
          shell?.kill();
          shell = null;
        },
      };
    }),
  );
}
