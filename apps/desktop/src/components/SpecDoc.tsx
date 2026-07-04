import ReactMarkdown from "react-markdown";

// Spec Kit templates emit [NEEDS CLARIFICATION: question] where the model is
// unsure. Business users should see these as questions to answer, not literal
// text buried in the doc.
const CLARIFY_RE = /\[NEEDS CLARIFICATION:\s*([^\]]+)\]/gi;

export function extractClarifications(content: string | null): string[] {
  if (!content) return [];
  const out: string[] = [];
  for (const m of content.matchAll(CLARIFY_RE)) out.push(m[1].trim());
  return out;
}

// Business-facing rendered document. Streaming shows raw text (it changes every
// token); once settled it renders as clean markdown.
export default function SpecDoc({
  content,
  streaming,
}: {
  content: string;
  streaming: boolean;
}) {
  if (streaming) {
    return <pre className="doc streaming">{content}</pre>;
  }
  return (
    <div className="doc rendered">
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  );
}
