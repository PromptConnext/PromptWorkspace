import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIGNAL_FILE = "/tmp/pz-handoff-code.txt";
const SHOTS = path.join(__dirname, "screenshots");
const PRD_SCOPE = fs.readFileSync(path.join(__dirname, "prd-scope.txt"), "utf8");

async function shot(name) {
  await browser.saveScreenshot(path.join(SHOTS, name));
}

async function engineFetch(token, url, opts) {
  return browser.execute(
    async (t, u, o) => {
      const res = await fetch(u, {
        ...o,
        headers: { ...(o.headers || {}), Authorization: `Bearer ${t}` },
      });
      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: res.status, body };
    },
    token,
    url,
    opts,
  );
}

describe("full 3S + sync + implement flow", () => {
  it("runs the whole journey", async function () {
    this.timeout(20 * 60 * 1000);
    try {
      fs.unlinkSync(SIGNAL_FILE);
    } catch {}

    await browser.pause(1500);
    const token = await browser.execute(() => window.__PROMPTWORKSPACE_TOKEN__);
    console.log("ENGINE_TOKEN=" + token);
    await shot("10-01-initial.png");

    // Connect a local Ollama model so the planning stages (scope/spec/tasks)
    // have a BYO model to call.
    const connect = await engineFetch(token, "http://127.0.0.1:47131/engine/models/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "plan",
        provider: "ollama",
        endpoint: "http://127.0.0.1:11434",
        model: "qwen3:0.6b",
        apiKey: "ollama",
      }),
    });
    console.log("MODEL_CONNECT=" + JSON.stringify(connect));

    // --- Sign in via browser handoff (ADR 0014), driven through the same
    // engine routes the UI's Sign in / Paste code buttons call. ---
    const start = await engineFetch(token, "http://127.0.0.1:47131/engine/cloud/login/browser", {
      method: "POST",
    });
    console.log("SIGNIN_START=" + JSON.stringify(start));
    const { url, state } = start.body;
    console.log("SIGNIN_URL=" + url);
    console.log("SIGNIN_STATE=" + state);

    console.log("WAITING_FOR_SIGNAL_FILE=" + SIGNAL_FILE);
    const deadline = Date.now() + 5 * 60 * 1000;
    while (!fs.existsSync(SIGNAL_FILE)) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for handoff code");
      await browser.pause(2000);
    }
    const code = fs.readFileSync(SIGNAL_FILE, "utf8").trim();
    console.log("GOT_CODE=" + code);

    const redeem = await engineFetch(token, "http://127.0.0.1:47131/engine/cloud/login/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, state }),
    });
    console.log("REDEEM=" + JSON.stringify(redeem));

    await browser.execute(() => window.location.reload());
    await browser.pause(3000);
    await shot("10-02-signed-in.png");

    const signedInText = await browser.execute(() => document.body.innerText);
    console.log("POST_SIGNIN_TEXT=" + signedInText.slice(0, 500));

    // --- Create project ---
    const newProjectBtn = await $("button=+ New project");
    await newProjectBtn.waitForExist({ timeout: 15000 });
    await newProjectBtn.click();
    const nameInput = await $('input[placeholder="Project name"]');
    await nameInput.waitForExist({ timeout: 5000 });
    await nameInput.setValue("MakeStoryTime-E2E-" + Date.now());
    const addBtn = await $("button=Add");
    await addBtn.click();
    await browser.pause(2000);
    await shot("10-03-project-created.png");

    // --- Scope ---
    const scopeTextarea = await $('textarea[placeholder="Describe the goal in plain business terms…"]');
    await scopeTextarea.waitForExist({ timeout: 15000 });
    await scopeTextarea.setValue(PRD_SCOPE);
    const genSpecBtn = await $("button=Generate specification");
    await genSpecBtn.click();
    await shot("10-04-scope-generating.png");

    const approveScopeBtn = await $("button=Approve scope ✓");
    await approveScopeBtn.waitForExist({ timeout: 6 * 60 * 1000 });
    await shot("10-05-scope-ready.png");
    await approveScopeBtn.click();
    await browser.pause(1500);
    await shot("10-06-scope-approved.png");

    // --- Spec ---
    const genPlanBtn = await $("button=Generate plan");
    await genPlanBtn.waitForExist({ timeout: 10000 });
    await genPlanBtn.click();
    await shot("10-07-spec-generating.png");

    const approveSpecBtn = await $("button=Approve spec ✓");
    await approveSpecBtn.waitForExist({ timeout: 6 * 60 * 1000 });
    await shot("10-08-spec-ready.png");
    await approveSpecBtn.click();
    await browser.pause(1500);
    await shot("10-09-spec-approved.png");

    // --- Skill / tasks ---
    const genTasksBtn = await $("button=Generate tasks");
    await genTasksBtn.waitForExist({ timeout: 10000 });
    await genTasksBtn.click();
    await shot("10-10-tasks-generating.png");

    const taskList = await $(".task-list");
    await taskList.waitForExist({ timeout: 8 * 60 * 1000 });
    await browser.pause(1000);
    await shot("10-11-tasks-ready.png");

    const taskCount = await $$(".task-list li").then((els) => els.length);
    console.log("TASK_COUNT=" + taskCount);

    // --- Implement first task ---
    const firstTaskLi = await $(".task-list li");
    const firstRunBtn = await firstTaskLi.$("button=Run");
    const hasRun = await firstRunBtn.isExisting();
    console.log("HAS_RUN_BUTTON=" + hasRun);
    if (hasRun) {
      await firstRunBtn.click();
      await shot("10-12-implement-running.png");
      await browser.waitUntil(
        async () => {
          const html = await browser.execute(() => document.querySelector(".task-list")?.innerHTML || "");
          return html.includes("badge done") || html.includes(">done<");
        },
        { timeout: 10 * 60 * 1000, interval: 5000, timeoutMsg: "task did not reach done status" },
      ).catch((e) => console.log("IMPLEMENT_WAIT_ERROR=" + e.message));
      await shot("10-13-implement-result.png");
      const finalHtml = await browser.execute(() => document.querySelector(".task-list")?.outerHTML || "");
      console.log("FINAL_TASK_LIST=" + finalHtml.slice(0, 2000));
    }

    const projectInfo = await engineFetch(token, "http://127.0.0.1:47131/engine/projects", { method: "GET" });
    console.log("PROJECTS=" + JSON.stringify(projectInfo).slice(0, 1500));
  });
});
