"use client";

import { useRef } from "react";
import { resetEndUserPassword } from "../actions";
import { useBackdropDismiss } from "../../../_components/useBackdropDismiss";

export function PasswordResetModal({ id, email }: { id: string; email: string }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  const backdrop = useBackdropDismiss(dialogRef);

  return (
    <>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        className="text-xs text-neutral-400 underline hover:text-neutral-100"
      >
        Reset password
      </button>

      <dialog
        ref={dialogRef}
        {...backdrop}
        className="m-auto w-full max-w-md rounded-lg border border-neutral-700 bg-neutral-900 p-0 text-neutral-100 shadow-2xl shadow-black/50 backdrop:bg-black/60"
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <div className="text-lg font-semibold">Reset password</div>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label="Close"
            className="rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          >
            ✕
          </button>
        </div>

        <form action={resetEndUserPassword} className="space-y-4 px-5 py-4">
          <input type="hidden" name="id" value={id} />

          <p className="text-sm text-neutral-400">
            Sets a new password for{" "}
            <span className="font-mono text-neutral-200">{email}</span> and
            revokes every active session so they have to sign back in.
          </p>

          <div>
            <label
              htmlFor={`pw-${id}`}
              className="block text-sm font-medium text-neutral-200"
            >
              New password (min 12 chars)
            </label>
            <input
              id={`pw-${id}`}
              type="password"
              name="password"
              required
              minLength={12}
              autoComplete="new-password"
              className="mt-2 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-sm"
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
              Set password
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
