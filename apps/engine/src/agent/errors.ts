// Structured error kinds for agent/loop failures, so the desktop UI can react
// differently (e.g. point at the AgentPicker for "no-agent", offer a Retry
// button for "network") instead of rendering one generic error paragraph.
export type AgentErrorKind =
  | "no-agent"
  | "agent-crash"
  | "no-changes"
  | "bad-output"
  | "network"
  | "timeout";

export class AgentError extends Error {
  kind: AgentErrorKind;

  constructor(kind: AgentErrorKind, message: string) {
    super(message);
    this.name = "AgentError";
    this.kind = kind;
  }
}
