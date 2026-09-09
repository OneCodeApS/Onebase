"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { ConfirmDeleteForm } from "../../../_components/ConfirmDeleteForm";
import { deleteFolder, loadMoreObjects } from "../../actions";
import { FileDetailPanel, type FileEntry } from "./FileDetailPanel";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

// Renders one folder level: subfolder rows (navigate into / delete) followed by
// file rows (click opens the detail panel). Names are shown relative to the
// current prefix; the full key is kept for every action.
//
// Only the first page arrives as props. Everything after it is appended by the
// loadMoreObjects server action, one S3 page at a time — a folder with 10k+
// entries used to be rendered as 10k+ table rows in a single pass, which is
// what froze the tab. The parent keys this component on prefix+search so the
// accumulated pages reset when the user navigates.
export function ObjectList({
  bucket,
  prefix,
  search,
  initialFolders,
  initialFiles,
  initialToken,
  canWrite,
}: {
  bucket: string;
  prefix: string;
  search: string;
  initialFolders: string[];
  initialFiles: FileEntry[];
  initialToken: string | null;
  canWrite: boolean;
}) {
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [folders, setFolders] = useState(initialFolders);
  const [files, setFiles] = useState(initialFiles);
  const [token, setToken] = useState(initialToken);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const isEmpty = folders.length === 0 && files.length === 0;
  const loadedSize = files.reduce((sum, f) => sum + f.size, 0);

  function loadMore() {
    if (!token || pending) return;
    setError(null);
    startTransition(async () => {
      try {
        const next = await loadMoreObjects(bucket, prefix, search, token);
        setFolders((prev) => [...prev, ...next.folders]);
        setFiles((prev) => [...prev, ...next.files]);
        setToken(next.nextToken);
      } catch (e) {
        setError((e as Error).message || "Failed to load more objects");
      }
    });
  }

  function folderHref(folderPrefix: string): string {
    return `/storage/${encodeURIComponent(bucket)}?prefix=${encodeURIComponent(
      folderPrefix,
    )}`;
  }

  return (
    <>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-700 bg-neutral-800/60 text-left text-neutral-400">
            <th className="px-3 py-2 font-normal">Name</th>
            <th className="px-3 py-2 font-normal text-right">Size</th>
            <th className="px-3 py-2 font-normal">Modified</th>
          </tr>
        </thead>
        <tbody>
          {isEmpty ? (
            <tr>
              <td
                colSpan={3}
                className="px-3 py-6 text-center text-neutral-500"
              >
                {search
                  ? `Nothing here starts with "${search}".`
                  : prefix
                    ? "Empty folder."
                    : "Empty bucket."}
              </td>
            </tr>
          ) : (
            <>
              {folders.map((f) => {
                const base = f.slice(prefix.length).replace(/\/$/, "");
                return (
                  <tr
                    key={f}
                    data-storage-row
                    className="border-b border-neutral-800 last:border-b-0 odd:bg-neutral-900 even:bg-neutral-950/40 hover:bg-neutral-800/50"
                  >
                    <td className="px-3 py-2">
                      <Link
                        href={folderHref(f)}
                        className="flex items-center gap-2 font-mono text-neutral-100 hover:underline"
                      >
                        <span aria-hidden>📁</span>
                        {base}/
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-neutral-600">
                      —
                    </td>
                    <td className="px-3 py-2">
                      {canWrite && (
                        <ConfirmDeleteForm
                          action={deleteFolder}
                          triggerLabel="Delete"
                          triggerClassName="rounded border border-red-900/50 px-2 py-0.5 text-xs text-red-300 hover:bg-red-950/40"
                          title="Delete folder?"
                          message={
                            <>
                              Permanently delete the folder{" "}
                              <span className="font-mono text-neutral-100">
                                {base}/
                              </span>{" "}
                              and <strong>everything inside it</strong> from{" "}
                              <span className="font-mono text-neutral-100">
                                {bucket}
                              </span>
                              ? This cannot be undone.
                            </>
                          }
                        >
                          <input type="hidden" name="bucket" value={bucket} />
                          <input type="hidden" name="folder" value={f} />
                          <input type="hidden" name="prefix" value={prefix} />
                        </ConfirmDeleteForm>
                      )}
                    </td>
                  </tr>
                );
              })}
              {files.map((o) => {
                const base = o.name.slice(prefix.length);
                const isSelected = selected?.name === o.name;
                const lm =
                  o.lastModified instanceof Date
                    ? o.lastModified
                    : new Date(o.lastModified);
                return (
                  <tr
                    key={o.name}
                    data-storage-row
                    onClick={() => setSelected(o)}
                    className={`cursor-pointer border-b border-neutral-800 last:border-b-0 ${
                      isSelected
                        ? "bg-neutral-800/70"
                        : "odd:bg-neutral-900 even:bg-neutral-950/40 hover:bg-neutral-800/50"
                    }`}
                  >
                    <td className="px-3 py-2 font-mono text-neutral-200">
                      {base}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-neutral-400">
                      {formatSize(o.size)}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-neutral-500">
                      {lm.toISOString().slice(0, 19).replace("T", " ")}
                    </td>
                  </tr>
                );
              })}
            </>
          )}
        </tbody>
      </table>

      {/* Counts describe what is loaded, not the folder total: S3 can't report
          a folder's size or entry count without walking every key in it. The
          empty-state row already says everything there is to say. */}
      {!isEmpty && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-800 px-3 py-2 text-xs text-neutral-500">
          <span>
            {folders.length > 0 && (
              <>
                {folders.length} {folders.length === 1 ? "folder" : "folders"}{" "}
                ·{" "}
              </>
            )}
            {files.length} {files.length === 1 ? "object" : "objects"} ·{" "}
            {formatSize(loadedSize)}
            {token && <> loaded so far — there are more</>}
          </span>
          {token && (
            <button
              type="button"
              onClick={loadMore}
              disabled={pending}
              className="rounded border border-neutral-700 bg-neutral-800 px-3 py-1 text-xs text-neutral-100 hover:bg-neutral-700 disabled:opacity-50"
            >
              {pending ? "Loading…" : "Load more"}
            </button>
          )}
        </div>
      )}

      {error && (
        <p className="border-t border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      {selected && (
        <FileDetailPanel
          bucket={bucket}
          prefix={prefix}
          object={selected}
          canWrite={canWrite}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}
