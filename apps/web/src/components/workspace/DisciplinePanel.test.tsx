import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GovernanceDiscipline } from "@/lib/types";
import { DisciplinePanel } from "./DisciplinePanel";

const base: GovernanceDiscipline = {
  resolved: 12,
  open: 2,
  expired_30d: 1,
  median_hours_to_decide: 6,
  chains_verified: 7,
  chains_total: 7,
};

afterEach(cleanup);

describe("DisciplinePanel", () => {
  it("discipline sentences: 12 decisions resolved, 2 open, 1 expired without an answer / Median time to decide: 6 hours / Receipt chains verified for 7 of 7 projects", () => {
    render(<DisciplinePanel discipline={base} />);
    expect(screen.getByRole("heading", { name: "Decision discipline" })).toBeInTheDocument();
    expect(
      screen.getByText("12 decisions resolved, 2 open, 1 expired without an answer"),
    ).toBeInTheDocument();
    expect(screen.getByText("Median time to decide: 6 hours")).toBeInTheDocument();
    expect(screen.getByText("Receipt chains verified for 7 of 7 projects")).toBeInTheDocument();
  });

  it("median absent reads Median time to decide: not yet known", () => {
    render(<DisciplinePanel discipline={{ ...base, resolved: 1, median_hours_to_decide: null }} />);
    expect(screen.getByText("Median time to decide: not yet known")).toBeInTheDocument();
    expect(
      screen.getByText("1 decision resolved, 2 open, 1 expired without an answer"),
    ).toBeInTheDocument();
  });
});
