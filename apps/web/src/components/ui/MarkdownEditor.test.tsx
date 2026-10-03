import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultEditorMode, MarkdownEditor } from "./MarkdownEditor";

afterEach(() => {
  cleanup();
});

describe("MarkdownEditor", () => {
  it("opens a document with content as a preview", () => {
    render(<MarkdownEditor value="# Hello" onChange={vi.fn()} onSave={vi.fn()} />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Hello" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview" })).toHaveAttribute("aria-pressed", "true");
  });

  it("opens an empty document on the raw textarea", () => {
    render(<MarkdownEditor value="" onChange={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("picks the default mode from content", () => {
    expect(defaultEditorMode("")).toBe("raw");
    expect(defaultEditorMode("  \n")).toBe("raw");
    expect(defaultEditorMode("# Doc")).toBe("preview");
    });

  it("keeps an explicit Raw choice once content arrives", () => {
    const { rerender } = render(<MarkdownEditor value="" onChange={vi.fn()} onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    rerender(<MarkdownEditor value="# Hello" onChange={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByRole("textbox")).toHaveValue("# Hello");
  });

  it("stays on raw while someone types into an empty document", () => {
    const { rerender } = render(<MarkdownEditor value="" onChange={vi.fn()} onSave={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "#" } });
    rerender(<MarkdownEditor value="#" onChange={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByRole("textbox")).toHaveValue("#");
  });

  it("names the textarea with the given label", () => {
    render(
      <MarkdownEditor value="" onChange={vi.fn()} onSave={vi.fn()} label="Tasks document" />,
    );
    expect(screen.getByRole("textbox", { name: "Tasks document" })).toBeInTheDocument();
  });

  it("calls onChange when the raw textarea is edited", () => {
    const onChange = vi.fn();
    render(<MarkdownEditor value="# Hello" onChange={onChange} onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "# Hello world" } });
    expect(onChange).toHaveBeenCalledWith("# Hello world");
  });

  it("switches to rendered markdown when Preview is clicked", () => {
    render(<MarkdownEditor value="# Hello" onChange={vi.fn()} onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /preview/i }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Hello" })).toBeInTheDocument();
  });

  it("calls onSave when Save is clicked", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<MarkdownEditor value="# Hello" onChange={vi.fn()} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("disables Save while saving", () => {
    render(<MarkdownEditor value="# Hello" onChange={vi.fn()} onSave={vi.fn()} saving />);
    expect(screen.getByRole("button", { name: /saving/i })).toBeDisabled();
  });

  it("shows the error banner when error is set", () => {
    render(<MarkdownEditor value="# Hello" onChange={vi.fn()} onSave={vi.fn()} error="save failed" />);
    expect(screen.getByText("save failed")).toBeInTheDocument();
  });
});
