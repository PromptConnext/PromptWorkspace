import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ENGINE_PORT } from "./config.ts";
import { anthropicCompat } from "./gateway/anthropic-compat.ts";
import { models, connectionForRoleStrict } from "./routes/models.ts";
import { onboarding } from "./routes/onboarding.ts";
import { projects } from "./routes/projects.ts";
import { files } from "./routes/files.ts";
import { agents } from "./routes/agents.ts";
import { registerTerminal } from "./routes/terminal.ts";
import { isAllowedOrigin, isAuthorized, AUTH_TOKEN } from "./security.ts";

const app = new Hono();

// Reflect only allowlisted browser origins (ADR 0008) instead of the previous
// wildcard, so a drive-by page cannot read engine responses. Native clients
// (curl, the spawned agent hitting /anthropic) send no Origin and are
// unaffected — CORS only governs browsers.
app.use(
  "*",
  cors({
    origin: (origin) => (isAllowedOrigin(origin) ? origin : ""),
    credentials: true,
  }),
);

// Require the per-session token (when configured) on every request. Skip CORS
// preflight (no auth header allowed on it) and the health probe (liveness check
// the shell/UI make before the token round-trips). No-op in dev (token unset).
if (AUTH_TOKEN) {
  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS" || c.req.path === "/engine/health") return next();
    const queryToken = new URL(c.req.url).searchParams.get("token");
    if (!isAuthorized(c.req.header("authorization"), queryToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  });
}

app.get("/engine/health", (c) =>
  c.json({ ok: true, version: "0.0.1", pid: process.pid }),
);

app.route("/", models);
app.route("/", onboarding);
app.route("/", projects);
app.route("/", files);
app.route("/", agents);
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
// Agent task runs stream SSE for minutes. Node's default http requestTimeout
// (300s) would destroy the still-open connection at the 5-minute mark — cutting
// off any agent slower than that and orphaning the spawned CLI. Disable it;
// per-run bounds come from AGENT_TIMEOUT_MS and client aborts instead.
(server as import("node:http").Server).requestTimeout = 0;
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
