import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/lib/auth";
import LoginPage, { desktopRedirect, desktopScheme, safeNext } from "./page";

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

describe("desktopRedirect", () => {
  const OLD = "promptconnext://auth/callback?code=abc%20123&state=s1";

  it("builds the shell's authority-less callback when no redirect_uri is given", () => {
    expect(desktopRedirect(null, "promptconnext", "abc 123", "s1")).toBe(OLD);
  });

  it("keeps the Theia shell working unchanged", () => {
    expect(desktopRedirect(null, "promptconnext-theia", "c", "s")).toBe(
      "promptconnext-theia://auth/callback?code=c&state=s",
    );
  });

  it("preserves the extension-id authority a VS Code URI handler requires", () => {
    const url = new URL(
      desktopRedirect(
        "vscode://promptconnext.promptconnext/auth/callback",
        null,
        "c",
        "s",
      ),
    );
    expect(url.protocol).toBe("vscode:");
    expect(url.host).toBe("promptconnext.promptconnext");
    expect(url.pathname).toBe("/auth/callback");
    expect(url.searchParams.get("code")).toBe("c");
    expect(url.searchParams.get("state")).toBe("s");
  });

  it("accepts the forks' own schemes", () => {
    for (const scheme of ["cursor", "windsurf", "vscode-insiders", "vscodium"]) {
      const url = new URL(
        desktopRedirect(`${scheme}://promptconnext.promptconnext/auth/callback`, null, "c", "s"),
      );
      expect(url.protocol).toBe(`${scheme}:`);
    }
  });

  it("preserves a query param the callback already carried", () => {
    const url = new URL(
      desktopRedirect("vscode://promptconnext.promptconnext/cb?windowId=3", null, "c", "s"),
    );
    expect(url.searchParams.get("windowId")).toBe("3");
    expect(url.searchParams.get("code")).toBe("c");
  });

  it("refuses an https redirect_uri rather than leaking the code off-device", () => {
    expect(desktopRedirect("https://evil.example/cb", null, "abc 123", "s1")).toBe(OLD);
  });

  it("refuses an unknown scheme", () => {
    expect(desktopRedirect("evilapp://cb", null, "abc 123", "s1")).toBe(OLD);
  });

  it("refuses a scheme that merely prefixes a known one", () => {
    expect(desktopRedirect("promptconnext-evil://cb", null, "abc 123", "s1")).toBe(OLD);
  });

  it("refuses a redirect_uri that pins its own code", () => {
    expect(desktopRedirect("vscode://p.p/cb?code=stolen", null, "abc 123", "s1")).toBe(OLD);
  });

  it("refuses a redirect_uri carrying a fragment (dropped by handleUri anyway)", () => {
    expect(desktopRedirect("vscode://p.p/cb#frag", null, "abc 123", "s1")).toBe(OLD);
  });

  it("falls back when redirect_uri is not a URL at all", () => {
    expect(desktopRedirect("not a url", null, "abc 123", "s1")).toBe(OLD);
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
