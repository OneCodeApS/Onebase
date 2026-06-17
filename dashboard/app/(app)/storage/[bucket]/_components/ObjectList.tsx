"use client";

import Link from "next/link";
import { useState } from "react";
import { ConfirmDeleteForm } from "../../../_components/ConfirmDeleteForm";
import { deleteFolder } from "../../actions";
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
export function ObjectList({
  bucket,
  prefix,
  folders,
  files,
  canWrite,
}: {
  bucket: string;
  prefix: string;
  folders: string[];
  files: FileEntry[];
  canWrite: boolean;
}) {
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const isEmpty = folders.length === 0 && files.length === 0;

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
              <td colSpan={3} className="px-3 py-6 text-center text-neutral-500">
                {prefix ? "Empty folder." : "Empty bucket."}
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
