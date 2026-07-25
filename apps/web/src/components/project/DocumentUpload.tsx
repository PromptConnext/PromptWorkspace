// apps/web/src/components/project/DocumentUpload.tsx
"use client";

import { useState } from "react";
import { CLOUD_API_URL } from "@/lib/config";
import { useAuth } from "@/lib/auth";
import type { DocumentOut } from "@/lib/types";

// Direct fetch, not apiFetch: this is a multipart upload, not JSON — apiFetch
// always sets content-type: application/json, which would break the
// boundary-encoded body. Mirrors apps/cloud/app/api/documents.py's
// ALLOWED_MIMES exactly so the browser's file picker only offers files the
// server will actually accept.
const ACCEPTED_MIME = "text/markdown,text/plain,application/pdf";

export function DocumentUpload({
  projectId,
  onUploaded,
}: {
  projectId: string;
  onUploaded: (doc: DocumentOut) => void;
}) {
  const { authHeaders } = useAuth();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file next time
    if (!file) return;

    setUploading(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`${CLOUD_API_URL}/projects/${projectId}/documents`, {
        method: "POST",
        headers: authHeaders(),
        body,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { detail?: string }).detail ?? `upload failed (${res.status})`);
      }
      const doc = (await res.json()) as DocumentOut;
      if (doc.status === "failed") {
        setError("Couldn't read this file — try a text-based export (not a scanned image).");
      }
      onUploaded(doc);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="rounded-lg border border-dashed border-slate-300 p-4">
      <label className="flex cursor-pointer items-center justify-center gap-2 text-sm text-slate-600">
        <input
          type="file"
          accept={ACCEPTED_MIME}
          onChange={handleChange}
          disabled={uploading}
          className="sr-only"
        />
        {uploading ? "Uploading…" : "Upload a PRD (PDF or Markdown)"}
      </label>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
