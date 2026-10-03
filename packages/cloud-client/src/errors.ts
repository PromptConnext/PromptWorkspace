// Ported from apps/engine/src/cloudClient.ts. `CloudHttpError.status` is the
// load-bearing part: callers branch on it (a 4xx never succeeds on retry, a
// 5xx does), so it must survive the port intact.

export class CloudNotConfiguredError extends Error {
  constructor() {
    super("PromptWorkspace cloud is not configured.");
    this.name = "CloudNotConfiguredError";
  }
}

export class CloudNotLoggedInError extends Error {
  constructor() {
    super("Not signed in to PromptWorkspace.");
    this.name = "CloudNotLoggedInError";
  }
}

export class CloudHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "CloudHttpError";
    this.status = status;
  }
}

/** A refresh the server definitively rejected — distinct from being offline,
 *  which must NOT sign the user out. */
export class CloudRefreshInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudRefreshInvalidError";
  }
}
