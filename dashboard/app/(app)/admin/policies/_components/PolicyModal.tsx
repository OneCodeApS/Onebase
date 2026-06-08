"use client";

import { useRef, useState } from "react";
import { createPolicy, updatePolicy } from "../actions";
import { useBackdropDismiss } from "../../../_components/useBackdropDismiss";

export type PolicyInitial = {
  schema: string;
  table: string;
  name: string;
  permissive: "PERMISSIVE" | "RESTRICTIVE";
  cmd: "ALL" | "SELECT" | "INSERT" | "UPDATE" | "DELETE";
  roles: string[];
  using_expr: string | null;
  check_expr: string | null;
};

// Modal form shared by Create (initial=undefined) and Edit (initial=row).
// Tables param drives the schema.table dropdown options.
export function PolicyModal({
  trigger,
  initial,
  tables, // { schema, table }[] across the available schemas
  roleOptions,
}: {
  trigger: React.ReactNode;
  initial?: PolicyInitial;
  tables: { schema: string; table: string }[];
  roleOptions: string[];
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const editing = !!initial;
  const initialTarget = initial ? `${initial.schema}.${initial.table}` : "";

  // The cmd field disables USING for INSERT and WITH CHECK for SELECT, so we
  // track it in state to render the disabled fields correctly.
  const [cmd, setCmd] = useState<PolicyInitial["cmd"]>(initial?.cmd ?? "ALL");

  const backdrop = useBackdropDismiss(dialogRef);

  const allowUsing = cmd !== "INSERT";
  const allowCheck = cmd !== "SELECT";

  return (
    <>
      <span onClick={() => dialogRef.current?.showModal()}>{trigger}</span>

      <dialog
        ref={dialogRef}
        {...backdrop}
        className="m-auto w-full max-w-2xl rounded-lg border border-neutral-700 bg-neutral-900 p-0 text-neutral-100 shadow-2xl shadow-black/50 backdrop:bg-black/60"
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <div className="text-lg font-semibold">
            {editing ? `Edit policy ${initial!.name}` : "New policy"}
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

        <form
          action={editing ? updatePolicy : createPolicy}
          className="space-y-4 px-5 py-4"
        >
          {editing && initial && (
            <>
              <input type="hidden" name="orig_schema" value={initial.schema} />
              <input type="hidden" name="orig_table" value={initial.table} />
              <input type="hidden" name="orig_name" value={initial.name} />
            </>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs uppercase tracking-wider text-neutral-500">
                Table
              </label>
              <select
                name="__target"
                required
                defaultValue={initialTarget}
                onChange={(e) => {
                  const [s, t] = e.target.value.split(".");
                  (e.target.form?.elements.namedItem("schema") as HTMLInputElement).value = s ?? "";
                  (e.target.form?.elements.namedItem("table") as HTMLInputElement).value = t ?? "";
                }}
                className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-sm"
              >
                <option value="" disabled>
                  — pick a table —
                </option>
                {tables.map((t) => (
                  <option key={`${t.schema}.${t.table}`} value={`${t.schema}.${t.table}`}>
                    {t.schema}.{t.table}
                  </option>
                ))}
              </select>
              <input
                type="hidden"
                name="schema"
                defaultValue={initial?.schema ?? ""}
              />
              <input
                type="hidden"
                name="table"
                defaultValue={initial?.table ?? ""}
              />
            </div>

            <div>
              <label className="block text-xs uppercase tracking-wider text-neutral-500">
                Policy name
              </label>
              <input
                type="text"
                name="name"
                required
                defaultValue={initial?.name ?? ""}
                pattern="[a-zA-Z_][a-zA-Z0-9_$]{0,62}"
                placeholder="todos_anon_select"
                className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs uppercase tracking-wider text-neutral-500">
                Applies to (command)
              </label>
              <select
                name="cmd"
                required
                value={cmd}
                onChange={(e) => setCmd(e.target.value as PolicyInitial["cmd"])}
                className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-sm"
              >
                {(["ALL", "SELECT", "INSERT", "UPDATE", "DELETE"] as const).map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wider text-neutral-500">
                Kind
              </label>
              <select
                name="permissive"
                required
                defaultValue={initial?.permissive ?? "PERMISSIVE"}
                className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-sm"
              >
                <option value="PERMISSIVE">PERMISSIVE (default)</option>
                <option value="RESTRICTIVE">RESTRICTIVE</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wider text-neutral-500">
              Roles
            </label>
            <input
              type="text"
              name="roles"
              defaultValue={initial?.roles?.join(", ") ?? "public"}
              placeholder="public, anon, authenticated"
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-sm"
            />
            <p className="mt-1 text-xs text-neutral-500">
              Comma-separated. Known roles: {roleOptions.join(", ")}. Use{" "}
              <span className="font-mono">public</span> for everyone.
            </p>
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wider text-neutral-500">
              USING expression (row filter for {cmd === "INSERT" ? "—" : "reads / updates / deletes"})
            </label>
            <textarea
              name="using_expr"
              rows={2}
              disabled={!allowUsing}
              defaultValue={initial?.using_expr ?? ""}
              placeholder={allowUsing ? "auth.uid() = user_id" : "(not used for INSERT)"}
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-xs disabled:opacity-40"
            />
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wider text-neutral-500">
              WITH CHECK expression (row filter for {cmd === "SELECT" ? "—" : "inserts / updates"})
            </label>
            <textarea
              name="check_expr"
              rows={2}
              disabled={!allowCheck}
              defaultValue={initial?.check_expr ?? ""}
              placeholder={allowCheck ? "auth.uid() = user_id" : "(not used for SELECT)"}
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-xs disabled:opacity-40"
            />
            <p className="mt-1 text-xs text-neutral-500">
              When omitted, Postgres uses USING for WITH CHECK on UPDATE/INSERT.
            </p>
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
              {editing ? "Save" : "Create"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
