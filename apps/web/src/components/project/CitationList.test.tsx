import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CitationList } from "./CitationList";
import type { Citation } from "@/lib/types";
import type { NodeLabels } from "@/lib/node-labels";

const labels: NodeLabels = new Map([["tasks:t1", "Task: Wire the OAuth callback"]]);

const empty = new Map<string, string>();

// repo/path/start_line/end_line are required-and-nullable on Citation, so the
// base object must supply them explicitly — `Partial` overrides layer on top.
function cite(over: Partial<Citation>): Citation {
  return {
    node_type: "tasks",
    node_id: "t1",
    chunk_index: 0,
    source: "vector",
    repo: null,
    path: null,
    start_line: null,
    end_line: null,
    ...over,
  };
}

describe("CitationList", () => {
  // Same reason as AssistantFactCard.test.tsx: no global auto-cleanup is
  // configured in this repo's vitest.config, so each render must be torn
  // down explicitly or DOM (and text matches) bleed across tests.
  afterEach(() => {
    cleanup();
  });

  it("renders nothing when there are no citations", () => {
    const { container } = render(
      <CitationList citations={[]} labels={labels} documentTitles={empty} stageNames={empty} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("dedupes the same node cited at several chunk indexes", () => {
    render(
      <CitationList
        citations={[cite({ chunk_index: 0 }), cite({ chunk_index: 1 }), cite({ chunk_index: 2 })]}
        labels={labels}
        documentTitles={empty}
        stageNames={empty}
      />,
    );
    expect(screen.getAllByText("Wire the OAuth callback")).toHaveLength(1);
  });

  it("orders code citations after graph citations", () => {
    render(
      <CitationList
        citations={[
          cite({ node_type: "code", node_id: "c1", source: "code", path: "a.py", start_line: 1, end_line: 5 }),
          cite({}),
        ]}
        labels={labels}
        documentTitles={empty}
        stageNames={empty}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Wire the OAuth callback");
    expect(items[1]).toHaveTextContent("a.py:1-5");
  });
});
