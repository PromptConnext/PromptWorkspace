import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceMember } from "@/lib/types";

const roster = vi.hoisted(() => ({
  value: [] as { user_id: string; cursor_hint: string | null; last_seen: number }[],
}));
vi.mock("@/lib/presence", () => ({ usePresence: () => roster.value }));

import { PresenceBar } from "./PresenceBar";

const member = (user_id: string, email: string | null): WorkspaceMember => ({
  workspace_id: "w1",
  user_id,
  email,
  role: "member",
  display_name: null,
  invited_by: null,
  created_at: "2026-10-01T00:00:00Z",
});

const UUID_A = "a7c1e2d4-1111-4222-8333-444455556666";
const UUID_B = "b3f0aa11-1111-4222-8333-444455556666";
const UUID_C = "ed000000-1111-4222-8333-444455556666";
const seen = (user_id: string) => ({ user_id, cursor_hint: null, last_seen: 1 });

describe("PresenceBar", () => {
  afterEach(cleanup);

  it("shows member initials and emails, never raw ids", () => {
    roster.value = [seen(UUID_A), seen(UUID_B), seen(UUID_C)];
    const { container } = render(
      <PresenceBar
        projectId="p1"
        members={[member(UUID_A, "alice@example.com"), member(UUID_B, "bob@example.com")]}
      />,
    );
    expect(screen.getByTitle("alice@example.com").textContent).toBe("A");
    expect(screen.getByTitle("bob@example.com").textContent).toBe("B");
    expect(screen.getByTitle("Someone in this workspace").textContent).toBe("?");
    expect(container.innerHTML).not.toContain(UUID_A);
    expect(container.innerHTML).not.toContain("A7");
    expect(container.innerHTML).not.toContain("ED");
  });

  it("falls back to ? while members have not loaded", () => {
    roster.value = [seen(UUID_A)];
    render(<PresenceBar projectId="p1" members={undefined} />);
    expect(screen.getByTitle("Someone in this workspace").textContent).toBe("?");
  });
});
