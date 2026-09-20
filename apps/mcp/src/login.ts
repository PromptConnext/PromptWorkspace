// `promptconnext-mcp login` — browser sign-in without an editor.
//
// apps/vscode/src/auth/signIn.ts builds a callback from `env.uriScheme` plus its
// own extension id and receives the one-time code through a URI handler the
// editor registered with the OS. A headless process has no scheme, no handler,
// and no editor to register one, so plan 0025 §3 chooses the pasted code: open
// `{webUrl}/login?desktop=1&state=<random>`, and read the code the page already
// renders with a copy button for exactly the cases where a redirect never
// arrives.
//
// `state` is still sent because the page gates the code display on it, but it
// carries no security weight here — the code never travels back through a URL,
// so the single-use 120-second TTL (apps/cloud/app/desktop_auth_store.py) is the
// whole control. A device-code flow would need new cloud surface: a
// client-initiated code, a longer TTL, a poll endpoint separating *pending* from
// *expired*, rate limiting, and a store that survives restart. That is M4, and
// only if the paste proves to be where people stop.
//
// Unlike the server, this subcommand owns stdout — it is a terminal session, not
// a JSON-RPC stream.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { createCloudContext } from "./cloud.ts";
import { configDir } from "./config.ts";

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Best-effort. A server with no desktop session, or a container, simply has no
 *  browser to open — the URL is printed first for exactly that reason, so this
 *  failing is not an error. */
function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Printed above; nothing more to do.
  }
}

export async function runLogin(): Promise<number> {
  const { client, config } = createCloudContext();
  if (!config.cloudApiUrl) {
    process.stderr.write(
      `No cloudApiUrl configured. Set it in ${configDir()}/config.json or ` +
        "PROMPTCONNEXT_CLOUD_API_URL.\n",
    );
    return 1;
  }

  if (client.mode() === "stub") {
    // Local development against a cloud in stub auth mode, where identity is
    // just an X-User-Id header. Never reaches a real deployment: a cloud in
    // supabase mode rejects the header outright.
    process.stdout.write(
      "No Supabase configured, so the cloud is in stub auth mode (local development only).\n",
    );
    const userId = (await prompt("User id [dev-user]: ")) || "dev-user";
    await client.signInStub(userId);
    process.stdout.write(`Signed in as ${userId} (stub).\n`);
    return 0;
  }

  if (!config.cloudWebUrl) {
    process.stderr.write(
      `No cloudWebUrl configured. Set it in ${configDir()}/config.json or ` +
        "PROMPTCONNEXT_CLOUD_WEB_URL.\n",
    );
    return 1;
  }

  const state = randomBytes(16).toString("hex");
  const url =
    `${config.cloudWebUrl}/login?desktop=1&state=${encodeURIComponent(state)}`;

  process.stdout.write(
    "Sign in to PromptConnext in your browser, then copy the code it shows.\n\n" +
      `  ${url}\n\n`,
  );
  openInBrowser(url);

  const code = await prompt("Paste the code here: ");
  if (!code) {
    process.stderr.write("No code entered.\n");
    return 1;
  }

  try {
    const session = await client.redeemDesktopCode(code);
    process.stdout.write(
      `Signed in as ${session.email ?? session.userId}. ` +
        "Every MCP client on this machine now shares the session.\n",
    );
    return 0;
  } catch (err) {
    // The code is single-use with a 120-second TTL, so "expired" is the common
    // case and worth naming rather than leaving as a bare 404.
    process.stderr.write(
      `Sign-in failed: ${String(err)}\n` +
        "The code is single-use and expires after two minutes — run `login` again for a fresh one.\n",
    );
    return 1;
  }
}
