import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditor } from "./MarkdownEditor";

afterEach(() => {
  cleanup();
});

describe("MarkdownEditor", () => {
  it("shows the raw textarea by default with the given value", () => {
    render(<MarkdownEditor value="# Hello" onChange={vi.fn()} onSave={vi.fn()} />);
    const textarea = screen.getByRole("textbox");
    expect(textarea).toHaveValue("# Hello");
  });

  it("calls onChange when the raw textarea is edited", () => {
    const onChange = vi.fn();
    render(<MarkdownEditor value="# Hello" onChange={onChange} onSave={vi.fn()} />);
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
