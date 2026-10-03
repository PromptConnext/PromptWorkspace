// The only module that writes task status. Everything else asks it to.
//
// The retry rule is the important part: a 5xx or a thrown network error means
// "try again later" and enters the queue; ANY 4xx means "this will never
// succeed", so the optimistic update is rolled back, the message is shown, and
// the write is dropped. A queue that retries a 403 forever is the classic
// version of this bug.

import * as vscode from "vscode";
import { CloudHttpError, CloudNotLoggedInError } from "@promptworkspace/cloud-client";
import type { CloudClient } from "@promptworkspace/cloud-client";
import type { StatusArtifact, TaskStatus } from "@promptworkspace/cloud-client";
import type { OutputLogger } from "../util/log.ts";
import type { StatusQueue } from "@promptworkspace/cloud-client";
import type { TaskStore } from "./taskStore.ts";

export interface StatusWriteRequest {
  projectId: string;
  taskId: string;
  status: TaskStatus;
  artifact?: StatusArtifact;
  /** Suppresses the error toast for writes the user did not initiate — the
   *  git watcher should not interrupt a commit with a modal-ish popup. */
  silent?: boolean;
}

export class StatusWriter {
  private readonly client: CloudClient;
  private readonly store: TaskStore;
  private readonly queue: StatusQueue;
  private readonly log: OutputLogger;
  private readonly onQueueChanged: () => void;

  constructor(
    client: CloudClient,
    store: TaskStore,
    queue: StatusQueue,
    log: OutputLogger,
    onQueueChanged: () => void,
  ) {
    this.client = client;
    this.store = store;
    this.queue = queue;
    this.log = log;
    this.onQueueChanged = onQueueChanged;
  }

  async setStatus(req: StatusWriteRequest): Promise<boolean> {
    const previous = this.store.applyLocalStatus(req.taskId, req.status);
    try {
      await this.client.patchTaskStatus(req.projectId, req.taskId, {
        status: req.status,
        artifact: req.artifact,
      });
      await this.store.refresh();
      return true;
    } catch (err) {
      if (err instanceof CloudHttpError && err.status >= 400 && err.status < 500) {
        if (previous) this.store.applyLocalStatus(req.taskId, previous);
        const message = this.explain(err);
        this.log.warn(`status write refused (${err.status}): ${err.message}`);
        if (!req.silent) void vscode.window.showWarningMessage(message);
        return false;
      }
      if (err instanceof CloudNotLoggedInError) {
        if (previous) this.store.applyLocalStatus(req.taskId, previous);
        if (!req.silent) {
          void vscode.window.showWarningMessage("Sign in to PromptWorkspace first.");
        }
        return false;
      }
      // Offline or server-side: keep the optimistic update and queue the write.
      await this.queue.enqueue({
        projectId: req.projectId,
        taskId: req.taskId,
        status: req.status,
        artifact: req.artifact,
      });
      this.onQueueChanged();
      this.log.info(`status write queued: ${req.taskId} -> ${req.status}`);
      return false;
    }
  }

  /** Flush anything the queue holds. Safe to call often — entries are due-gated. */
  async flush(): Promise<void> {
    const { sent, failed } = await this.queue.flush(async (entry) => {
      await this.client.patchTaskStatus(entry.projectId, entry.taskId, {
        status: entry.status,
        artifact: entry.artifact,
      });
    });
    if (sent > 0) {
      this.log.info(`flushed ${sent} pending status write(s)`);
      await this.store.refresh();
    }
    if (sent > 0 || failed > 0) this.onQueueChanged();
  }

  private explain(err: CloudHttpError): string {
    switch (err.message) {
      case "status_forbidden":
        return "That task is assigned to someone else. Claim it first, or ask an admin.";
      case "verified_requires_admin":
        return "Only a workspace admin can mark a task verified.";
      case "task_not_found":
        return "That task no longer exists in the cloud. Refreshing.";
      default:
        return `PromptWorkspace refused the update: ${err.message}`;
    }
  }
}
