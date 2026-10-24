// apps/web/src/components/project/SourceDocuments.tsx
"use client";

import { useEffect, useState } from "react";
import { listDocuments } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { DocumentUpload } from "./DocumentUpload";
import { DocumentPreview } from "./DocumentPreview";
import type { DocumentOut } from "@/lib/types";

// The uploaded PRD is what every later stage is generated from, so it stays
// visible — and previewable — in every lifecycle state, not just while the
// business user is still uploading. A Tech Lead reviewing the project reads
// the source document here rather than asking for it out of band.
export function SourceDocuments({
  projectId,
  canUpload,
  onPrdPresence,
}: {
  projectId: string;
  canUpload: boolean;
  /** Whether any upload has extracted text — what "Draft from PRD" reads. */
  onPrdPresence?: (present: boolean) => void;
}) {
  const { authHeaders } = useAuth();
  const [documents, setDocuments] = useState<DocumentOut[]>([]);
  const [documentsError, setDocumentsError] = useState(false);
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [previewId, setPreviewId] = useState<string | null>(null);

  // Uploads persist server-side, so the list is read back on mount rather than
  // being rebuilt from whatever this tab uploaded. Without it a refresh showed
  // an empty dropzone and users re-uploaded a PRD that was already extracted.
  useEffect(() => {
    let cancelled = false;
    listDocuments(projectId, authHeaders())
      .then((docs) => {
        if (cancelled) return;
        setDocuments(docs);
        setDocumentsError(false);
      })
      .catch(() => {
        if (cancelled) return;
        setDocumentsError(true);
      })
      .finally(() => {
        if (!cancelled) setDocumentsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const hasPrd = documents.some((d) => d.status === "extracted");
  useEffect(() => {
    if (!documentsLoading) onPrdPresence?.(hasPrd);
  }, [documentsLoading, hasPrd, onPrdPresence]);

  const preview = documents.find((d) => d.id === previewId) ?? null;

  if (!canUpload && documents.length === 0 && !documentsError) return null;

  return (
    <div className="space-y-3">
      {canUpload && (
        <DocumentUpload
          projectId={projectId}
          onUploaded={(doc) =>
            setDocuments((prev) => [...prev.filter((d) => d.id !== doc.id), doc])
          }
        />
      )}
      {/* Said, rather than left blank: an empty gap where a file is about to
          appear reads as "nothing uploaded", which is what made people upload
          the same PRD twice. */}
      {documentsLoading && (
        <p className="text-xs text-slate-500">Loading uploaded documents…</p>
      )}
      {documentsError && (
        <p className="text-xs text-amber-700">
          Couldn&apos;t load previously uploaded documents — reload before uploading again to
          avoid a duplicate.
        </p>
      )}
      {documents.length > 0 && (
        <ul className="space-y-1 text-xs text-slate-500">
          {documents.map((d) => (
            <li key={d.id} className="flex items-center gap-2">
              <span>
                {d.title} — {d.status}
                {d.status === "failed" && " (couldn't extract text — try a text-based export)"}
              </span>
              <button
                type="button"
                onClick={() => setPreviewId(previewId === d.id ? null : d.id)}
                // Named per file: the stage editors below carry their own
                // Raw/Preview toggle, so a bare "Preview" is ambiguous both to
                // a screen reader and to anything querying by accessible name.
                aria-label={`${previewId === d.id ? "Hide" : "Preview"} ${d.title}`}
                className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-700 hover:border-slate-400"
              >
                {previewId === d.id ? "Hide" : "Preview"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {preview && (
        <DocumentPreview
          projectId={projectId}
          document={preview}
          onClose={() => setPreviewId(null)}
        />
      )}
    </div>
  );
}
