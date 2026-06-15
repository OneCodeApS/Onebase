"use client";

import { useActionState, useEffect, useState } from "react";
import {
  revokeAccessToken,
  updateAccessToken,
  type UpdateTokenResult,
} from "../actions";
import { SCOPE_OPTIONS } from "./scopes";

// One token row + an expandable in-place rights editor. Every scope and the
// read-only flag toggle independently here (unlike the create form, which
// disables write scopes while read-only is on) — the stored set is still
// gated by the owner's role and the read_only flag when the token is used, so
// any combination is safe to save. Editing never changes the token string, so
// a client's committed .mcp.json keeps working with the new rights.
export function TokenRow(props: {
  id: string;
  name: string;
  ownerEmail: string;
  scopes: string[];
  readOnly: boolean;
  expires: string;
  lastUsed: string;
  dead: boolean;
  revoked: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [state, formAction, pending] = useActionState<UpdateTokenResult, FormData>(
    updateAccessToken,
    null,
  );

  // Collapse the editor once a save succeeds (the table is revalidated
  // server-side, so the row re-renders with the new rights).
  useEffect(() => {
    if (state?.ok) setEditing(false);
  }, [state]);

  return (
    <>
      <tr className={`border-t border-neutral-800 ${props.dead ? "opacity-40" : ""}`}>
        <td className="py-1.5 pr-3 font-mono">{props.name}</td>
        <td className="py-1.5 pr-3">{props.ownerEmail}</td>
        <td className="py-1.5 pr-3 font-mono">{props.scopes.join(", ")}</td>
        <td className="py-1.5 pr-3">
          {props.revoked ? (
            <span className="text-red-400">revoked</span>
          ) : props.readOnly ? (
            "read-only"
          ) : (
            <span className="text-amber-300">read-write</span>
          )}
        </td>
        <td className="py-1.5 pr-3">{props.expires}</td>
        <td className="py-1.5 pr-3">{props.lastUsed}</td>
        <td className="py-1.5 text-right">
          {!props.revoked && (
            <span className="inline-flex gap-2">
              <button
                type="button"
                onClick={() => setEditing((v) => !v)}
                className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-200 hover:bg-neutral-800"
              >
                {editing ? "Close" : "Edit"}
              </button>
              <form action={revokeAccessToken}>
                <input type="hidden" name="id" value={props.id} />
                <button
                  type="submit"
                  className="rounded border border-red-900/50 px-2 py-0.5 text-red-300 hover:bg-red-950/30"
                >
                  Revoke
                </button>
              </form>
            </span>
          )}
        </td>
      </tr>

      {editing && (
        <tr className="border-t border-neutral-800/50 bg-neutral-950/40">
          <td colSpan={7} className="px-3 py-3 text-xs">
            <form action={formAction}>
              <input type="hidden" name="id" value={props.id} />

              {state && !state.ok && (
                <p className="mb-2 rounded border border-red-900/50 bg-red-950/30 px-3 py-2 text-red-300">
                  {state.error}
                </p>
              )}

              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  name="read_only"
                  defaultChecked={props.readOnly}
                  className="mt-0.5"
                />
                <span className="text-neutral-300">
                  Read-only
                  <span className="block text-neutral-500">
                    Hard override: write scopes stay inert while this is on, no
                    matter which are ticked.
                  </span>
                </span>
              </label>

              <fieldset className="mt-3">
                <legend className="text-neutral-400">Scopes</legend>
                <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                  {SCOPE_OPTIONS.map((o) => (
                    <label
                      key={o.scope}
                      className="flex items-start gap-2 rounded border border-neutral-800 px-2 py-1.5"
                    >
                      <input
                        type="checkbox"
                        name="scopes"
                        value={o.scope}
                        defaultChecked={props.scopes.includes(o.scope)}
                        className="mt-0.5"
                      />
                      <span className="text-neutral-300">
                        <span className="font-mono text-neutral-100">{o.scope}</span>
                        {o.write && (
                          <span className="ml-1 rounded border border-amber-900/50 bg-amber-950/30 px-1 text-[10px] text-amber-300">
                            write
                          </span>
                        )}
                        <span className="block text-neutral-500">{o.label}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="mt-3 flex gap-2">
                <button
                  type="submit"
                  disabled={pending}
                  className="rounded border border-neutral-700 bg-neutral-800 px-4 py-1.5 hover:bg-neutral-700 disabled:opacity-50"
                >
                  {pending ? "Saving…" : "Save rights"}
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="rounded border border-neutral-700 px-4 py-1.5 text-neutral-300 hover:bg-neutral-800"
                >
                  Cancel
                </button>
              </div>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}
