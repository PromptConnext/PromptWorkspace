// The portable half of a PromptConnext task client.
//
// Everything here was `apps/vscode/src` until plan 0025 M1 needed a second
// consumer (`apps/mcp`). The selection rule is not "code that happened to be
// reusable" — it is the modules that never imported `vscode`, extracted because
// each holds an answer that must only ever be given once: the refresh coalescing
// in client.ts, the dedupe-by-task rule in queue.ts, the numeric ref
// normalisation in taskRefs.ts, the schema-version drop in cache.ts, and — since
// M2 — the remote-to-project matching in repoUrl.ts and the seeded-document
// paths in seededDocs.ts, where a disagreement between the two surfaces would
// resolve one clone to two different projects, or read two different files.
//
// What deliberately did NOT come across: the tree providers, the webview, the
// sign-in flow, the git bridge, and the status writer / task store (both need
// one small inversion first, and neither has a second consumer yet).
//
// Consumers import the package root; the modules keep their `.ts` specifiers
// because `node --test` type-strips rather than compiles, and that resolution
// is what the tests rely on.

export * from "./cache.ts";
export * from "./client.ts";
export * from "./errors.ts";
export * from "./queue.ts";
export * from "./repoUrl.ts";
export * from "./seededDocs.ts";
export * from "./session.ts";
export * from "./taskRefs.ts";
export * from "./types.ts";
