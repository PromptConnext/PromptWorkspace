// Model credentials live in the OS keychain, never in SQLite or config files
// (architecture §1.2). Skeleton implementation shells out to the macOS
// `security` CLI; swap for a cross-platform keyring binding before shipping
// beyond macOS (see docs/decisions).
import { execFileSync } from "node:child_process";

const ACCOUNT = "promptzone";

function service(credentialRef: string): string {
  return `promptzone.${credentialRef}`;
}

export function storeSecret(credentialRef: string, secret: string): void {
  execFileSync(
    "security",
    ["add-generic-password", "-U", "-a", ACCOUNT, "-s", service(credentialRef), "-w", secret],
    { stdio: "pipe" },
  );
}

export function readSecret(credentialRef: string): string | null {
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

export function deleteSecret(credentialRef: string): void {
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
