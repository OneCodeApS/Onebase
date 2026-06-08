"use client";

import { useRef } from "react";
import { saveEnvVar } from "../actions";
import { useBackdropDismiss } from "../../../../_components/useBackdropDismiss";

export function EnvVarModal({
  trigger,
  initial,
}: {
  trigger: React.ReactNode;
  initial?: { key: string; value: string; description: string | null };
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const editing = !!initial;

  const backdrop = useBackdropDismiss(dialogRef);

  return (
    <>
      <span onClick={() => dialogRef.current?.showModal()}>{trigger}</span>

      <dialog
        ref={dialogRef}
        {...backdrop}
        className="m-auto w-full max-w-md rounded-lg border border-neutral-700 bg-neutral-900 p-0 text-neutral-100 shadow-2xl shadow-black/50 backdrop:bg-black/60"
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <div className="text-lg font-semibold">
            {editing ? `Edit ${initial!.key}` : "New environment variable"}
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

        <form action={saveEnvVar} className="space-y-4 px-5 py-4">
          <div>
            <label
              htmlFor={`env-key-${initial?.key ?? "new"}`}
              className="block text-xs uppercase tracking-wider text-neutral-500"
            >
              Name
            </label>
            <input
              id={`env-key-${initial?.key ?? "new"}`}
              type="text"
              name="key"
              required
              autoFocus={!editing}
              readOnly={editing}
              defaultValue={initial?.key ?? ""}
              placeholder="API_KEY"
              pattern="[A-Z_][A-Z0-9_]*"
              title="UPPER_SNAKE_CASE only"
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-sm read-only:opacity-70"
            />
            <p className="mt-1 text-xs text-neutral-500">
              UPPER_SNAKE_CASE. Access in code as{" "}
              <span className="font-mono">ctx.env.{initial?.key ?? "API_KEY"}</span>.
            </p>
          </div>

          <div>
            <label
              htmlFor={`env-value-${initial?.key ?? "new"}`}
              className="block text-xs uppercase tracking-wider text-neutral-500"
            >
              Value
            </label>
            <input
              id={`env-value-${initial?.key ?? "new"}`}
              type="password"
              name="value"
              autoFocus={editing}
              autoComplete="off"
              placeholder={
                editing
                  ? "•••••• (saved, leave blank to keep)"
                  : "paste value"
              }
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-sm"
            />
            <p className="mt-1 text-xs text-neutral-500">
              {editing
                ? "We never display the current value. Leave blank to keep what's saved, or type a new value to replace it."
                : "Treated as sensitive — masked everywhere it appears."}
            </p>
          </div>

          <div>
            <label
              htmlFor={`env-desc-${initial?.key ?? "new"}`}
              className="block text-xs uppercase tracking-wider text-neutral-500"
            >
              Description (optional)
            </label>
            <input
              id={`env-desc-${initial?.key ?? "new"}`}
              type="text"
              name="description"
              defaultValue={initial?.description ?? ""}
              placeholder="What is this for?"
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm"
            />
          </div>

          <div className="flex justify-end gap-2 border-t border-neutral-800 pt-4">
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded border border-neutral-700 bg-neutral-800 px-4 py-1.5 text-sm hover:bg-neutral-700"
            >
              Save
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
