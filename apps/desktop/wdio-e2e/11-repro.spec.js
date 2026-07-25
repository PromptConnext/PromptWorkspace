import fs from "node:fs";

const SIGNAL_FILE = "/tmp/pz-handoff-code2.txt";

async function engineFetch(token, url, opts) {
  return browser.execute(
    async (t, u, o) => {
      try {
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
      } catch (err) {
        return { clientError: String(err && err.stack || err) };
      }
    },
    token,
    url,
    opts,
  );
}

describe("repro create-project error", () => {
  it("isolates the error source", async function () {
    this.timeout(3 * 60 * 1000);
    try {
      fs.unlinkSync(SIGNAL_FILE);
    } catch {}

    await browser.pause(1500);
    const token = await browser.execute(() => window.__PROMPTCONNEXT_TOKEN__);
    console.log("R_TOKEN=" + token);

    const start = await engineFetch(token, "http://127.0.0.1:47131/engine/cloud/login/browser", {
      method: "POST",
    });
    console.log("R_SIGNIN_URL=" + start.body.url);
    console.log("R_SIGNIN_STATE=" + start.body.state);

    const deadline = Date.now() + 3 * 60 * 1000;
    while (!fs.existsSync(SIGNAL_FILE)) {
      if (Date.now() > deadline) throw new Error("timed out waiting for code");
      await browser.pause(1500);
    }
    const code = fs.readFileSync(SIGNAL_FILE, "utf8").trim();
    console.log("R_CODE=" + code);

    const redeem = await engineFetch(token, "http://127.0.0.1:47131/engine/cloud/login/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, state: start.body.state }),
    });
    console.log("R_REDEEM=" + JSON.stringify(redeem));

    const create = await engineFetch(token, "http://127.0.0.1:47131/engine/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "MakeStoryTime" }),
    });
    console.log("R_CREATE=" + JSON.stringify(create));
  });
});
