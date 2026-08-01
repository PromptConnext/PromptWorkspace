import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/lib/auth";
import { WorkspaceProvider, useWorkspaceName } from "@/lib/workspace";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetch(...args) };
});

const STUB_USER_KEY = "pz_stub_user_id";
const CACHE_KEY = "pz_memberships:bob";

function workspace(id: string, name: string) {
  return {
    id,
    name,
    created_by: "bob",
    git_config: {},
    integration_config: {},
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
  };
}

function Label({ id }: { id: string }) {
  return <span data-testid="label">{useWorkspaceName(id)}</span>;
}

function renderLabel(id: string) {
  return render(
    <AuthProvider>
      <WorkspaceProvider>
        <Label id={id} />
      </WorkspaceProvider>
    </AuthProvider>,
  );
}

describe("useWorkspaceName", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(STUB_USER_KEY, "bob");
    apiFetch.mockReset();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("never renders the raw workspace id, even before memberships load", async () => {
    // The regression: breadcrumbs fell back to the id, so every reload showed
    // a UUID until (or unless) a per-page workspace fetch answered.
    let resolve: (ws: unknown) => void = () => {};
    apiFetch.mockImplementation(() => new Promise((r) => (resolve = r)));

    renderLabel("ws-acme");

    expect(screen.getByTestId("label")).toHaveTextContent("Workspace");
    expect(screen.getByTestId("label")).not.toHaveTextContent("ws-acme");

    resolve([workspace("ws-acme", "Acme")]);
    await waitFor(() => expect(screen.getByTestId("label")).toHaveTextContent("Acme"));
  });

  it("paints the cached name on first render after a reload", async () => {
    localStorage.setItem(CACHE_KEY, JSON.stringify([workspace("ws-acme", "Acme")]));
    apiFetch.mockImplementation(() => new Promise(() => {}));

    renderLabel("ws-acme");

    // No await: the name is there before /workspaces answers.
    await waitFor(() => expect(screen.getByTestId("label")).toHaveTextContent("Acme"));
  });

  it("caches the roster so the next load has it", async () => {
    apiFetch.mockResolvedValue([workspace("ws-acme", "Acme")]);

    renderLabel("ws-acme");

    await waitFor(() => expect(localStorage.getItem(CACHE_KEY)).not.toBeNull());
    expect(JSON.parse(localStorage.getItem(CACHE_KEY)!)).toHaveLength(1);
  });

  it("ignores a corrupt cache entry", async () => {
    localStorage.setItem(CACHE_KEY, "not json");
    apiFetch.mockImplementation(() => new Promise(() => {}));

    renderLabel("ws-acme");

    expect(screen.getByTestId("label")).toHaveTextContent("Workspace");
  });
});
