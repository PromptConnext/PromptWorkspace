// Edge runtime init (plan 0021 M2). Loaded by src/instrumentation.ts.
// Same options as the Node runtime — see src/lib/sentry.ts.
import * as Sentry from "@sentry/nextjs";

import { sentryOptions } from "@/lib/sentry";

Sentry.init(sentryOptions);
