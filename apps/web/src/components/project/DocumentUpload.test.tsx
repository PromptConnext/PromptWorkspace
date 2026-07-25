// apps/web/src/components/project/DocumentUpload.test.tsx
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentUpload } from "./DocumentUpload";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ Authorization: "Bearer test" }) }),
}));

const originalFetch = global.fetch;

describe("DocumentUpload", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    localStorage.clear();
    cleanup();
  });

  it("uploads a selected file and reports the result", async () => {
    const onUploaded = vi.fn();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "doc-1",
        project_id: "p1",
        title: "prd.md",
        mime: "text/markdown",
        source_kind: "upload",
        extract_method: "passthrough",
        status: "extracted",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      }),
    }) as unknown as typeof fetch;

    render(<DocumentUpload projectId="p1" onUploaded={onUploaded} />);

    const file = new File(["# PRD"], "prd.md", { type: "text/markdown" });
    const input = screen.getByLabelText(/upload/i) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(1));
    expect(onUploaded).toHaveBeenCalledWith(expect.objectContaining({ id: "doc-1", status: "extracted" }));
  });

  it("shows an error banner when extraction fails", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "doc-2",
        project_id: "p1",
        title: "scan.pdf",
        mime: "application/pdf",
        source_kind: "upload",
        extract_method: null,
        status: "failed",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      }),
    }) as unknown as typeof fetch;

    render(<DocumentUpload projectId="p1" onUploaded={vi.fn()} />);

    const file = new File(["%PDF-1.4"], "scan.pdf", { type: "application/pdf" });
    const input = screen.getByLabelText(/upload/i) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() =>
      expect(screen.getByText(/couldn't read this file/i)).toBeInTheDocument(),
    );
  });
});
