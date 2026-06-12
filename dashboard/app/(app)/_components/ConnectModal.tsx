"use client";

import { useRef, useState } from "react";
import { useBackdropDismiss } from "./useBackdropDismiss";

// Supabase-style "Connect" dialog. Shows the two values a client app needs to
// talk to this project — the public API URL and the anon key — pre-filled with
// the real values for this install, ready to paste into an app's env file.
//
// The anon key is intentionally shown in the clear: it's a public, embeddable
// credential (see /admin/api-keys), so there's nothing to hide here.

type Framework = {
  id: string;
  label: string;
  // Env-var prefix the framework exposes to client-side code.
  prefix: string;
  // The file the vars normally live in, shown as a caption.
  file: string;
};

const FRAMEWORKS: Framework[] = [
  { id: "next", label: "Next.js", prefix: "NEXT_PUBLIC_", file: ".env.local" },
  { id: "vite", label: "Vite", prefix: "VITE_", file: ".env" },
  { id: "expo", label: "Expo", prefix: "EXPO_PUBLIC_", file: ".env" },
  { id: "server", label: "Server / other", prefix: "", file: ".env" },
];

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard write can fail in insecure contexts; silently no-op.
    }
  }
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="rounded border border-neutral-700 bg-neutral-800 px-3 py-1 text-xs hover:bg-neutral-700"
    >
      {copied ? "Copied" : label}
    </button>
  );
}

export function ConnectModal({
  apiUrl,
  anonKey,
}: {
  apiUrl: string;
  anonKey: string;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const backdrop = useBackdropDismiss(dialogRef);
  const [fwId, setFwId] = useState(FRAMEWORKS[0].id);

  const fw = FRAMEWORKS.find((f) => f.id === fwId) ?? FRAMEWORKS[0];
  const urlVar = `${fw.prefix}ONEBASE_URL`;
  const keyVar = `${fw.prefix}ONEBASE_ANON_KEY`;
  const envBlock = `${urlVar}=${apiUrl}\n${keyVar}=${anonKey}`;

  const usage = `// Read REST tables with the anon key (public access).
const res = await fetch(
  \`\${process.env.${urlVar}}/rest/v1/todos?select=*\`,
  {
    headers: {
      apikey: process.env.${keyVar},
      Authorization: \`Bearer \${process.env.${keyVar}}\`,
    },
  },
);
const rows = await res.json();`;

  return (
    <>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        className="flex items-center gap-1.5 rounded-md border border-emerald-700/60 bg-emerald-600/90 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-600"
      >
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M6.5 1.5 2 9h3.5L4 14.5 11 6H7l1.5-4.5z" />
        </svg>
        Connect
      </button>

      <dialog
        ref={dialogRef}
        {...backdrop}
        className="m-auto w-full max-w-2xl rounded-lg border border-neutral-700 bg-neutral-900 p-0 text-neutral-100 shadow-2xl shadow-black/50 backdrop:bg-black/60"
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <div>
            <div className="text-lg font-semibold">Connect to your project</div>
            <p className="mt-0.5 text-xs text-neutral-500">
              Drop these into your app&apos;s environment file and you&apos;re
              wired up to this project&apos;s API.
            </p>
          </div>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label="Close"
            className="rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          >
            ✕
          </button>
        </div>

        <div className="space-y-5 px-5 py-4">
          {/* Framework picker — only changes the env-var prefix. */}
          <div className="flex flex-wrap gap-1">
            {FRAMEWORKS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFwId(f.id)}
                className={`rounded px-3 py-1 text-xs ${
                  f.id === fwId
                    ? "bg-neutral-800 text-neutral-100"
                    : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* Env vars — the headline of the dialog. */}
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium text-neutral-200">
                Environment variables
              </h3>
              <span className="font-mono text-xs text-neutral-500">{fw.file}</span>
            </div>
            <div className="mt-2 overflow-x-auto rounded border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-xs leading-relaxed text-neutral-300">
              <div>
                <span className="text-emerald-400">{urlVar}</span>=
                <span className="text-neutral-200">{apiUrl}</span>
              </div>
              <div className="break-all">
                <span className="text-emerald-400">{keyVar}</span>=
                <span className="text-neutral-200">{anonKey}</span>
              </div>
            </div>
            <div className="mt-2">
              <CopyButton value={envBlock} label="Copy .env" />
            </div>
          </div>

          {/* Usage snippet — framework-agnostic fetch against PostgREST. */}
          <div>
            <h3 className="text-sm font-medium text-neutral-200">Usage</h3>
            <pre className="mt-2 overflow-x-auto rounded border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-xs leading-relaxed text-neutral-300">
              {usage}
            </pre>
            <div className="mt-2 flex items-center gap-3">
              <CopyButton value={usage} label="Copy snippet" />
              <p className="text-xs text-neutral-500">
                The anon key is a public credential — safe to ship in client
                code. Server-side admin work uses the{" "}
                <span className="font-mono text-neutral-400">service_role</span>{" "}
                key from{" "}
                <a
                  href="/admin/api-keys"
                  className="text-neutral-300 underline hover:text-neutral-100"
                >
                  API keys
                </a>
                .
              </p>
            </div>
          </div>
        </div>
      </dialog>
    </>
  );
}
