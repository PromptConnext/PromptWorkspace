"use client";

import { RequireAuth } from "@/components/RequireAuth";
import { WorkspaceGate } from "@/components/WorkspaceGate";

export default function HomePage() {
  return (
    <RequireAuth>
      <WorkspaceGate />
    </RequireAuth>
  );
}
