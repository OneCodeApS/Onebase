import { useRef, type MouseEvent as ReactMouseEvent, type RefObject } from "react";

// Backdrop-click dismissal for a native <dialog> opened with showModal().
// Spread the returned handlers onto the <dialog>:
//
//   const dialogRef = useRef<HTMLDialogElement | null>(null);
//   const backdrop = useBackdropDismiss(dialogRef);
//   <dialog ref={dialogRef} {...backdrop}>…</dialog>
//
// Dismisses only when a press BOTH starts and ends on the backdrop (the
// <dialog> element itself — a click on the ::backdrop reports the dialog as its
// own target). A bare `e.target === dialog` check on `click` alone is wrong: a
// `click` fires on the common ancestor of the mousedown and mouseup targets, so
// a text-selection drag that ends on the backdrop — or a dropdown option that's
// removed from the DOM on release and retargets the click up to the <dialog> —
// would otherwise close the dialog by accident. Anchoring on where the press
// *started* (mousedown) fixes both.
export function useBackdropDismiss(
  dialogRef: RefObject<HTMLDialogElement | null>,
) {
  const downOnBackdrop = useRef(false);
  return {
    onMouseDown(e: ReactMouseEvent<HTMLDialogElement>) {
      downOnBackdrop.current = e.target === dialogRef.current;
    },
    onClick(e: ReactMouseEvent<HTMLDialogElement>) {
      if (downOnBackdrop.current && e.target === dialogRef.current) {
        dialogRef.current?.close();
      }
    },
  };
}
