"use client";

import { useEffect, useRef, useState } from "react";
import { ConfirmDeleteForm } from "../../../_components/ConfirmDeleteForm";
import { deleteObject, getShareLink } from "../../actions";

export type FileEntry = {
  name: string;
  size: number;
  lastModified: Date | string;
};

function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

type PreviewKind = "image" | "video" | "audio" | "pdf" | "text" | "none";

function previewKind(name: string): PreviewKind {
  const ext = extensionOf(name);
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"].includes(ext)) return "image";
  if (["mp4", "webm", "mov", "m4v"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "m4a", "flac"].includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (["txt", "md", "json", "csv", "log", "yaml", "yml", "xml", "html"].includes(ext)) return "text";
  return "none";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function Preview({
  url,
  kind,
  name,
}: {
  url: string | null;
  kind: PreviewKind;
  name: string;
}) {
  const [text, setText] = useState<string | null>(null);
  const [textError, setTextError] = useState<string | null>(null);

  useEffect(() => {
    if (kind !== "text" || !url) return;
    let cancelled = false;
    fetch(url)
      .then((r) => r.text())
      .then((t) => {
        if (!cancelled) setText(t.slice(0, 20_000));
      })
      .catch((e) => {
        if (!cancelled) setTextError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [url, kind]);

  if (!url) {
    return (
      <div className="flex h-40 items-center justify-center rounded border border-neutral-800 bg-neutral-950 text-sm text-neutral-500">
        Loading preview…
      </div>
    );
  }

  if (kind === "image") {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={url}
        alt={name}
        className="mx-auto max-h-64 rounded border border-neutral-800 bg-neutral-950 object-contain"
      />
    );
  }
  if (kind === "video") {
    return (
      <video
        src={url}
        controls
        className="w-full rounded border border-neutral-800 bg-black"
      />
    );
  }
  if (kind === "audio") {
    return <audio src={url} controls className="w-full" />;
  }
  if (kind === "pdf") {
    return (
      <iframe
        src={url}
        title={name}
        className="h-72 w-full rounded border border-neutral-800 bg-white"
      />
    );
  }
  if (kind === "text") {
    if (textError) {
      return (
        <p className="text-xs text-red-400">Failed to load preview: {textError}</p>
      );
    }
    return (
      <pre className="max-h-64 overflow-auto rounded border border-neutral-800 bg-neutral-950 p-2 text-xs text-neutral-200">
        {text ?? "Loading…"}
      </pre>
    );
  }
  return (
    <div className="flex h-32 items-center justify-center rounded border border-neutral-800 bg-neutral-950 text-sm text-neutral-500">
      No preview available
    </div>
  );
}

export function FileDetailPanel({
  bucket,
  prefix,
  object,
  canWrite,
  onClose,
}: {
  bucket: string;
  prefix: string;
  object: FileEntry;
  canWrite: boolean;
  onClose: () => void;
}) {
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const kind = previewKind(object.name);
  // Object.name is the full key (may include folders); show just the basename.
  const displayName = object.name.split("/").pop() || object.name;

  // Fetch a share URL the moment the panel opens — used for both the preview
  // and the "copy share link" button below.
  useEffect(() => {
    setShareUrl(null);
    setShareError(null);
    let cancelled = false;
    getShareLink(bucket, object.name)
      .then((r) => {
        if (!cancelled) setShareUrl(r.url);
      })
      .catch((e) => {
        if (!cancelled) setShareError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [bucket, object.name]);

  // Click outside the panel closes it. We exclude clicks on the table row
  // itself (handled by parent) by checking the panel boundary only.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        // Don't close immediately on the same click that selected the row.
        // The parent's onClick will set state on the same event; the document
        // listener fires after. To avoid that race we let the parent track
        // selection and close only when the click is outside both the panel
        // AND any table row.
        const target = e.target as HTMLElement;
        if (target.closest("[data-storage-row]")) return;
        onClose();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  async function handleCopy() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard write can fail in insecure contexts; silently no-op.
    }
  }

  const downloadHref = `/storage/${encodeURIComponent(bucket)}/download?name=${encodeURIComponent(object.name)}`;
  const lastModified =
    object.lastModified instanceof Date
      ? object.lastModified
      : new Date(object.lastModified);

  return (
    <aside
      ref={panelRef}
      className="fixed right-0 top-0 z-40 flex h-screen w-[420px] flex-col border-l border-neutral-800 bg-neutral-950 shadow-2xl shadow-black/40"
    >
      <div className="flex items-start justify-between gap-3 border-b border-neutral-800 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-sm text-neutral-100" title={object.name}>
            {displayName}
          </div>
          <div className="mt-0.5 text-xs text-neutral-500">
            {formatSize(object.size)} ·{" "}
            {lastModified.toISOString().slice(0, 19).replace("T", " ")}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="shrink-0 rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <Preview url={shareUrl} kind={kind} name={object.name} />

        {shareError && (
          <p className="mt-3 text-xs text-red-400">
            Share link failed: {shareError}
          </p>
        )}

        <div className="mt-4 space-y-1 text-xs text-neutral-400">
          <div>
            <span className="text-neutral-500">Bucket:</span>{" "}
            <span className="font-mono text-neutral-300">{bucket}</span>
          </div>
          <div>
            <span className="text-neutral-500">Preview:</span>{" "}
            <span className="text-neutral-300">{kind === "none" ? "—" : kind}</span>
          </div>
        </div>
      </div>

      <div className="border-t border-neutral-800 px-4 py-3">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleCopy}
            disabled={!shareUrl}
            className="rounded border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {copied ? "Copied" : "Copy share link"}
          </button>
          <a
            href={downloadHref}
            className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-800"
          >
            Download
          </a>
          {canWrite && (
            <ConfirmDeleteForm
              action={deleteObject}
              triggerLabel="Delete"
              triggerClassName="ml-auto rounded border border-red-900/50 px-3 py-1.5 text-xs text-red-300 hover:bg-red-950/40"
              title="Delete file?"
              message={
                <>
                  Permanently delete{" "}
                  <span className="font-mono text-neutral-100">{object.name}</span>{" "}
                  from <span className="font-mono text-neutral-100">{bucket}</span>?
                  This cannot be undone.
                </>
              }
            >
              <input type="hidden" name="bucket" value={bucket} />
              <input type="hidden" name="name" value={object.name} />
              <input type="hidden" name="prefix" value={prefix} />
            </ConfirmDeleteForm>
          )}
        </div>
      </div>
    </aside>
  );
}
