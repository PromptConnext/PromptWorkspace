// Desktop identity + membership gate (ADR 0015, plan 0006 G3).
//
// Order of gating, ahead of the existing model-onboarding branch:
//   engine health ──► auth (session?) ──► membership (>=1 workspace?) ──► onboarding
//
// A cached, refresh-extended session counts as signed in (ADR 0015 §1): the
// gate is evaluated at cold-start / focus, never as a live network check on
// launch, so an established user keeps working offline. The whole gate lives
// behind a build-time feature flag for staged rollout.

import { getCloudConfig, getCloudRoster, getCloudSession, refreshCloudRoster } from "./api";

export type CloudGate =
  // Gate not enforced — flag off, stub/dev auth, or cloud disabled. The app
  // behaves exactly as it did before ADR 0015 (ADR 0015 state 10).
  | { kind: "disabled" }
  // Signed out / never signed in / no cached session — show the ADR 0014
  // browser sign-in handoff; nothing else is reachable (state 1).
  | { kind: "auth" }
  // Signed in but a *confirmed* zero-membership result — block the 3S surface
  // behind the no-workspace screen (state 2).
  | { kind: "no-workspace" }
  // Signed in with >=1 workspace, or established-and-offline — proceed to
  // onboarding / Workspace (states 3 & 4).
  | { kind: "ready" };

const rawFlag = import.meta.env.VITE_MEMBERSHIP_GATE;

// Exported so App.tsx can skip all gate work (and its focus listener / roster
// pulls) entirely when the flag is off, preserving today's instant render.
export const membershipGateEnabled = /^(1|true|on|yes)$/i.test(String(rawFlag ?? "").trim());

export async function resolveGate(): Promise<CloudGate> {
  if (!membershipGateEnabled) return { kind: "disabled" };

  const config = await getCloudConfig();
  // The gate only governs real cloud identities. Stub/dev auth (AUTH_MODE=stub,
  // X-User-Id) and a cloud-disabled build (CLOUD_API_URL unset) stay relaxed
  // exactly as auth is relaxed today, so local backend testing keeps working.
  if (!config.enabled || config.mode !== "supabase") return { kind: "disabled" };

  const session = await getCloudSession();
  if (!session.connected) return { kind: "auth" };

  // Membership is decided by the cloud-authoritative roster. Auto-pull it (ADR
  // 0015 §2 pulls on launch/focus). The refresh endpoint already falls back to
  // the cache with offline:true when the cloud is unreachable, so this is not a
  // hard live-network check — a cached session + cached roster keeps the user in.
  let workspaces: { id: string }[];
  let offline: boolean;
  try {
    const roster = await refreshCloudRoster();
    workspaces = roster.workspaces;
    offline = roster.offline;
  } catch {
    // Unexpected engine/route error — read the cache and treat as offline so a
    // transient failure never locks the user out.
    const cached = await getCloudRoster().catch(() => null);
    workspaces = cached?.workspaces ?? [];
    offline = true;
  }

  // "Cloud unreachable != no workspaces" (ADR 0015 state 4): when membership
  // could not be confirmed live, keep the user in on the cached roster rather
  // than dropping them into the no-workspace dead-end.
  if (offline) return { kind: "ready" };

  return workspaces.length === 0 ? { kind: "no-workspace" } : { kind: "ready" };
}
