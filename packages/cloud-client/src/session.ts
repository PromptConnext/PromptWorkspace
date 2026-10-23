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

/** Which window may refresh the shared session right now (finding #50a).
 *  `until` is epoch ms on the holder's clock; a lease past it is free to take,
 *  so a window that crashed mid-refresh cannot block the others for good. */
export interface RefreshLease {
  owner: string;
  until: number;
}

/** Where the refresh lease lives. Deliberately NOT the session's `state`:
 *  VS Code's globalState is one JSON blob per extension, and a write from a
 *  window holding a stale copy replaces the whole blob in every other window,
 *  so a lease written there could revert another window's sign-in or
 *  sign-out. apps/vscode injects a small file of its own in the extension's
 *  global storage directory (see `fileLeaseStorage`). */
export interface LeaseStorageLike {
  read(scope: string): PromiseLike<RefreshLease | undefined>;
  write(scope: string, lease: RefreshLease | undefined): PromiseLike<void>;
}

/** The default: a lease only this process sees. Correct for a single process
 *  (apps/mcp), where it reduces to the in-process refresh coalescing. */
export function memoryLeaseStorage(): LeaseStorageLike {
  const current = new Map<string, RefreshLease>();
  return {
    async read(scope) {
      return current.get(scope);
    },
    async write(scope, lease) {
      if (lease) current.set(scope, lease);
      else current.delete(scope);
    },
  };
}

/** A lease kept in its own file, through the same atomic write-then-rename
 *  file store the JSON cache uses. Every window of one editor profile shares
 *  the extension's global storage directory, and a file is visible to all of
 *  them as soon as it is renamed into place — no broadcast delay, and no other
 *  key travels with it. Anything unreadable is "no lease". */
export function fileLeaseStorage(
  files: { read(name: string): Promise<string | undefined>; write(name: string, contents: string): Promise<void> },
): LeaseStorageLike {
  // A scope is a host, so it is safe in a file name.
  const nameFor = (scope: string) => (scope ? `refresh-lease@${scope}.json` : "refresh-lease.json");
  return {
    async read(scope) {
      const raw = await files.read(nameFor(scope)).catch(() => undefined);
      if (!raw) return undefined;
      try {
        const lease = JSON.parse(raw) as RefreshLease | null;
        return lease && typeof lease.owner === "string" && typeof lease.until === "number"
          ? lease
          : undefined;
      } catch {
        return undefined;
      }
    },
    async write(scope, lease) {
      await files.write(nameFor(scope), JSON.stringify(lease ?? null));
    },
  };
}

const ACCESS_SECRET = "promptworkspace.cloud.access";
const REFRESH_SECRET = "promptworkspace.cloud.refresh";
const SESSION_KEY = "promptworkspace.cloud.session";

/** Decode the `email` claim for display. NOT an auth decision — the signature
 *  is never verified here, and must never be trusted for one. Ported verbatim
 *  in intent from cloudClient.ts::emailFromAccessToken. */
export function emailFromAccessToken(token: string): string | undefined {
  const email = jwtClaims(token)?.email;
  return typeof email === "string" ? email : undefined;
}

/** Decode a JWT payload without verifying it. Display and routing only. */
function jwtClaims(token: string): Record<string, unknown> | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return json && typeof json === "object" ? json : undefined;
  } catch {
    return undefined;
  }
}

/** The host of the token's `iss` claim. Like `emailFromAccessToken`, never an
 *  auth decision: it only says which environment a stored token came from. */
export function issuerHost(accessToken: string): string | undefined {
  const iss = jwtClaims(accessToken)?.iss;
  if (typeof iss !== "string") return undefined;
  try {
    return new URL(iss).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Which environment a window points at: the Supabase host, else the API host,
 *  else "" (the unscoped 0.3.0 keys). Windows on different environments must
 *  not share a session, or one's refresh would clear the other's. */
export function environmentScope(cfg: { supabaseUrl: string; apiUrl: string }): string {
  for (const url of [cfg.supabaseUrl, cfg.apiUrl]) {
    try {
      const host = new URL(url).host.toLowerCase();
      if (host) return host;
    } catch {
      /* try the next one */
    }
  }
  return "";
}

export class SessionStore {
  private readonly secrets: SecretsLike;
  private readonly state: StorageLike;
  private readonly leases: LeaseStorageLike;
  private readonly scope: () => string;
  private readonly listeners = new Set<(s: CloudSession | null) => void>();

  /** `scope` names the environment; read on every call so a settings change
   *  takes effect without a new store. Empty keeps the bare 0.3.0 keys. */
  constructor(
    secrets: SecretsLike,
    state: StorageLike,
    leases: LeaseStorageLike = memoryLeaseStorage(),
    scope: () => string = () => "",
  ) {
    this.secrets = secrets;
    this.state = state;
    this.leases = leases;
    this.scope = scope;
  }

  private key(base: string): string {
    const scope = this.scope();
    return scope ? `${base}@${scope}` : base;
  }

  read(): CloudSession | null {
    return this.state.get<CloudSession>(this.key(SESSION_KEY)) ?? null;
  }

  async accessToken(): Promise<string | undefined> {
    return this.secrets.get(this.key(ACCESS_SECRET));
  }

  async refreshToken(): Promise<string | undefined> {
    return this.secrets.get(this.key(REFRESH_SECRET));
  }

  /** Emit `read()` under the current scope; call after a settings change. */
  rescope(): void {
    this.emit(this.read());
  }

  /** Move a pre-scoping session under the current scope, but only into the
   *  environment that minted it: a supabase record whose token was issued by
   *  another host stays put for that host's window to adopt. */
  async adoptLegacySession(): Promise<boolean> {
    const scope = this.scope();
    if (!scope || this.read()) return false;
    const record = this.state.get<CloudSession>(SESSION_KEY);
    if (!record) return false;
    const access = await this.secrets.get(ACCESS_SECRET);
    if (record.mode === "supabase" && (!access || issuerHost(access) !== scope)) return false;
    const refresh = await this.secrets.get(REFRESH_SECRET);
    await this.store(record, access, refresh);
    await this.secrets.delete(ACCESS_SECRET);
    await this.secrets.delete(REFRESH_SECRET);
    await this.state.update(SESSION_KEY, undefined);
    return true;
  }

  async store(
    session: CloudSession,
    accessToken?: string,
    refreshToken?: string,
  ): Promise<void> {
    if (accessToken) await this.secrets.store(this.key(ACCESS_SECRET), accessToken);
    if (refreshToken) await this.secrets.store(this.key(REFRESH_SECRET), refreshToken);
    await this.state.update(this.key(SESSION_KEY), session);
    this.emit(session);
  }

  /** Callers must also drop the task cache. The pending-write queue is
   *  dropped only on a sign-out the user asked for: each entry records the
   *  environment and account that made it, so one kept through an involuntary
   *  clear never flushes under the next user. `extension.ts` wires that; see
   *  onDidChange. */
  async clear(): Promise<void> {
    await this.secrets.delete(this.key(ACCESS_SECRET));
    await this.secrets.delete(this.key(REFRESH_SECRET));
    await this.state.update(this.key(SESSION_KEY), undefined);
    this.emit(null);
  }

  /** Sign out only if the stored refresh token is still `rejected`, read
   *  immediately before deleting. Every editor window shares these secrets, so
   *  an unconditional `clear()` after a rejection can delete the session a
   *  concurrent window has just stored. Returns whether it cleared. */
  async clearIfRefreshToken(rejected: string): Promise<boolean> {
    const current = await this.secrets.get(this.key(REFRESH_SECRET));
    if (current !== undefined && current !== rejected) return false;
    await this.clear();
    return true;
  }

  /** The refresh lease (see LeaseStorageLike). There is no compare-and-set
   *  across windows, so CloudClient writes, waits a moment and reads back
   *  before trusting it holds the lease — and survives being wrong. */
  async readRefreshLease(): Promise<RefreshLease | undefined> {
    try {
      return await this.leases.read(this.scope());
    } catch {
      return undefined;
    }
  }

  /** Never throws: a lease that cannot be written (two windows renaming the
   *  same temp file) only costs the de-duplication, never the refresh. */
  async writeRefreshLease(lease: RefreshLease | undefined): Promise<void> {
    try {
      await this.leases.write(this.scope(), lease);
    } catch {
      /* best-effort by design */
    }
  }

  onDidChange(listener: (s: CloudSession | null) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private emit(session: CloudSession | null): void {
    for (const listener of this.listeners) listener(session);
  }
}
