// Production client defaults — the one place they are written down.
//
// apps/mcp imports this object for its DEFAULTS. apps/vscode cannot import
// anything into package.json's `contributes.configuration`, so its four
// `promptworkspace.*` defaults are literal copies, and test/defaults.test.ts
// fails if either side drifts from this file. Develop/staging is reached by
// overriding all four (VS Code settings, or PROMPTWORKSPACE_* env for MCP).
//
// The Supabase URL and publishable key are public by design (sent as the
// `apikey` header, never as a bearer). Until the production Supabase project
// exists they are placeholders, and scripts/assert-defaults-filled.mjs (run by
// apps/vscode `vscode:prepublish` and apps/mcp `prepack`) refuses to package a
// release while they remain.

export interface ClientDefaults {
  cloudApiUrl: string;
  cloudWebUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export const PRODUCTION_DEFAULTS: Readonly<ClientDefaults> = Object.freeze({
  cloudApiUrl: "https://api.workspace.promptconnext.com",
  cloudWebUrl: "https://workspace.promptconnext.com",
  supabaseUrl: "__PROD_SUPABASE_URL__",
  supabaseAnonKey: "__PROD_SUPABASE_PUBLISHABLE_KEY__",
});
