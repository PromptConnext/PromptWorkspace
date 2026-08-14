// Bundle the extension into a single CommonJS file.
//
// The rest of this repo runs TypeScript unbundled (apps/engine) or through a
// framework's own bundler (Vite, Next). A VSIX is different: it ships into
// someone else's process. Unbundled, `vsce package` walks node_modules and the
// extension host cold-requires every one of those files at activation.
// esbuild is what the VS Code toolchain standardises on, so this is one file
// with no config framework rather than a new build system for the repo.

import { build, context } from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  // Injected by the extension host; bundling it produces a module that cannot
  // load at all.
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  // Conservative against the Electron Node floor at our engines.vscode floor.
  target: "node18",
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
