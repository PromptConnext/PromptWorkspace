import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Decision } from "@/lib/types";
import { DecisionSubject } from "./DecisionSubject";

afterEach(cleanup);

const decision = (o: Partial<Decision>): Decision => ({
  id: "d1", project_id: "p1", workspace_id: "w1", kind: "intent_approval",
  title: "Approve the intent", subject_stage: "specify", subject_hash: "h",
  subject_content: "# Spec\n\nBook a slot.", routed_hat: "business_owner", status: "open",
  rationale: null, requested_by: "u1", resolved_by: null, created_at: "2026-10-04T08:00:00Z",
  resolved_at: null, can_resolve: true, ...o,
});

describe("DecisionSubject", () => {
  it("renders hostile markdown as text", () => {
    const hostile = '# Spec\n<img src=x onerror="alert(1)">\n<script>alert(2)</script>\n[x](javascript:alert(3))';
    const { container } = render(
      <DecisionSubject decision={decision({ subject_content: hostile })} previous={null} />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeInTheDocument();
    expect(screen.getByText("[x](javascript:alert(3))")).toBeInTheDocument();
  });

  it("shows the diff against the last approved version", () => {
    const previous = decision({ id: "d0", status: "approved", subject_content: "# Spec\n\nBook a slot.\nOld rule." });
    const current = decision({ subject_content: "# Spec\n\nBook a slot.\nNew rule." });
    render(<DecisionSubject decision={current} previous={previous} />);

    expect(screen.getByText(/since the last approval/i)).toBeInTheDocument();
    expect(screen.getByText("Old rule.").closest("[data-diff]")).toHaveAttribute("data-diff", "del");
    expect(screen.getByText("New rule.").closest("[data-diff]")).toHaveAttribute("data-diff", "add");
    expect(screen.getByText("Book a slot.").closest("[data-diff]")).toHaveAttribute("data-diff", "same");
  });

  it("says so when the document did not change since the last approval", () => {
    const previous = decision({ id: "d0", status: "approved" });
    render(<DecisionSubject decision={decision({})} previous={previous} />);
    expect(screen.getByText(/no changes since the last approval/i)).toBeInTheDocument();
  });

  it("shows the full text when nothing was approved before", () => {
    render(<DecisionSubject decision={decision({})} previous={null} />);

    expect(screen.getByText(/nothing was approved before/i)).toBeInTheDocument();
    expect(screen.getByText("Book a slot.")).toBeInTheDocument();
    expect(document.querySelector("[data-diff='del']")).toBeNull();
  });

  it("says there is no saved copy for a request made before snapshots", () => {
    render(<DecisionSubject decision={decision({ subject_content: null })} previous={null} />);
    expect(screen.getByText("No saved copy of the document for this request")).toBeInTheDocument();
  });

  it("falls back to the full text when the earlier approval has no saved copy", () => {
    const previous = decision({ id: "d0", status: "approved", subject_content: null });
    render(<DecisionSubject decision={decision({})} previous={previous} />);
    expect(screen.getByText("Book a slot.")).toBeInTheDocument();
    expect(screen.queryByText(/since the last approval/i)).not.toBeInTheDocument();
  });
});
