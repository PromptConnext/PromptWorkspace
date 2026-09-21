// Browser init (plan 0021 M2). Next.js 15.3+ loads this in place of the older
// sentry.client.config.ts. Options live in src/lib/sentry.ts; with
// NEXT_PUBLIC_SENTRY_DSN unset this is a no-op.
//
// Deliberately no `replayIntegration`: session replay records the DOM, and
// this app's DOM is the customer's task graph, stage documents and discussion
// threads. Nothing in M2 needs it.
import * as Sentry from "@sentry/nextjs";

import { sentryOptions } from "@/lib/sentry";

Sentry.init(sentryOptions);
