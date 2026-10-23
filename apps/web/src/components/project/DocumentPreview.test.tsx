import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentPreview } from "./DocumentPreview";
import type { DocumentOut } from "@/lib/types";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({}) }),
}));

vi.mock("@/lib/api", () => ({
  fetchDocumentContent: vi.fn(async () => ({
    text: async () => "| A | B |\n|---|---|\n| 1 | 2 |",
  })),
}));

afterEach(() => {
  cleanup();
});

describe("DocumentPreview", () => {
  it("renders a markdown table as a table", async () => {
    const doc = { id: "d1", title: "PRD", mime: "text/markdown" } as DocumentOut;
    render(<DocumentPreview projectId="p1" document={doc} onClose={vi.fn()} />);
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "2" })).toBeInTheDocument();
  });
});
