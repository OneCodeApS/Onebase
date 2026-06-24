"use client";

import { useState, useTransition } from "react";
import { rotateBiReadonlyPassword } from "../actions";

// Rotates the read-only bi_readonly database password and shows the new value
// exactly once. Two-step inline confirm (no window.confirm, matching the app's
// convention) because rotation immediately invalidates the old password for any
// new connection.
export function RotateBiPassword() {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function rotate() {
    setConfirming(false);
    setError(null);
    setPassword(null);
    setCopied(false);
    startTransition(async () => {
      const result = await rotateBiReadonlyPassword();
      if (result.ok) setPassword(result.password);
      else setError(result.error);
    });
  }

  async function copy() {
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can fail in insecure contexts; no-op.
    }
  }

  return (
    <div className="mt-3">
      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={pending}
          className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800 disabled:opacity-50"
        >
          {pending ? "Rotating…" : "Rotate password"}
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-amber-300">
            Generate a new password? The current one stops working for new
            connections immediately.
          </span>
          <button
            type="button"
            onClick={rotate}
            className="rounded border border-amber-700/60 bg-amber-600/20 px-3 py-1.5 text-sm text-amber-200 hover:bg-amber-600/30"
          >
            Confirm rotate
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
          >
            Cancel
          </button>
        </div>
      )}

      {error && (
        <p className="mt-3 rounded border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      {password && (
        <div className="mt-3 rounded border border-emerald-900/50 bg-emerald-950/20 p-3">
          <p className="text-xs font-medium text-emerald-300">
            New password — copy it now, it won&apos;t be shown again.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-200">
              {password}
            </code>
            <button
              type="button"
              onClick={copy}
              className="shrink-0 rounded border border-neutral-700 bg-neutral-800 px-3 py-2 text-xs hover:bg-neutral-700"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="mt-2 text-xs text-neutral-500">
            Hand it to whoever connects (user{" "}
            <span className="font-mono text-neutral-400">bi_readonly</span>) and
            have them reconnect. Existing sessions keep working until they
            disconnect.
          </p>
        </div>
      )}
    </div>
  );
}
