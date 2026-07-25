import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/lib/auth";
import LoginPage, { safeNext } from "./page";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

describe("safeNext", () => {
  it("passes through a same-origin path", () => {
    expect(safeNext("/foo")).toBe("/foo");
  });

  it("rejects a protocol-relative path", () => {
    expect(safeNext("//evil.example")).toBe("/");
  });

  it("rejects an absolute URL", () => {
    expect(safeNext("https://evil.example")).toBe("/");
  });

  it("falls back to / when null", () => {
    expect(safeNext(null)).toBe("/");
  });
});

describe("LoginPage (stub mode submit)", () => {
  const STUB_USER_KEY = "pz_stub_user_id";

  beforeEach(() => {
    localStorage.clear();
    replace.mockClear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("signs in via stub form submit and redirects", async () => {
    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    );

    const input = await screen.findByLabelText(/user id/i);
    fireEvent.change(input, { target: { value: "carol" } });

    const submit = screen.getByRole("button", { name: /continue/i });
    fireEvent.click(submit);

    await waitFor(() => expect(localStorage.getItem(STUB_USER_KEY)).toBe("carol"));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  });
});
