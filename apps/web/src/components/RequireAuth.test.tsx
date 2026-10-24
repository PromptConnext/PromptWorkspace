import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequireAuth } from "./RequireAuth";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: null, loading: false }) }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("RequireAuth", () => {
  it("sends a signed-out visitor to plain login by default", () => {
    render(<RequireAuth>secret</RequireAuth>);
    expect(replace).toHaveBeenCalledWith("/login");
  });

  it("carries an encoded return path when given one", () => {
    render(<RequireAuth next="/oauth/consent?request=r1">secret</RequireAuth>);
    expect(replace).toHaveBeenCalledWith("/login?next=%2Foauth%2Fconsent%3Frequest%3Dr1");
  });
});
