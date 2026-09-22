import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BuildTasks } from "./BuildTasks";
import type { DeploymentStatus } from "@/lib/types";

afterEach(cleanup);

function status(
  tasks: { id: string; title: string; ref: string | null }[],
  attribution_state: "uncomputed" | "frozen" = "frozen",
): DeploymentStatus {
  const deploy = {
    id: "d1",
    state: "live",
    url: "https://preview.test/",
    commit_sha: "abc1234",
    ref: "main",
    run_url: "https://github.com/acme/rocket/actions/runs/1",
    frame_policy: "allow" as const,
    tasks,
    attribution_state,
    attributed_at: attribution_state === "frozen" ? new Date().toISOString() : null,
    created_at: new Date(Date.now() - 120_000).toISOString(),
    updated_at: new Date(Date.now() - 120_000).toISOString(),
  };
  return {
    template_id: "static-r2",
    template_name: "T",
    provider: "platform-r2",
    embeddable: true,
    state: "live",
    url: deploy.url,
    health_path: "/",
    pending: 0,
    last_deploy: deploy,
    recent: [deploy],
    last_error: null,
  };
}

describe("BuildTasks", () => {
  it("names the tasks in the build, in the spec's words", () => {
    render(
      <BuildTasks status={status([{ id: "t1", title: "Add a retry to the uploader", ref: "T1" }])} />,
    );
    expect(screen.getByText("Add a retry to the uploader")).toBeInTheDocument();
    expect(screen.getByText(/Version 1/)).toBeInTheDocument();
    expect(screen.getByText(/2 minutes ago/)).toBeInTheDocument();
  });

  it("never shows a commit", () => {
    const { container } = render(
      <BuildTasks status={status([{ id: "t1", title: "Add a retry", ref: "T1" }])} />,
    );
    expect(container.textContent).not.toContain("abc1234");
    expect(container.textContent).not.toContain("main");
  });

  // Plan 0024 M3: an empty result and an uncomputed result are different
  // facts and used to render as one sentence.
  it("says a frozen build closed nothing", () => {
    render(<BuildTasks status={status([], "frozen")} />);
    expect(screen.getByText(/contains no completed tasks/i)).toBeInTheDocument();
    expect(screen.queryByText(/haven't worked out/i)).not.toBeInTheDocument();
  });

  it("admits when it never worked out what the build contains", () => {
    render(<BuildTasks status={status([], "uncomputed")} />);
    expect(screen.getByText(/worked out which tasks are in this version/i)).toBeInTheDocument();
    expect(screen.queryByText(/contains no completed tasks/i)).not.toBeInTheDocument();
  });

  it("does not list stale tasks for a build that was never attributed", () => {
    // Defensive: if a row somehow carries task ids while still uncomputed,
    // the honest answer is still "not worked out", not a half list.
    render(
      <BuildTasks status={status([{ id: "t1", title: "Add a retry", ref: "T1" }], "uncomputed")} />,
    );
    expect(screen.queryByText("Add a retry")).not.toBeInTheDocument();
    expect(screen.getByText(/worked out which tasks are in this version/i)).toBeInTheDocument();
  });
});
