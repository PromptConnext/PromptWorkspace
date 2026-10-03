// Seed a local cloud with a workspace, a project and two assigned tasks, so
// the extension has something to render in an Extension Development Host.
//
//   cd apps/cloud && DATA_BACKEND=memory AUTH_MODE=stub \
//     .venv/bin/uvicorn app.main:app --port 8081
//   node apps/vscode/scripts/seed-local.mjs
//
// Override with PROMPTWORKSPACE_API if you run the cloud elsewhere.
//
// The memory backend keeps everything in process, so restarting uvicorn wipes
// it and you re-run this. That is the point: it costs nothing to start over.
//
// Two things the port and host choice are working around:
//
//   8081, not the cloud's usual 8080 — that port is often already taken on a
//   development machine, and the symptom is not a bind failure but a 404 from
//   somebody else's server, which reads like a routing bug in ours.
//
//   127.0.0.1, not localhost — uvicorn binds IPv4 only, macOS resolves
//   `localhost` to ::1 first, and an unrelated IPv6 listener answers instead.

const API = process.env.PROMPTWORKSPACE_API ?? "http://127.0.0.1:8081";
const USER = process.env.PROMPTWORKSPACE_USER ?? "dev-user";

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-user-id": USER },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : undefined;
}

const health = await call("GET", "/health").catch((err) => {
  console.error(
    `Cannot reach the cloud at ${API}.\n` +
      "Start it with:\n" +
      "  cd apps/cloud && DATA_BACKEND=memory AUTH_MODE=stub \\\n" +
      "    .venv/bin/uvicorn app.main:app --port 8081\n" +
      "\nOr point this script elsewhere with PROMPTWORKSPACE_API=http://127.0.0.1:<port>\n",
  );
  throw err;
});
if (health.backend !== "memory") {
  console.warn(
    `WARNING: backend is "${health.backend}", not "memory". This script writes ` +
      "real rows. Ctrl-C now if that is not what you meant.\n",
  );
}

const workspace = await call("POST", "/workspaces", { name: "Local Test" });
const project = await call("POST", "/projects", {
  name: "Demo",
  workspace_id: workspace.id,
});

const tasks = [
  {
    id: "t1",
    project_id: project.id,
    title: "Add login retry",
    feature_tag: "T001",
    acceptance_criteria: [
      { text: "Retries three times before failing" },
      { text: "Backs off exponentially" },
    ],
  },
  {
    id: "t2",
    project_id: project.id,
    title: "Cache the workspace roster",
    feature_tag: "T002",
    acceptance_criteria: [{ text: "Survives a window reload" }],
  },
  {
    id: "t3",
    project_id: project.id,
    title: "Rotate the session token",
    feature_tag: "T012",
    acceptance_criteria: [{ text: "Old token stops working immediately" }],
  },
];
await call("PUT", `/sync/projects/${project.id}/graph`, { tasks, source: "pz" });
for (const task of tasks) {
  await call("PATCH", `/projects/${project.id}/tasks/${task.id}/assignment`, {
    assigned_user_id: USER,
  });
}

// /me/tasks is deliberately cross-workspace, so this total includes anything
// left over from an earlier run. Report both, or the difference reads as a bug.
const mine = await call("GET", "/me/tasks");
console.log(
  `Seeded ${tasks.length} tasks; "${USER}" now has ${mine.length} open across ` +
    "all workspaces.\n",
);
console.log(`  workspace  ${workspace.id}`);
console.log(`  project    ${project.id}\n`);
console.log("Extension settings (Cmd-, in the Extension Development Host):\n");
console.log(
  JSON.stringify(
    {
      "promptworkspace.cloudApiUrl": API,
      "promptworkspace.supabaseUrl": "",
      "promptworkspace.supabaseAnonKey": "",
      "promptworkspace.projectId": project.id,
    },
    null,
    2,
  ),
);
console.log(
  `\nSign in with PromptWorkspace: Sign In and enter "${USER}" — with no Supabase\n` +
    "configured the cloud is in stub auth mode, so the browser handoff is skipped.\n\n" +
    "Then commit `T1: whatever` in the linked folder. T1, T01 and T001 all mean\n" +
    "the same task; T012 is seeded so you can check that T12 finds it too.",
);
