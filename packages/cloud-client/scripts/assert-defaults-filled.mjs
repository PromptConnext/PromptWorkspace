// Release gate: exits non-zero while src/defaults.ts still holds `__PROD_`
// placeholders. Wired into apps/vscode `vscode:prepublish` (so `vsce package`
// and `vsce publish` both run it) and apps/mcp `prepack` (so `pnpm pack` does).
// It is deliberately not part of the always-on test suite: the placeholders are
// expected until the production Supabase project exists (plan P0b.7), and CI
// must stay green until then. An extension shipped with them runs against a
// URL that does not resolve, so a release must never skip this.
//
// Run:  node packages/cloud-client/scripts/assert-defaults-filled.mjs

import { PRODUCTION_DEFAULTS } from "../src/defaults.ts";

const problems = [];
for (const [field, value] of Object.entries(PRODUCTION_DEFAULTS)) {
  if (value === "") problems.push(`${field} is empty`);
  else if (/^__PROD_/.test(value)) problems.push(`${field} is still a placeholder (${value})`);
}
if (!problems.length && !/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(PRODUCTION_DEFAULTS.supabaseUrl)) {
  problems.push(`supabaseUrl is not a https://<ref>.supabase.co URL (${PRODUCTION_DEFAULTS.supabaseUrl})`);
}

if (problems.length) {
  console.error("packages/cloud-client/src/defaults.ts is not ready for a release:");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("Fill in the production Supabase URL and publishable key first (docs/DEPLOYMENT.md §3A).");
  process.exit(1);
}
console.log("production client defaults are filled");
