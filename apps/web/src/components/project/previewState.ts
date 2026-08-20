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

/**
 * The URL if it is safe to put in an `href` or an `iframe src`, else null.
 *
 * The cloud already refuses a non-http(s) `environment_url` on the storage
 * path, so this is the second half of a defence in depth rather than the
 * only check — and it is worth having because this value's provenance is a
 * webhook payload written by whoever can push to the project repo. React
 * does not sanitise `href`, so a `javascript:` URL reaching this component
 * would execute in the workspace's own origin the moment a member clicked
 * the link — and an `iframe src` would not even need the click.
 *
 * Relative URLs are refused too: this is always an absolute address on
 * someone else's host, so a relative one means something upstream is wrong.
 */
export function safeWebUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
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
  // Checked once, here, so no branch below can leak an unchecked URL into an
  // href or an iframe src.
  const url = safeWebUrl(status.url);

  if (status.state === "awaiting_first_deploy") {
    return { mode: "waiting", url, polling: true, fallbackReason: null };
  }
  if (status.state === "queued" || status.state === "building") {
    return { mode: "building", url, polling: true, fallbackReason: null };
  }
  if (status.state === "failed") {
    // Deliberately still carries `url`: the last good deploy is usually still
    // serving, and taking the business user's link away because a later build
    // broke would be the wrong side to err on.
    return { mode: "failed", url, polling, fallbackReason: null };
  }

  if (!url) {
    return { mode: "waiting", url: null, polling, fallbackReason: null };
  }

  const framePolicy = status.last_deploy?.frame_policy ?? null;

  if (!status.embeddable || framePolicy === "deny") {
    return {
      mode: "link",
      url,
      polling,
      fallbackReason: "This application asks not to be displayed inside another page.",
    };
  }

  if (handshake === "timed-out") {
    return {
      mode: "link",
      url,
      polling,
      // Not "it refuses embedding" — the absence of a handshake is genuinely
      // ambiguous, and claiming a refusal we did not observe would be a lie
      // the user cannot check.
      fallbackReason: "We could not confirm the preview loaded here.",
    };
  }

  return { mode: "embed", url, polling, fallbackReason: null };
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
