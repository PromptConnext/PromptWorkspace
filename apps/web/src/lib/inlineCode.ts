/**
 * Markdown inline code in task titles. The tasks stage writes titles like
 * "Create project structure: `src/consent/`, `src/auth/`", and raw backticks
 * on a card read as noise. Only backtick pairs are recognised — no markdown
 * library, no HTML — so a title can never inject markup.
 */

export interface InlineSegment {
  text: string;
  code: boolean;
}

/**
 * `text` cut into plain and code runs. A trailing unpaired backtick, and an
 * empty pair, stay literal: they are more likely a typo than formatting.
 */
export function splitInlineCode(text: string): InlineSegment[] {
  const parts = text.split("`");
  // An even part count means an odd backtick count: rejoin the last one.
  if (parts.length % 2 === 0) {
    const tail = parts.pop();
    parts[parts.length - 1] += `\`${tail}`;
  }
  const segments: InlineSegment[] = [];
  parts.forEach((part, i) => {
    const code = i % 2 === 1 && part !== "";
    const value = i % 2 === 1 && part === "" ? "``" : part;
    if (value === "") return;
    const last = segments[segments.length - 1];
    if (!code && last && !last.code) last.text += value;
    else segments.push({ text: value, code });
  });
  return segments;
}

/** The title as words, for accessible names and toasts: backticks dropped. */
export function plainInlineCode(text: string): string {
  return splitInlineCode(text)
    .map((s) => s.text)
    .join("");
}
