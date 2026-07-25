import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthProvider, useAuth } from "./auth";

const STUB_USER_KEY = "pz_stub_user_id";

function Consumer() {
  const { user, loading, signInStub } = useAuth();
  return (
    <div>
      <div data-testid="loading">{String(loading)}</div>
      <div data-testid="user">{user?.id ?? "none"}</div>
      <button onClick={() => signInStub("alice")}>sign in</button>
    </div>
  );
}

describe("AuthProvider (stub mode)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("signInStub persists to localStorage and updates user", async () => {
    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));
    expect(screen.getByTestId("user")).toHaveTextContent("none");

    fireEvent.click(screen.getByText("sign in"));

    expect(localStorage.getItem(STUB_USER_KEY)).toBe("alice");
    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("alice"));
  });

  it("restores user from a pre-existing stub user in localStorage on mount", async () => {
    localStorage.setItem(STUB_USER_KEY, "bob");

    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("bob"));
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
  });

  it("transitions loading from true to false", async () => {
    const history: boolean[] = [];

    function LoadingRecorder() {
      const { loading } = useAuth();
      useEffect(() => {
        history.push(loading);
      }, [loading]);
      return null;
    }

    render(
      <AuthProvider>
        <LoadingRecorder />
        <Consumer />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));
    expect(history[0]).toBe(true);
    expect(history[history.length - 1]).toBe(false);
  });
});
