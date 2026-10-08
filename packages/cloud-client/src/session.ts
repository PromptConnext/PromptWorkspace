// Session storage. Ported from apps/engine/src/cloudClient.ts + keychain.ts.
//
// Deliberately free of `import * as vscode` — the extension injects the two
// small interfaces below, which is what lets this module (and the client that
// builds on it) be unit-tested by bare `node --test` with no editor host.
//
// Where things live, and why:
//   access + refresh token  -> SecretStorage
//   mode / userId / email   -> globalState
//
// The split is not decoration. On Linux with no available keyring VS Code
// falls back to in-memory secret storage, so tokens vanish on window reload.
// Keeping the *metadata* outside secrets means the UI can still say "signed
// out — sign in again" instead of rendering a blank void. The rule that
// follows: never store anything in secrets that a re-login cannot recover.

// PromiseLike, not Promise: VS Code's own SecretStorage and Memento return
// Thenable, so anything stricter would force a cast at the only call site that
// matters.
export interface SecretsLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export interface StorageLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface CloudSession {
  mode: "stub" | "supabase";
  userId: string;
  email?: string;
}

const ACCESS_SECRET = "promptworkspace.cloud.access";
const REFRESH_SECRET = "promptworkspace.cloud.refresh";
const SESSION_KEY = "promptworkspace.cloud.session";

/** Decode the `email` claim for display. NOT an auth decision — the signature
 *  is never verified here, and must never be trusted for one. Ported verbatim
 *  in intent from cloudClient.ts::emailFromAccessToken. */
export function emailFromAccessToken(token: string): string | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof json.email === "string" ? json.email : undefined;
  } catch {
    return undefined;
  }
}

export class SessionStore {
  private readonly secrets: SecretsLike;
  private readonly state: StorageLike;
  private readonly listeners = new Set<(s: CloudSession | null) => void>();

  constructor(secrets: SecretsLike, state: StorageLike) {
    this.secrets = secrets;
    this.state = state;
  }

  read(): CloudSession | null {
    return this.state.get<CloudSession>(SESSION_KEY) ?? null;
  }

  async accessToken(): Promise<string | undefined> {
    return this.secrets.get(ACCESS_SECRET);
  }

  async refreshToken(): Promise<string | undefined> {
    return this.secrets.get(REFRESH_SECRET);
  }

  async store(
    session: CloudSession,
    accessToken?: string,
    refreshToken?: string,
  ): Promise<void> {
    if (accessToken) await this.secrets.store(ACCESS_SECRET, accessToken);
    if (refreshToken) await this.secrets.store(REFRESH_SECRET, refreshToken);
    await this.state.update(SESSION_KEY, session);
    this.emit(session);
  }

  /** Callers must also drop the task cache and the pending-write queue: a
   *  queued status write belongs to the identity that made it and must never
   *  flush under the next user. `extension.ts` wires that; see onDidChange. */
  async clear(): Promise<void> {
    await this.secrets.delete(ACCESS_SECRET);
    await this.secrets.delete(REFRESH_SECRET);
    await this.state.update(SESSION_KEY, undefined);
    this.emit(null);
  }

  /** Sign out only if the stored refresh token is still `rejected`, read
   *  immediately before deleting. Every editor window shares these secrets, so
   *  an unconditional `clear()` after a rejection can delete the session a
   *  concurrent window has just stored. Returns whether it cleared. */
  async clearIfRefreshToken(rejected: string): Promise<boolean> {
    const current = await this.secrets.get(REFRESH_SECRET);
    if (current !== undefined && current !== rejected) return false;
    await this.clear();
    return true;
  }

  onDidChange(listener: (s: CloudSession | null) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private emit(session: CloudSession | null): void {
    for (const listener of this.listeners) listener(session);
  }
}
