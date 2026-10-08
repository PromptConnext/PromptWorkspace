import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GenerationWarnings } from "./GenerationWarnings";

afterEach(cleanup);

describe("GenerationWarnings", () => {
  it("renders nothing without warnings", () => {
    const { container } = render(<GenerationWarnings />);
    expect(container).toBeEmptyDOMElement();
    cleanup();
    const empty = render(<GenerationWarnings warnings={[]} />);
    expect(empty.container).toBeEmptyDOMElement();
  });

  it("lists each task and path that is neither in the repository nor marked new", () => {
    render(
      <GenerationWarnings
        warnings={[
          {
            code: "unmarked_new_paths",
            items: [
              { ref: "T014", path: "src/lib/metaTags.ts" },
              { ref: "T017", path: "i18n/th.json" },
            ],
          },
        ]}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "2 tasks name files that aren't in the repository",
    );
    expect(screen.getByText("src/lib/metaTags.ts")).toBeInTheDocument();
    expect(screen.getByText("i18n/th.json")).toBeInTheDocument();
    expect(screen.getByText("T014")).toBeInTheDocument();
    expect(screen.getByText("(new)")).toBeInTheDocument();
  });

  it("speaks in the singular for one task", () => {
    render(
      <GenerationWarnings
        warnings={[{ code: "unmarked_new_paths", items: [{ ref: "T002", path: "a/b.ts" }] }]}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "1 task names a file that isn't in the repository",
    );
  });
});
