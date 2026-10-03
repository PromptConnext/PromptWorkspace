// Where the session lives when there is no SecretStorage.
//
// Ported from apps/engine/src/keychain.ts: the macOS `security` CLI and Windows
// DPAPI through PowerShell, both already written there, neither needing a native
// addon. That module has no Linux branch — ADR 0019 names the gap — so this one
// adds the honest first answer, a 0600 file under the user's config directory.
//
// Read apps/mcp/README.md before assuming what that buys. On Linux any process
// running as the same user can read the file, and Windows DPAPI does not isolate
// from same-session applications either: the guarantee is "not plaintext in your
// dotfiles", not "isolated from local software".
//
// What follows from that is the rule apps/vscode/src/session.ts already states
// and this file keeps: store only the access and refresh tokens — nothing a
// re-login cannot recover. The session *metadata* (mode, user id, email) goes in
// a plain JSON file instead, so that a keychain this process cannot reach
// degrades into "signed out, sign in again" rather than a blank void.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SecretsLike, StorageLike } from "@promptworkspace/cloud-client";

// Distinct from apps/engine's keychain account ("promptworkspace"), so the two
// never read or overwrite each other's items on a machine running both.
const ACCOUNT = "promptworkspace-mcp";

const STATE_FILE = "session.json";
/** The pending status writes, in their own file beside the session. Same class,
 *  a different name: M3's queue needs exactly what `JsonState` already does —
 *  a 0600 JSON file in the config directory — and a third copy of that logic is
 *  a third place for the mode bits to be wrong. */
export const QUEUE_FILE = "queue.json";
const SECRETS_SUBDIR = "secrets";

// ------------------------------------------------------------------- macOS

function darwinStore(key: string, secret: string): void {
  execFileSync(
    "security",
    ["add-generic-password", "-U", "-a", ACCOUNT, "-s", key, "-w", secret],
    { stdio: "pipe" },
  );
}

function darwinRead(key: string): string | undefined {
  try {
    return execFileSync("security", ["find-generic-password", "-a", ACCOUNT, "-s", key, "-w"], {
      stdio: "pipe",
    })
      .toString()
      .replace(/\n$/, "");
  } catch {
    return undefined;
  }
}

function darwinDelete(key: string): void {
  try {
    execFileSync("security", ["delete-generic-password", "-a", ACCOUNT, "-s", key], {
      stdio: "pipe",
    });
  } catch {
    // absent is fine
  }
}

// ----------------------------------------------------------------- Windows

function windowsStore(file: string, secret: string): void {
  const encrypted = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$s = [Console]::In.ReadLine(); ConvertTo-SecureString -String $s -AsPlainText -Force | ConvertFrom-SecureString",
    ],
    { input: secret, stdio: ["pipe", "pipe", "pipe"] },
  )
    .toString()
    .trim();
  writeFileSync(file, encrypted, { encoding: "utf8", mode: 0o600 });
}

function windowsRead(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const encrypted = readFileSync(file, "utf8").trim();
  try {
    return execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$e = [Console]::In.ReadLine(); $sec = $e | ConvertTo-SecureString; " +
          "[Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))",
      ],
      { input: encrypted, stdio: ["pipe", "pipe", "pipe"] },
    )
      .toString()
      .replace(/\r?\n$/, "");
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------- Linux

function fileStore(file: string, secret: string): void {
  writeFileSync(file, secret, { encoding: "utf8", mode: 0o600 });
}

function fileRead(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------- store

/** SessionStore's secret half, backed by the platform's best available store.
 *
 *  Synchronous underneath (the engine's port is `execFileSync`) but async at the
 *  surface, because `SecretsLike` is the interface apps/vscode wrote for VS
 *  Code's genuinely-async SecretStorage and cloud-client is shared with it. */
export class KeychainSecrets implements SecretsLike {
  private readonly dir: string;

  constructor(configDir: string) {
    this.dir = join(configDir, SECRETS_SUBDIR);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  /** Key -> a filename, for the two branches that write files. Hashed for the
   *  same reason apps/engine does it: the key is a dotted namespace, not a safe
   *  path component. */
  private fileFor(key: string): string {
    return join(this.dir, `${createHash("sha256").update(`${ACCOUNT}.${key}`).digest("hex")}.dat`);
  }

  async get(key: string): Promise<string | undefined> {
    if (process.platform === "darwin") return darwinRead(key);
    if (process.platform === "win32") return windowsRead(this.fileFor(key));
    return fileRead(this.fileFor(key));
  }

  async store(key: string, value: string): Promise<void> {
    if (process.platform === "darwin") return darwinStore(key, value);
    if (process.platform === "win32") return windowsStore(this.fileFor(key), value);
    return fileStore(this.fileFor(key), value);
  }

  async delete(key: string): Promise<void> {
    if (process.platform === "darwin") return darwinDelete(key);
    rmSync(this.fileFor(key), { force: true });
  }
}

/** SessionStore's metadata half: mode, user id, email. Not secret, but 0600
 *  anyway — an email address is still the user's. Also the status queue's
 *  backing store, under a file name of its own. */
export class JsonState implements StorageLike {
  private readonly file: string;
  private cache: Record<string, unknown> | undefined;

  constructor(configDir: string, file: string = STATE_FILE) {
    this.file = join(configDir, file);
  }

  private load(): Record<string, unknown> {
    if (this.cache) return this.cache;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      this.cache = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  get<T>(key: string): T | undefined {
    return this.load()[key] as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    const state = this.load();
    if (value === undefined) delete state[key];
    else state[key] = value;
    writeFileSync(this.file, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}
