import * as vscode from "vscode";
import type { LoggerLike } from "@promptconnext/pz-cloud";

export class OutputLogger implements LoggerLike {
  private readonly channel: vscode.OutputChannel;

  constructor() {
    this.channel = vscode.window.createOutputChannel("PromptConnext");
  }

  info(message: string): void {
    this.write("info", message);
  }

  warn(message: string): void {
    this.write("warn", message);
  }

  error(message: string): void {
    this.write("error", message);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }

  private write(level: string, message: string): void {
    // Timestamps come from the host clock rather than a wrapper so the log
    // lines up with the editor's own output panels during a bug report.
    this.channel.appendLine(`[${new Date().toISOString()}] ${level}: ${message}`);
  }
}
