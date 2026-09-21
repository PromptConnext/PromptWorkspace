// Node runtime init (plan 0021 M2). Loaded by src/instrumentation.ts.
// Options, and the reasoning behind every disabled default, live in
// src/lib/sentry.ts — this file exists only because Next.js needs a separate
// module per runtime to import.
import * as Sentry from "@sentry/nextjs";

import { sentryOptions } from "@/lib/sentry";

Sentry.init(sentryOptions);
