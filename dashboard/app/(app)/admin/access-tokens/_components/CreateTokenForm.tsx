"use client";

import { useActionState, useState } from "react";
import { createAccessToken, type CreateTokenResult } from "../actions";
import { KeyDisplay } from "../../api-keys/_components/KeyDisplay";

type ScopeOption = {
  scope: string;
  label: string;
  write: boolean;
};

// Order mirrors lib/access-tokens.ts SCOPES; labels explain the blast radius.
const SCOPE_OPTIONS: ScopeOption[] = [
  { scope: "db:read", label: "Database — read (SELECT, introspection, types, advisors)", write: false },
  { scope: "db:write", label: "Database — write (DML via restricted role, no DDL)", write: true },
  { scope: "db:ddl", label: "Database — DDL (apply_migration, schema changes)", write: true },
  { scope: "functions:read", label: "Edge functions — read (config + code)", write: false },
  { scope: "functions:write", label: "Edge functions — deploy (code runs with full DB access)", write: true },
  { scope: "functions:invoke", label: "Edge functions — invoke (test calls)", write: true },
  { scope: "storage:read", label: "Storage — read (buckets + policies)", write: false },
  { scope: "storage:write", label: "Storage — write (bucket policies)", write: true },
  { scope: "cron:read", label: "Cron — read", write: false },
  { scope: "cron:write", label: "Cron — create/update jobs", write: true },
  { scope: "logs:read", label: "Logs — audit log + chain verification", write: false },
];

export function CreateTokenForm() {
  const [state, formAction, pending] = useActionState<CreateTokenResult, FormData>(
    createAccessToken,
    null,
  );
  const [readOnly, setReadOnly] = useState(true);

  if (state?.ok) {
    return (
      <div>
        <p className="text-sm text-neutral-300">
          Token <span className="font-mono text-neutral-100">{state.name}</span> created.{" "}
          <strong className="text-amber-300">
            Copy it now — it is shown only once and cannot be recovered.
          </strong>
        </p>
        <KeyDisplay value={state.token} sensitive />
        <p className="mt-3 text-xs text-neutral-500">
          Reload the page to create another token.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction}>
      {state && !state.ok && (
        <p className="mb-3 rounded border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">
          {state.error}
        </p>
      )}

      <div className="flex flex-wrap gap-4">
        <label className="block">
          <span className="text-xs text-neutral-400">Name</span>
          <input
            name="name"
            required
            maxLength={64}
            placeholder="e.g. claude-code (mathias)"
            className="mt-1 block w-64 rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-600"
          />
        </label>
        <label className="block">
          <span className="text-xs text-neutral-400">Expires</span>
          <select
            name="expires_in_days"
            defaultValue="90"
            className="mt-1 block rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100"
          >
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="365">365 days</option>
          </select>
        </label>
      </div>

      <label className="mt-4 flex items-start gap-2">
        <input
          type="checkbox"
          name="read_only"
          checked={readOnly}
          onChange={(e) => setReadOnly(e.target.checked)}
          className="mt-0.5"
        />
        <span className="text-sm text-neutral-300">
          Read-only
          <span className="block text-xs text-neutral-500">
            Hard override: write scopes are inert while this is on. Untick only
            when the agent genuinely needs to change things.
          </span>
        </span>
      </label>

      <fieldset className="mt-4">
        <legend className="text-xs text-neutral-400">Scopes</legend>
        <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {SCOPE_OPTIONS.map((o) => {
            const disabled = readOnly && o.write;
            return (
              <label
                key={o.scope}
                className={`flex items-start gap-2 rounded border border-neutral-800 px-2 py-1.5 ${
                  disabled ? "opacity-40" : ""
                }`}
              >
                <input
                  type="checkbox"
                  name="scopes"
                  value={o.scope}
                  disabled={disabled}
                  defaultChecked={o.scope === "db:read"}
                  className="mt-0.5"
                />
                <span className="text-xs text-neutral-300">
                  <span className="font-mono text-neutral-100">{o.scope}</span>
                  {o.write && (
                    <span className="ml-1 rounded border border-amber-900/50 bg-amber-950/30 px-1 text-[10px] text-amber-300">
                      write
                    </span>
                  )}
                  <span className="block text-neutral-500">{o.label}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <button
        type="submit"
        disabled={pending}
        className="mt-4 rounded border border-neutral-700 bg-neutral-800 px-4 py-1.5 text-sm hover:bg-neutral-700 disabled:opacity-50"
      >
        {pending ? "Creating…" : "Create token"}
      </button>
    </form>
  );
}
