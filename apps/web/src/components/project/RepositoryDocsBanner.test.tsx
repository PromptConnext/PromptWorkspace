import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepositoryDocsBanner } from "./RepositoryDocsBanner";
import type { RepositoryDocsStatus, SyncDocsResult } from "@/lib/types";

afterEach(cleanup);

const CURRENT: RepositoryDocsStatus = {
  files: [
    { path: "docs/architecture.md", state: "current" },
    { path: "docs/tasks.md", state: "current" },
  ],
  open_sync_pr: null,
};

const STALE: RepositoryDocsStatus = {
  files: [
    { path: "docs/architecture.md", state: "out_of_date" },
    { path: "docs/conventions.md", state: "out_of_date" },
    { path: "docs/tasks.md", state: "current" },
  ],
  open_sync_pr: null,
};

const RESULT: SyncDocsResult = {
  pr_number: 7,
  pr_url: "https://github.com/acme/widget/pull/7",
  branch: "pw/sync-docs-20261010120000",
  files: ["docs/architecture.md", "docs/conventions.md"],
};

describe("RepositoryDocsBanner", () => {
  it("renders nothing when every document is current and no pull request is open", () => {
    const { container } = render(
      <RepositoryDocsBanner status={CURRENT} canSync onSync={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing without a status, or with one that is not a status", () => {
    const { container, rerender } = render(
      <RepositoryDocsBanner status={null} canSync onSync={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(
      <RepositoryDocsBanner status={[] as unknown as RepositoryDocsStatus} canSync onSync={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("counts the documents that are not current and offers the sync to an admin", () => {
    render(<RepositoryDocsBanner status={STALE} canSync onSync={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Repository documents are out of date: 2 files",
    );
    expect(
      screen.getByRole("button", { name: "Review and open a pull request" }),
    ).toBeInTheDocument();
  });

  it("counts a missing document as not current", () => {
    render(
      <RepositoryDocsBanner
        status={{ files: [{ path: "docs/tasks.md", state: "missing" }], open_sync_pr: null }}
        canSync
        onSync={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Repository documents are out of date: 1 file",
    );
  });

  it("shows the text only, with no button, to someone who cannot sync", () => {
    render(<RepositoryDocsBanner status={STALE} canSync={false} onSync={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Repository documents are out of date: 2 files",
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("calls onSync once and links the pull request it opened", async () => {
    const onSync = vi.fn().mockResolvedValue(RESULT);
    render(<RepositoryDocsBanner status={STALE} canSync onSync={onSync} />);

    fireEvent.click(screen.getByRole("button", { name: "Review and open a pull request" }));

    const link = await screen.findByRole("link", { name: /pull request #7/i });
    expect(onSync).toHaveBeenCalledTimes(1);
    expect(link).toHaveAttribute("href", RESULT.pr_url);
    expect(screen.getByText(/Pull request #7 opened/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Review and open a pull request" }),
    ).not.toBeInTheDocument();
  });

  it("shows an open pull request with its link and no button", () => {
    render(
      <RepositoryDocsBanner
        status={{ ...STALE, open_sync_pr: { number: 3, url: "https://github.com/acme/widget/pull/3" } }}
        canSync
        onSync={vi.fn()}
      />,
    );
    expect(screen.getByText(/Pull request #3 is open/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /pull request #3/i })).toHaveAttribute(
      "href",
      "https://github.com/acme/widget/pull/3",
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows an open pull request even when every document is current", () => {
    render(
      <RepositoryDocsBanner
        status={{ ...CURRENT, open_sync_pr: { number: 3, url: "https://github.com/acme/widget/pull/3" } }}
        canSync={false}
        onSync={vi.fn()}
      />,
    );
    expect(screen.getByText(/Pull request #3 is open/)).toBeInTheDocument();
  });

  it.each([
    [
      "github_pr_permission_denied",
      "The workspace's GitHub token needs the Pull requests permission (Read and write).",
    ],
    ["github_branch_conflict", "The default branch changed while syncing. Try again."],
  ])("maps the %s rejection to its text and keeps the button", async (code, text) => {
    const onSync = vi.fn().mockRejectedValue(new Error(code));
    render(<RepositoryDocsBanner status={STALE} canSync onSync={onSync} />);

    fireEvent.click(screen.getByRole("button", { name: "Review and open a pull request" }));

    expect(await screen.findByText(text)).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Review and open a pull request" }),
      ).not.toBeDisabled(),
    );
  });

  it("falls back to the raw code for a rejection it has no text for", async () => {
    const onSync = vi.fn().mockRejectedValue(new Error("something_new"));
    render(<RepositoryDocsBanner status={STALE} canSync onSync={onSync} />);
    fireEvent.click(screen.getByRole("button", { name: "Review and open a pull request" }));
    expect(await screen.findByText("something_new")).toBeInTheDocument();
  });
});
