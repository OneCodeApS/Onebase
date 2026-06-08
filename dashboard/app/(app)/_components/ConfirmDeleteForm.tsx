"use client";

import { useRef, type ReactNode } from "react";
import { useBackdropDismiss } from "./useBackdropDismiss";

export type ConfirmDeleteFormProps = {
  // The server action invoked when the user confirms.
  action: (formData: FormData) => void | Promise<void>;

  // Trigger button (the visible "Delete" affordance on the page).
  triggerLabel: ReactNode;
  triggerClassName?: string;

  // Dialog copy.
  title?: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;

  // Hidden form fields the server action needs (e.g. <input type="hidden"
  // name="id" value={id} />). They live inside the dialog's form, so they
  // submit only on confirm.
  children?: ReactNode;
};

export function ConfirmDeleteForm({
  action,
  triggerLabel,
  triggerClassName,
  title = "Are you sure?",
  message,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  children,
}: ConfirmDeleteFormProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const backdrop = useBackdropDismiss(dialogRef);

  return (
    <>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        className={triggerClassName}
      >
        {triggerLabel}
      </button>

      <dialog
        ref={dialogRef}
        {...backdrop}
        className="m-auto w-full max-w-md rounded-lg border border-neutral-700 bg-neutral-900 p-0 text-neutral-100 shadow-2xl shadow-black/50 backdrop:bg-black/60"
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <div className="text-lg font-semibold">{title}</div>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label="Close"
            className="rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          >
            ✕
          </button>
        </div>

        <form action={action} className="px-5 py-4">
          {children}
          <p className="text-sm text-neutral-300">{message}</p>
          <div className="-mx-5 mt-5 flex justify-end gap-2 border-t border-neutral-800 px-5 pt-4">
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
            >
              {cancelLabel}
            </button>
            <button
              type="submit"
              className="rounded border border-red-900/50 bg-red-950/40 px-4 py-1.5 text-sm text-red-200 hover:bg-red-900/50"
            >
              {confirmLabel}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
