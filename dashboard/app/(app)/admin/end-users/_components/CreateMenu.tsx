"use client";

import { useEffect, useRef, useState } from "react";
import { createEndUser } from "../actions";

// "+" button in the page header. Opens a small menu (just "End user" today —
// the menu shape leaves room for future creatable things), which opens a
// slide-over panel from the right with the create form. Same interaction
// conventions as the auth-providers ProviderConfigPanel: Escape closes,
// clicking outside closes.
export function CreateMenu() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (menuOpen && menuRef.current && !menuRef.current.contains(t)) {
        setMenuOpen(false);
      }
      if (panelOpen && panelRef.current && !panelRef.current.contains(t)) {
        setPanelOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setMenuOpen(false);
        setPanelOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, panelOpen]);

  return (
    <>
      <div ref={menuRef} className="relative">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Create"
          aria-expanded={menuOpen}
          className="rounded border border-neutral-700 bg-neutral-800 px-3 py-1 text-lg leading-none hover:bg-neutral-700"
        >
          +
        </button>
        {menuOpen && (
          <div className="absolute right-0 z-30 mt-1 w-40 overflow-hidden rounded border border-neutral-700 bg-neutral-900 shadow-xl shadow-black/40">
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                setPanelOpen(true);
              }}
              className="block w-full px-3 py-2 text-left text-sm text-neutral-200 hover:bg-neutral-800"
            >
              End user
            </button>
          </div>
        )}
      </div>

      {panelOpen && (
        <aside
          ref={panelRef}
          className="fixed right-0 top-0 z-40 flex h-screen w-[420px] max-w-full flex-col border-l border-neutral-800 bg-neutral-950 shadow-2xl shadow-black/40"
        >
          <div className="flex items-start justify-between gap-3 border-b border-neutral-800 px-5 py-4">
            <div>
              <div className="text-lg font-semibold text-neutral-100">
                Create end user
              </div>
              <p className="mt-1 text-xs text-neutral-400">
                Provisions an email/password account directly — public signups
                stay off. Use Reset password later if it needs changing.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setPanelOpen(false)}
              aria-label="Close"
              className="shrink-0 rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
            >
              ✕
            </button>
          </div>

          <form action={createEndUser} className="flex flex-1 flex-col">
            <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
              <div>
                <label
                  htmlFor="create-user-email"
                  className="block text-xs uppercase tracking-wider text-neutral-500"
                >
                  Email
                </label>
                <input
                  id="create-user-email"
                  type="email"
                  name="email"
                  required
                  autoFocus
                  placeholder="user@example.com"
                  className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-sm"
                />
              </div>
              <div>
                <label
                  htmlFor="create-user-password"
                  className="block text-xs uppercase tracking-wider text-neutral-500"
                >
                  Password
                </label>
                <input
                  id="create-user-password"
                  type="password"
                  name="password"
                  required
                  minLength={12}
                  autoComplete="new-password"
                  className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-sm"
                />
                <p className="mt-1 text-xs text-neutral-500">
                  Minimum 12 characters. Stored argon2-hashed.
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t border-neutral-800 px-5 py-3">
              <button
                type="button"
                onClick={() => setPanelOpen(false)}
                className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded border border-neutral-700 bg-neutral-800 px-4 py-1.5 text-sm hover:bg-neutral-700"
              >
                Create
              </button>
            </div>
          </form>
        </aside>
      )}
    </>
  );
}
