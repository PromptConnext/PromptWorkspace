// Copies the build's own Node binary into the staged engine so the packaged
// app runs without a system Node (ADR 0001), same approach as
// apps/desktop/scripts/bundle-node.mjs. Using the build's Node
// (process.execPath) guarantees the ABI matches node-pty's prebuilt addon,
// which was installed with that same Node. Requires Node >= 24 (node:sqlite +
// native TS execution).
import { execPath, versions, exit } from "node:process";
import { copyFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

const major = Number(versions.node.split(".")[0]);
if (major < 24) {
  console.error(`[bundle-node] build Node ${versions.node} < 24 — engine needs Node >= 24`);
  exit(1);
}

const dest = join(".engine-pkg", process.platform === "win32" ? "node.exe" : "node");
if (!existsSync(join(".engine-pkg", "src", "index.ts"))) {
  console.error("[bundle-node] staged engine missing — run the hoisted deploy first");
  exit(1);
}

copyFileSync(execPath, dest);
if (process.platform !== "win32") {
  chmodSync(dest, 0o755);
}
console.log(`[bundle-node] bundled Node ${versions.node} -> ${dest}`);
