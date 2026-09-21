import path from "node:path";
import { defineConfig } from "vitest/config";

// Added by plan 0021 M2. Plan 0021 §1 recorded that `apps/corp` was the only
// app with no test framework at all, and deferred adding one to the pricing-page
// rewrite — but M2 puts a security-critical scrub (src/lib/sentry.ts, which
// decides what a visitor's contact-form submission and this app's one server
// secret are allowed to leak) into it, and that cannot ship unverified just
// because the runner was scheduled for later.
//
// Deliberately narrow: no `environment: "happy-dom"` and no React plugin,
// because nothing here renders a component. `node` keeps the suite to the pure
// modules that are worth testing without inviting a DOM-testing stack in.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
