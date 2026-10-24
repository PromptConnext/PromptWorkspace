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

  it("counts tasks, not paths", () => {
    render(
      <GenerationWarnings
        warnings={[
          {
            code: "unmarked_new_paths",
            items: [
              { ref: "T002", path: "a/b.ts" },
              { ref: "T002", path: "a/c.ts" },
            ],
          },
        ]}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "1 task names a file that isn't in the repository",
    );
  });

  it("renders missing task numbers warning", () => {
    render(
      <GenerationWarnings warnings={[{ code: "missing_task_numbers", items: ["T029", "T031"] }]} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Task numbers missing from the generated list: T029, T031. Regenerate, or add them by hand.",
    );
  });

  it("renders the no_task_lines and empty_document warnings", () => {
    render(
      <GenerationWarnings
        warnings={[
          { code: "no_task_lines", items: [] },
          { code: "empty_document", items: [] },
        ]}
      />,
    );
    const notices = screen.getAllByRole("status");
    expect(notices).toHaveLength(2);
    expect(notices[0]).toHaveTextContent(
      "No task lines were found. Tasks need - [ ] T001 title lines under ## Phase N: headings.",
    );
    expect(notices[1]).toHaveTextContent("The document came back empty after parsing.");
  });
});
