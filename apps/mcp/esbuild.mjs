// Bundle the server into a single CommonJS file.
//
// Same reasoning as apps/vscode/esbuild.mjs, one step further: this ships to npm
// and is invoked through `npx`, so every unbundled file is a file the developer
// waits to download on first run and a chance for a transitive dependency to
// resolve differently on their machine than on ours. One file, no config
// framework, and no new build system for the repo.
//
// apps/engine runs TypeScript unbundled on Node 24 and must keep doing so
// (CLAUDE.md: "no build step for the engine"). That rule is about the engine,
// which the user already has on disk; it does not extend to something fetched
// on demand.

import { build, context } from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: ["src/index.ts"],
  bundle: true,
  outfile: "dist/index.js",
  format: "cjs",
  platform: "node",
  // package.json's `engines.node`. The SDK's own floor is 18 too.
  target: "node20",
  // No `banner` here: esbuild carries the entry point's own shebang through to
  // the bundle, and adding one produces two — the second of which is a syntax
  // error rather than a comment.
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: "warning",
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("[esbuild] watching");
} else {
  await build(options);
}
