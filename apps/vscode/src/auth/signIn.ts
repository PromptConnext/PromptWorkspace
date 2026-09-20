// Browser sign-in (ADR 0014), as an extension.
//
// The engine minted a CSRF `state`, opened the web login page, and waited for a
// deep link (apps/engine/src/routes/cloud.ts:85-118). Same flow here, with two
// platform facts driving the differences:
//
//   * `env.uriScheme` differs per editor — vscode, vscode-insiders, cursor,
//     windsurf, vscodium — and a VS Code URI handler only receives URIs whose
//     AUTHORITY is the extension id. So the callback is computed, never
//     hardcoded, and sent to the web page as `redirect_uri` (which validates
//     the scheme against its own allow-list before using it).
//   * `env.asExternalUri` is mandatory, not optional: without it Remote-SSH
//     and Codespaces never see the callback at all.
//
// The paste-a-code path is not a nicety. Linux deep links are genuinely
// unreliable, and it is the only sign-in that works when no handler is
// registered for the scheme.

import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import type { CloudClient } from "@promptconnext/pz-cloud";
import { readConfig } from "../config.ts";
import type { OutputLogger } from "../util/log.ts";

// `<publisher>.<name>` from package.json. The URI handler receives callbacks
// addressed to this exact authority and nothing else, so a rename here is a
// rename in package.json too — and both must be registered on the Marketplace
// and Open VSX before the first release.
export const EXTENSION_ID = "promptconnext.promptconnext-vscode";
const PENDING_STATE_KEY = "promptconnext.pendingLoginState";
const PENDING_STATE_TTL_MS = 10 * 60_000;

interface PendingState {
  state: string;
  createdAt: number;
}

export class SignInFlow {
  private readonly client: CloudClient;
  private readonly state: vscode.Memento;
  private readonly log: OutputLogger;

  constructor(
    client: CloudClient,
    state: vscode.Memento,
    log: OutputLogger,
  ) {
    this.client = client;
    this.state = state;
    this.log = log;
  }

  async start(): Promise<void> {
    const config = readConfig();
    if (!config.webUrl) {
      void vscode.window.showErrorMessage(
        "Set promptconnext.cloudWebUrl before signing in.",
      );
      return;
    }
    if (this.client.mode() === "stub") {
      await this.stubSignIn();
      return;
    }

    const state = randomBytes(16).toString("hex");
    // Held in globalState rather than a module variable: a window reload
    // between opening the browser and the callback would otherwise strand the
    // user with a state nothing can match. The server-side 120s code TTL still
    // bounds the credential itself.
    await this.state.update(PENDING_STATE_KEY, {
      state,
      createdAt: Date.now(),
    } satisfies PendingState);

    const callback = await vscode.env.asExternalUri(
      vscode.Uri.parse(`${vscode.env.uriScheme}://${EXTENSION_ID}/auth/callback`),
    );
    const url = vscode.Uri.parse(
      `${config.webUrl}/login?desktop=1&state=${encodeURIComponent(state)}` +
        `&redirect_uri=${encodeURIComponent(callback.toString(true))}`,
    );
    this.log.info(`opening sign-in for callback ${callback.toString(true)}`);
    await vscode.env.openExternal(url);

    const choice = await vscode.window.showInformationMessage(
      "Finish signing in to PromptConnext in your browser.",
      "Paste code instead",
    );
    if (choice === "Paste code instead") await this.withCode();
  }

  /** Manual fallback: the login page shows the code when the redirect never
   *  arrives, and this is where it goes. */
  async withCode(): Promise<void> {
    const code = await vscode.window.showInputBox({
      title: "PromptConnext sign-in code",
      prompt: "Paste the code shown in the browser.",
      ignoreFocusOut: true,
    });
    if (!code?.trim()) return;
    await this.redeem(code.trim());
  }

  /** Handle a callback URI. State must match, and is consumed either way. */
  async handleCallback(uri: vscode.Uri): Promise<void> {
    // microsoft/vscode#141640: the fragment is dropped before we get here, so
    // both values must arrive in the query string. They do — do not "tidy"
    // them into a hash at the web end.
    const params = new URLSearchParams(uri.query);
    const code = params.get("code");
    const state = params.get("state");
    const pending = this.state.get<PendingState>(PENDING_STATE_KEY);
    await this.state.update(PENDING_STATE_KEY, undefined);

    if (!code || !state) {
      void vscode.window.showWarningMessage("Sign-in callback was incomplete.");
      return;
    }
    if (
      !pending ||
      pending.state !== state ||
      Date.now() - pending.createdAt > PENDING_STATE_TTL_MS
    ) {
      // Either a stale attempt or someone else's callback. Refusing is the
      // whole point of the state parameter.
      void vscode.window.showWarningMessage(
        "Unexpected or expired sign-in. Start again from PromptConnext: Sign In.",
      );
      return;
    }
    await this.redeem(code);
  }

  private async redeem(code: string): Promise<void> {
    try {
      const session = await this.client.redeemDesktopCode(code);
      void vscode.window.showInformationMessage(
        `Signed in to PromptConnext as ${session.email ?? session.userId}.`,
      );
    } catch (err) {
      this.log.error(`redeem failed: ${String(err)}`);
      void vscode.window.showErrorMessage(
        `PromptConnext sign-in failed: ${String(err)}`,
      );
    }
  }

  private async stubSignIn(): Promise<void> {
    const userId = await vscode.window.showInputBox({
      title: "PromptConnext (local development)",
      prompt:
        "No Supabase configured, so the cloud is in stub auth mode. Enter a user id.",
      value: "dev-user",
      ignoreFocusOut: true,
    });
    if (!userId?.trim()) return;
    await this.client.signInStub(userId.trim());
    void vscode.window.showInformationMessage(`Signed in as ${userId.trim()} (stub).`);
  }
}
