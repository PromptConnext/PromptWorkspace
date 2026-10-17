// Decides what the Project Context view shows for one rules file. No `vscode`
// import, so it is unit-tested; contextView.ts only turns the result into HTML.

import type { RepoDocContents } from "./repoDocs.ts";

export const CLOUD_CAPTION = "From PromptWorkspace. Not in this repository yet.";

export type DocView =
  | { kind: "disk"; text: string; canOpen: true }
  | { kind: "cloud"; text: string; caption: string; canOpen: false }
  | { kind: "missing"; canOpen: false };

/** `cloudText` is the cloud's text for this document, or null when the cloud has
 *  none (only the constitution has a cloud counterpart). The file on disk wins. */
export function resolveDocView(doc: RepoDocContents, cloudText: string | null): DocView {
  if (doc.text !== null) return { kind: "disk", text: doc.text, canOpen: true };
  if (cloudText) return { kind: "cloud", text: cloudText, caption: CLOUD_CAPTION, canOpen: false };
  return { kind: "missing", canOpen: false };
}
