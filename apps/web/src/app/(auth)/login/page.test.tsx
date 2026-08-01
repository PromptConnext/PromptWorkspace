import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/lib/auth";
import LoginPage, { desktopScheme, safeNext } from "./page";

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

describe("desktopScheme", () => {
  it("passes through the shipping Tauri scheme", () => {
    expect(desktopScheme("promptconnext")).toBe("promptconnext");
  });

  it("passes through the Theia shell's own scheme", () => {
    expect(desktopScheme("promptconnext-theia")).toBe("promptconnext-theia");
  });

  it("falls back to the shipping scheme when absent", () => {
    expect(desktopScheme(null)).toBe("promptconnext");
  });

  it("refuses an unknown scheme rather than handing it the auth code", () => {
    expect(desktopScheme("evilapp")).toBe("promptconnext");
  });

  it("refuses a scheme that merely prefixes a known one", () => {
    expect(desktopScheme("promptconnext-evil")).toBe("promptconnext");
  });

  it("refuses an embedded javascript: URL", () => {
    expect(desktopScheme("javascript:alert(1)//")).toBe("promptconnext");
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
