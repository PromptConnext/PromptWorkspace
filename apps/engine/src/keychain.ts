// Model credentials live in the OS keychain, never in SQLite or config files
// (architecture §1.2). macOS shells out to the `security` CLI. Windows uses
// DPAPI (via PowerShell's ConvertTo/From-SecureString) to encrypt secrets at
// rest under %APPDATA%, user-scoped like Credential Manager, without a
// native node addon — keeping platform-bound prebuilds (see node-pty,
// docs/DEVELOPMENT.md) out of this path. Linux (libsecret) is not yet
// implemented.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ACCOUNT = "promptworkspace";

function service(credentialRef: string): string {
  return `promptworkspace.${credentialRef}`;
}

function darwinStore(credentialRef: string, secret: string): void {
  execFileSync(
    "security",
    ["add-generic-password", "-U", "-a", ACCOUNT, "-s", service(credentialRef), "-w", secret],
    { stdio: "pipe" },
  );
}

function darwinRead(credentialRef: string): string | null {
  try {
    return execFileSync(
      "security",
      ["find-generic-password", "-a", ACCOUNT, "-s", service(credentialRef), "-w"],
      { stdio: "pipe" },
    )
      .toString()
      .replace(/\n$/, "");
  } catch {
    return null;
  }
}

function darwinDelete(credentialRef: string): void {
  try {
    execFileSync(
      "security",
      ["delete-generic-password", "-a", ACCOUNT, "-s", service(credentialRef)],
      { stdio: "pipe" },
    );
  } catch {
    // absent is fine
  }
}

function credentialDir(): string {
  const dir = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "promptworkspace", "credentials");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function credentialFile(credentialRef: string): string {
  const hash = createHash("sha256").update(service(credentialRef)).digest("hex");
  return join(credentialDir(), `${hash}.dat`);
}

function windowsStore(credentialRef: string, secret: string): void {
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
  writeFileSync(credentialFile(credentialRef), encrypted, "utf8");
}

function windowsRead(credentialRef: string): string | null {
  const file = credentialFile(credentialRef);
  if (!existsSync(file)) return null;
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
    return null;
  }
}

function windowsDelete(credentialRef: string): void {
  const file = credentialFile(credentialRef);
  if (existsSync(file)) unlinkSync(file);
}

export function storeSecret(credentialRef: string, secret: string): void {
  if (process.platform === "win32") return windowsStore(credentialRef, secret);
  return darwinStore(credentialRef, secret);
}

export function readSecret(credentialRef: string): string | null {
  if (process.platform === "win32") return windowsRead(credentialRef);
  return darwinRead(credentialRef);
}

export function deleteSecret(credentialRef: string): void {
  if (process.platform === "win32") return windowsDelete(credentialRef);
  return darwinDelete(credentialRef);
}
