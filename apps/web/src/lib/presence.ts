"use client";

// Client for WS /ws/projects/{id}/presence (apps/cloud/app/api/presence.py).
// Ephemeral who's-viewing roster; no graph data flows here.

import { useEffect, useState } from "react";
import { CLOUD_WS_URL } from "./config";
import { usePresenceAuthParam } from "./auth";

const HEARTBEAT_MS = 15_000;

export interface PresenceRosterEntry {
  user_id: string;
  cursor_hint: string | null;
  last_seen: number;
}

export function usePresence(projectId: string | null): PresenceRosterEntry[] {
  const authParam = usePresenceAuthParam();
  const [roster, setRoster] = useState<PresenceRosterEntry[]>([]);

  useEffect(() => {
    if (!projectId || !authParam) return;

    const url = `${CLOUD_WS_URL}/ws/projects/${projectId}/presence?${authParam.key}=${encodeURIComponent(authParam.value)}`;
    const ws = new WebSocket(url);

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "presence" && Array.isArray(payload.users)) {
          setRoster(payload.users);
        }
      } catch {
        // ignore malformed frames
      }
    };
    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({}));
    }, HEARTBEAT_MS);

    return () => {
      clearInterval(heartbeat);
      ws.close();
    };
  }, [projectId, authParam]);

  return roster;
}
