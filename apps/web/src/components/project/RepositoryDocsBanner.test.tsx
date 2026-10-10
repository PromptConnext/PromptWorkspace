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

  it("shows an open pull request with nothing stale as a link only, with no button", () => {
    render(
      <RepositoryDocsBanner
        status={{ ...CURRENT, open_sync_pr: { number: 3, url: "https://github.com/acme/widget/pull/3" } }}
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

  it("offers to update an open pull request when documents changed since", async () => {
    const onSync = vi.fn().mockResolvedValue({ ...RESULT, pr_number: 3, pr_url: "https://github.com/acme/widget/pull/3" });
    render(
      <RepositoryDocsBanner
        status={{ ...STALE, open_sync_pr: { number: 3, url: "https://github.com/acme/widget/pull/3" } }}
        canSync
        onSync={onSync}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Pull request #3 is open and 2 files changed since",
    );
    expect(screen.queryByRole("button", { name: "Review and open a pull request" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Update the pull request" }));
    expect(await screen.findByText(/Pull request #3 updated/)).toBeInTheDocument();
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it("shows a synced pull request as a link only: in_pull_request files are not stale", () => {
    render(
      <RepositoryDocsBanner
        status={{
          files: [
            { path: "docs/architecture.md", state: "in_pull_request" },
            { path: "docs/conventions.md", state: "in_pull_request" },
            { path: "docs/tasks.md", state: "current" },
          ],
          open_sync_pr: { number: 7, url: RESULT.pr_url },
        }}
        canSync
        onSync={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Pull request #7 is open");
    expect(screen.getByRole("status")).not.toHaveTextContent("changed since");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers the update when one more document is edited after the sync", () => {
    render(
      <RepositoryDocsBanner
        status={{
          files: [
            { path: "docs/architecture.md", state: "in_pull_request" },
            { path: "docs/conventions.md", state: "out_of_date" },
            { path: "docs/tasks.md", state: "current" },
          ],
          open_sync_pr: { number: 7, url: RESULT.pr_url },
        }}
        canSync
        onSync={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Pull request #7 is open and 1 file changed since",
    );
    expect(screen.getByRole("button", { name: "Update the pull request" })).toBeInTheDocument();
  });

  it("renders nothing when the only differences are already in a pull request that is gone", () => {
    const { container } = render(
      <RepositoryDocsBanner
        status={{ files: [{ path: "docs/tasks.md", state: "in_pull_request" }], open_sync_pr: null }}
        canSync
        onSync={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("still shows the success line when a revalidation replaces the status mid-sync", async () => {
    let resolve!: (r: SyncDocsResult) => void;
    const onSync = vi.fn(() => new Promise<SyncDocsResult>((r) => (resolve = r)));
    const { rerender } = render(<RepositoryDocsBanner status={STALE} canSync onSync={onSync} />);

    fireEvent.click(screen.getByRole("button", { name: "Review and open a pull request" }));
    rerender(
      <RepositoryDocsBanner status={{ ...STALE, files: [...STALE.files] }} canSync onSync={onSync} />,
    );
    resolve(RESULT);

    expect(await screen.findByRole("link", { name: /pull request #7 opened/i })).toBeInTheDocument();
  });

  it("clears the success line on the next sync click", async () => {
    const onSync = vi
      .fn()
      .mockResolvedValueOnce(RESULT)
      .mockRejectedValueOnce(new Error("github_branch_conflict"));
    const { rerender } = render(<RepositoryDocsBanner status={STALE} canSync onSync={onSync} />);
    fireEvent.click(screen.getByRole("button", { name: "Review and open a pull request" }));
    await screen.findByRole("link", { name: /pull request #7 opened/i });

    const next = {
      files: [{ path: "docs/tasks.md", state: "out_of_date" as const }],
      open_sync_pr: { number: 7, url: RESULT.pr_url },
    };
    rerender(<RepositoryDocsBanner status={next} canSync onSync={onSync} />);
    fireEvent.click(screen.getByRole("button", { name: "Update the pull request" }));
    expect(await screen.findByText(/default branch changed/)).toBeInTheDocument();
    expect(screen.queryByText(/Pull request #7 opened/)).not.toBeInTheDocument();
  });

  it("offers no update button to someone who cannot sync", () => {
    render(
      <RepositoryDocsBanner
        status={{ ...STALE, open_sync_pr: { number: 3, url: "https://github.com/acme/widget/pull/3" } }}
        canSync={false}
        onSync={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Pull request #3 is open and 2 files changed since");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("stops showing the opened result once the status is refetched", async () => {
    const onSync = vi.fn().mockResolvedValue(RESULT);
    const { rerender } = render(<RepositoryDocsBanner status={STALE} canSync onSync={onSync} />);

    fireEvent.click(screen.getByRole("button", { name: "Review and open a pull request" }));
    await screen.findByRole("link", { name: /pull request #7 opened/i });

    // The refetch lands: the documents are stale again and no PR is open.
    rerender(
      <RepositoryDocsBanner status={{ ...STALE, files: [...STALE.files] }} canSync onSync={onSync} />,
    );
    expect(screen.queryByText(/Pull request #7 opened/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Review and open a pull request" }),
    ).toBeInTheDocument();
  });

  it("follows the refetched status to an open pull request", async () => {
    const onSync = vi.fn().mockResolvedValue(RESULT);
    const { rerender } = render(<RepositoryDocsBanner status={STALE} canSync onSync={onSync} />);
    fireEvent.click(screen.getByRole("button", { name: "Review and open a pull request" }));
    await screen.findByRole("link", { name: /pull request #7 opened/i });

    rerender(
      <RepositoryDocsBanner
        status={{
          files: STALE.files.map((f) => ({ ...f, state: "current" as const })),
          open_sync_pr: { number: 7, url: RESULT.pr_url },
        }}
        canSync
        onSync={onSync}
      />,
    );
    expect(screen.getByText(/Pull request #7 is open/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("explains a status that could not be read, without a button", () => {
    render(
      <RepositoryDocsBanner status={null} statusError="github_read_forbidden" canSync onSync={vi.fn()} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Could not check repository documents: The workspace's GitHub token can't read this repository.",
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it.each([
    ["github_unreachable", "GitHub is unreachable. Try again."],
    ["github_not_configured", "GitHub is not connected for this workspace."],
    ["repository_not_created", "The repository hasn't been created yet."],
    ["something_new", "something_new"],
  ])("maps the status error %s for a member too", (code, text) => {
    render(<RepositoryDocsBanner status={null} statusError={code} canSync={false} onSync={vi.fn()} />);
    expect(
      screen.getByText(`Could not check repository documents: ${text}`),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("lets a failed sync be retried", async () => {
    const onSync = vi
      .fn()
      .mockRejectedValueOnce(new Error("github_pr_permission_denied"))
      .mockResolvedValueOnce(RESULT);
    render(<RepositoryDocsBanner status={STALE} canSync onSync={onSync} />);

    fireEvent.click(screen.getByRole("button", { name: "Review and open a pull request" }));
    await screen.findByText(/needs the Pull requests permission/);
    fireEvent.click(screen.getByRole("button", { name: "Review and open a pull request" }));

    expect(await screen.findByRole("link", { name: /pull request #7 opened/i })).toBeInTheDocument();
    expect(onSync).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/needs the Pull requests permission/)).not.toBeInTheDocument();
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
    ["github_read_forbidden", "The workspace's GitHub token can't read this repository."],
    ["github_unreachable", "GitHub is unreachable. Try again."],
    ["github_not_configured", "GitHub is not connected for this workspace."],
    ["repository_not_created", "The repository hasn't been created yet."],
    ["repository_docs_current", "Repository documents are already up to date."],
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
