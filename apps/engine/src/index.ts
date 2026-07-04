import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ENGINE_PORT } from "./config.ts";
import { anthropicCompat } from "./gateway/anthropic-compat.ts";
import { models, connectionForRoleStrict } from "./routes/models.ts";
import { onboarding } from "./routes/onboarding.ts";
import { projects } from "./routes/projects.ts";
import { registerTerminal } from "./routes/terminal.ts";

const app = new Hono();

// The webview origin differs (tauri://localhost in prod, http://localhost:1420
// in dev); the engine itself only ever binds 127.0.0.1.
app.use("*", cors());

app.get("/engine/health", (c) =>
  c.json({ ok: true, version: "0.0.1", pid: process.pid }),
);

app.route("/", models);
app.route("/", onboarding);
app.route("/", projects);
// Anthropic Messages façade for agent CLIs (ADR 0006) — routes to the
// connected code-role model.
app.route("/anthropic", anthropicCompat(() => connectionForRoleStrict("code")));

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
registerTerminal(app, upgradeWebSocket);

const server = serve(
  { fetch: app.fetch, port: ENGINE_PORT, hostname: "127.0.0.1" },
  (info) => {
    console.log(`[engine] listening on http://127.0.0.1:${info.port}`);
  },
);
injectWebSocket(server);

// When launched as the desktop app's sidecar, die with the parent even if it
// was SIGKILLed and never ran its exit handler: once the shell is gone this
// process is reparented and ppid changes.
const parentPid = Number(process.env.PROMPTZONE_PARENT_PID ?? 0);
if (parentPid > 0) {
  setInterval(() => {
    if (process.ppid !== parentPid) {
      console.log("[engine] parent gone, shutting down");
      process.exit(0);
    }
  }, 2000).unref();
}

export default app;
