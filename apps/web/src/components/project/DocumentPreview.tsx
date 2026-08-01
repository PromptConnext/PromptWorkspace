// apps/web/src/components/project/DocumentPreview.tsx
"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { fetchDocumentContent } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { DocumentOut } from "@/lib/types";

// A PDF renders in the browser's own viewer via an object URL; Markdown and
// plain text are read as text and rendered here. Both come from the raw stored
// bytes rather than the extracted text, so reviewing a PRD shows the document
// as it was written, layout and all.
export function DocumentPreview({
  projectId,
  document,
  onClose,
}: {
  projectId: string;
  document: DocumentOut;
  onClose: () => void;
}) {
  const { authHeaders } = useAuth();
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isPdf = document.mime === "application/pdf";

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;

    setObjectUrl(null);
    setText(null);
    setError(null);

    fetchDocumentContent(projectId, document.id, authHeaders())
      .then(async (blob) => {
        if (cancelled) return;
        if (isPdf) {
          url = URL.createObjectURL(blob);
          setObjectUrl(url);
        } else {
          setText(await blob.text());
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError((err as Error).message);
      });

    return () => {
      cancelled = true;
      // Object URLs pin the blob in memory until revoked — a member paging
      // through several PRDs would otherwise leak every file they opened.
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, document.id, isPdf]);

  const loading = !error && !objectUrl && text === null;

  return (
    <div className="rounded-lg border border-slate-200">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
        <p className="truncate text-sm font-medium text-slate-900">{document.title}</p>
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-slate-300 bg-white px-2 py-1 text-xs hover:border-slate-400"
        >
          Close preview
        </button>
      </div>

      {error && <p className="px-3 py-2 text-sm text-red-600">Couldn&apos;t load this file — {error}</p>}
      {loading && <p className="px-3 py-2 text-sm text-slate-500">Loading preview…</p>}

      {objectUrl && (
        <iframe
          src={objectUrl}
          title={`Preview of ${document.title}`}
          className="h-[70vh] w-full rounded-b-lg"
        />
      )}

      {text !== null && (
        <div className="prose prose-sm max-h-[70vh] max-w-none overflow-auto p-3 text-slate-800">
          <ReactMarkdown>{text}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
