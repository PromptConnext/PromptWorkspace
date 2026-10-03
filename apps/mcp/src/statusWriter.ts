// The only module in this server that writes task status.
//
// Ported from apps/vscode/src/tasks/statusWriter.ts, and the one rule worth
// porting is the branch below: a 5xx or a thrown network error means "try again
// later" and enters the queue; ANY 4xx means "this will never succeed", so the
// write is dropped and the reason surfaced. A queue that retries a 403 forever
// is the classic version of this bug, and plan 0025 §2 names that rule as the
// module's entire value.
//
// What did NOT come across, because nothing here has an analogue:
//   * the optimistic local update and its rollback — apps/vscode keeps a
//     TaskStore behind a tree view; this server holds no task cache and has no
//     pixels to correct, so there is nothing to roll back.
//   * `showWarningMessage` — the explanation is the tool's own result text
//     instead, which is the only channel an MCP caller has.
//   * the `silent` flag — it existed for the git watcher, and there is no
//     watcher here. The server writes only when asked.
//   * `onQueueChanged` — a badge callback. The queue's own size answers the
//     same question on demand, in `pending()`.
//
// One deliberate difference from the reference: `CloudNotLoggedInError` and
// `CloudNotConfiguredError` are rethrown rather than queued. They are not
// "offline" — no amount of retrying fixes an absent session — and server.ts's
// catch block already turns them into the one message that does help ("run
// promptworkspace-mcp login"). apps/vscode reaches the same conclusion by showing
// a toast and dropping the write.

import {
  CloudHttpError,
  CloudNotConfiguredError,
  CloudNotLoggedInError,
  type CloudClient,
  type LoggerLike,
  type StatusArtifact,
  type StatusQueue,
  type TaskStatus,
} from "@promptworkspace/cloud-client";

export interface StatusWriteRequest {
  projectId: string;
  taskId: string;
  status: TaskStatus;
  artifact?: StatusArtifact;
}

/** Three outcomes, and `queued` is not one of the failures: the write is
 *  accepted and will land, which a caller must be able to tell apart from a
 *  refusal it has to act on. */
export type StatusWriteOutcome =
  | { kind: "written" }
  | { kind: "queued"; reason: string }
  | { kind: "refused"; message: string };

export interface QueueState {
  size: number;
  /** Entries that have exhausted their attempts. Backoff-then-park is
   *  deliberate (see packages/cloud-client/src/queue.ts): an entry that has failed
   *  four times needs a human to look, not a tighter loop. */
  parked: number;
}

export class StatusWriter {
  private readonly client: CloudClient;
  private readonly queue: StatusQueue;
  private readonly log: LoggerLike;

  constructor(client: CloudClient, queue: StatusQueue, log: LoggerLike) {
    this.client = client;
    this.queue = queue;
    this.log = log;
  }

  async setStatus(req: StatusWriteRequest): Promise<StatusWriteOutcome> {
    try {
      await this.client.patchTaskStatus(req.projectId, req.taskId, {
        status: req.status,
        artifact: req.artifact,
      });
      return { kind: "written" };
    } catch (err) {
      if (err instanceof CloudHttpError && err.status >= 400 && err.status < 500) {
        this.log.warn(`status write refused (${err.status}): ${err.message}`);
        return { kind: "refused", message: explain(err) };
      }
      if (err instanceof CloudNotLoggedInError || err instanceof CloudNotConfiguredError) {
        throw err;
      }
      await this.queue.enqueue({
        projectId: req.projectId,
        taskId: req.taskId,
        status: req.status,
        artifact: req.artifact,
      });
      const reason = err instanceof Error ? err.message : String(err);
      this.log.info(`status write queued: ${req.taskId} -> ${req.status} (${reason})`);
      return { kind: "queued", reason };
    }
  }

  /** Flush whatever the queue holds. Safe to call often — entries are due-gated
   *  by their own backoff, so a call that is too early is a no-op rather than a
   *  wasted attempt.
   *
   *  There is no timer behind this and deliberately so: an MCP client may kill
   *  this process between any two calls, so a background interval would be work
   *  nobody accounts for. The two callers are the start of a `close_task` and
   *  server startup, which is every moment this process is known to be alive
   *  and talking to the cloud. */
  flush(): Promise<{ sent: number; failed: number }> {
    return this.queue.flush(async (entry) => {
      await this.client.patchTaskStatus(entry.projectId, entry.taskId, {
        status: entry.status,
        artifact: entry.artifact,
      });
    });
  }

  async pending(): Promise<QueueState> {
    await this.queue.load();
    return { size: this.queue.size(), parked: this.queue.parked().length };
  }
}

/** The cloud's refusal codes, in the developer's words. The list is
 *  apps/cloud/app/api/sync.py::set_task_status's — keep them in step. */
function explain(err: CloudHttpError): string {
  switch (err.message) {
    case "status_forbidden":
      return (
        "That task is assigned to someone else, or to nobody. PromptWorkspace only " +
        "lets you close your own work — ask an admin to assign it to you."
      );
    case "verified_requires_admin":
      return (
        "Only a workspace admin can mark a task verified. Close it as " +
        "`implemented`; verification is someone else's call."
      );
    case "task_not_found":
      return "That task no longer exists in the cloud.";
    default:
      return `PromptWorkspace refused the update: ${err.message}`;
  }
}
