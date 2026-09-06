import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BuildTasks } from "./BuildTasks";
import type { DeploymentStatus } from "@/lib/types";

afterEach(cleanup);

function status(tasks: { id: string; title: string; ref: string | null }[]): DeploymentStatus {
  const deploy = {
    id: "d1",
    state: "live",
    url: "https://preview.test/",
    commit_sha: "abc1234",
    ref: "main",
    run_url: "https://github.com/acme/rocket/actions/runs/1",
    frame_policy: "allow" as const,
    tasks,
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

  it("says so plainly when nothing is attributed", () => {
    render(<BuildTasks status={status([])} />);
    expect(screen.getByText(/no completed tasks/i)).toBeInTheDocument();
  });
});
