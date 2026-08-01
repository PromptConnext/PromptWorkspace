import { describe, expect, it } from "vitest";
import {
  composeStageInput,
  PLAN_FIELDS,
  requiredFieldsFilled,
  SPECIFY_FIELDS,
} from "./stage-forms";

describe("composeStageInput", () => {
  it("renders answered fields as labelled markdown sections", () => {
    const out = composeStageInput(SPECIFY_FIELDS, {
      feature_name: "QR checkout",
      problem: "Card is the only option",
      users: "Shoppers",
      journeys: "Pay with a QR code",
      success: "Abandonment under 20%",
      out_of_scope: "Refunds",
      constraints: "Ship by November",
    });

    expect(out).toContain("## What are we building?\n\nQR checkout");
    expect(out).toContain("## Key user journeys\n\nPay with a QR code");
    expect(out).not.toContain("## Not provided");
  });

  it("lists blank fields so the model marks them rather than inventing them", () => {
    const out = composeStageInput(PLAN_FIELDS, {
      project_type: "Web application",
      language: "TypeScript on Node 24",
      dependencies: "Next.js 16",
    });

    expect(out).toContain("## Not provided");
    expect(out).toContain("- Storage");
    expect(out).toContain("[NEEDS CLARIFICATION]");
  });
});

describe("requiredFieldsFilled", () => {
  it("is false while a required field is blank or whitespace", () => {
    expect(requiredFieldsFilled(SPECIFY_FIELDS, { feature_name: "  " })).toBe(false);
  });

  it("ignores optional fields", () => {
    expect(
      requiredFieldsFilled(PLAN_FIELDS, {
        project_type: "CLI tool",
        language: "Rust 1.75",
        dependencies: "clap",
      }),
    ).toBe(true);
  });
});
