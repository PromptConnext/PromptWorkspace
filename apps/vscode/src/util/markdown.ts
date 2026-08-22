// Escaping for cloud-supplied strings that reach a `vscode.MarkdownString`.
//
// A project name, workspace name, task title or acceptance-criterion text
// comes from the cloud and is rendered as tooltip markdown. Unescaped, a name
// like `[click](https://evil)` becomes a live link and `![](https://tracker/x.png)`
// becomes a loaded image — both fire on hover, with no click required. This
// is deliberately conservative: it is cheaper to over-escape a literal `!` in
// a project name than to under-escape one of these and reopen the hole.
//
// Pure and vscode-free on purpose, so the host-free `node --test` runner can
// exercise it directly.

const MARKDOWN_SPECIAL_CHARS = /[\\`*_{}[\]()#+\-.!|]/g;

export function escapeMarkdown(text: string): string {
  const escaped = text.replace(MARKDOWN_SPECIAL_CHARS, (ch) => `\\${ch}`);
  // A '>' at the start of a line turns it into a blockquote. Cloud text can
  // carry embedded newlines, so this runs per line ('m' flag) rather than
  // once against the whole string.
  return escaped.replace(/^>/gm, "\\>");
}
