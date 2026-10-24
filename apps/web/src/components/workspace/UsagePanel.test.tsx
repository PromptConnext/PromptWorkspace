import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GovernanceUsage } from "@/lib/types";
import { UsagePanel } from "./UsagePanel";

const managed: GovernanceUsage = {
  source: "managed",
  provider: null,
  runs: 14,
  tokens: 120000,
  today_tokens: 8000,
  daily_budget: 200000,
  by_stage: [
    { stage: "spec", runs: 9, model: "claude-sonnet", tokens: 90000 },
    { stage: "plan", runs: 5, model: "claude-opus", tokens: 30000 },
  ],
};

afterEach(cleanup);

describe("UsagePanel", () => {
  it("one line per used source naming its own budget; none when no budget", () => {
    render(
      <UsagePanel
        usage={[
          managed,
          { ...managed, source: "byo", provider: "openai", runs: 1, daily_budget: null, by_stage: [] },
        ]}
      />,
    );
    expect(
      screen.getByText(
        "Managed model: 14 runs, 120,000 tokens; today 8,000 of the daily budget 200,000",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Your model (openai): 1 run, 120,000 tokens")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "AI usage, last 30 days" })).toBeInTheDocument();
  });

  it("table rows per stage with model and tokens", () => {
    render(<UsagePanel usage={[managed]} />);
    const rows = screen.getAllByRole("row");
    expect(within(rows[0]).getAllByRole("columnheader").map((c) => c.textContent)).toEqual([
      "Stage",
      "Runs",
      "Model",
      "Tokens",
    ]);
    expect(within(rows[1]).getAllByRole("cell").map((c) => c.textContent)).toEqual([
      "spec",
      "9",
      "claude-sonnet",
      "90,000",
    ]);
    expect(rows).toHaveLength(3);
  });
});
