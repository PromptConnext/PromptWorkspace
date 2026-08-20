// apps/web/src/components/project/previewState.ts
//
// The Preview tab's state machine, as pure functions.
//
// Kept out of the component for the same reason taskPermissions.ts is: five
// states with real branching are worth testing without a DOM, and a rule you
// can read in one place is a rule that stays correct.
//
// The honest part of this file is `resolvePreview`'s handling of embedding.
// A browser cannot tell an embedded page from a blocked one: a frame refused
// by X-Frame-Options or a CSP still fires `load`, never fires `error`, and
// its document and location are unreadable cross-origin. So embeddability is
// decided by two things the browser *can* be told — the server's header probe
// (`frame_policy`, measured after each successful deploy) and the scaffold's
// postMessage handshake (positive proof the frame actually rendered) — and
// the absence of either is treated as "not confirmed", never as "refused".

import type { DeploymentStatus } from "@/lib/types";

export type PreviewMode =
  | "empty" // no template chosen — nothing will ever deploy
  | "waiting" // template chosen, first deploy not reported yet
  | "building" // a deploy is in flight
  | "embed" // live, and framing is believed to work
  | "link" // live, but framing is refused or unconfirmed
  | "failed"; // the newest deploy failed

export interface PreviewView {
  mode: PreviewMode;
  url: string | null;
  /** True while the poller should keep running. */
  polling: boolean;
  /** One sentence explaining a link-card fallback, or null. */
  fallbackReason: string | null;
}

/** Whether the deploy history says anything is still moving. */
export function isPending(status: DeploymentStatus | null): boolean {
  return !!status && status.pending > 0;
}

export function resolvePreview(
  status: DeploymentStatus | null,
  /** Has the embedded page announced itself via postMessage? */
  handshake: "pending" | "confirmed" | "timed-out",
): PreviewView {
  if (!status || status.state === "not_configured") {
    return { mode: "empty", url: null, polling: false, fallbackReason: null };
  }

  const polling = status.pending > 0;

  if (status.state === "awaiting_first_deploy") {
    return { mode: "waiting", url: status.url, polling: true, fallbackReason: null };
  }
  if (status.state === "queued" || status.state === "building") {
    return { mode: "building", url: status.url, polling: true, fallbackReason: null };
  }
  if (status.state === "failed") {
    // Deliberately still carries `url`: the last good deploy is usually still
    // serving, and taking the business user's link away because a later build
    // broke would be the wrong side to err on.
    return { mode: "failed", url: status.url, polling, fallbackReason: null };
  }

  if (!status.url) {
    return { mode: "waiting", url: null, polling, fallbackReason: null };
  }

  const framePolicy = status.last_deploy?.frame_policy ?? null;

  if (!status.embeddable || framePolicy === "deny") {
    return {
      mode: "link",
      url: status.url,
      polling,
      fallbackReason: "This application asks not to be displayed inside another page.",
    };
  }

  if (handshake === "timed-out") {
    return {
      mode: "link",
      url: status.url,
      polling,
      // Not "it refuses embedding" — the absence of a handshake is genuinely
      // ambiguous, and claiming a refusal we did not observe would be a lie
      // the user cannot check.
      fallbackReason: "We could not confirm the preview loaded here.",
    };
  }

  return { mode: "embed", url: status.url, polling, fallbackReason: null };
}

/** A message is ours only if it came from the deployed origin and carries our tag. */
export function isPreviewReadyMessage(data: unknown, origin: string, url: string): boolean {
  if (!data || typeof data !== "object") return false;
  if ((data as { pz?: unknown }).pz !== "preview-ready") return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** Short, human commit reference for the status line. */
export function shortSha(sha: string | null | undefined): string | null {
  return sha ? sha.slice(0, 7) : null;
}
