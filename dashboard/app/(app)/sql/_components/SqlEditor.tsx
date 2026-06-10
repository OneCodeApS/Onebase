"use client";

import { useActionState, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { sql, PostgreSQL } from "@codemirror/lang-sql";
import { keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { runQuery, type QueryResult, type Success } from "../actions";
import type { UserRole } from "@/lib/session";
import { Card } from "../../_components/Card";

type Snippet = {
  label: string;
  description?: string;
  // True if this snippet is read-only safe (visible to read_only role).
  readOnly: boolean;
  sql: string;
};

type SnippetGroup = {
  heading: string;
  snippets: Snippet[];
};

// Snippets the user can click to load into the editor. The DDL / RLS entries
// are best-practice templates for this stack — swap public.example for your
// own table; the read-only inspection queries run as-is.
const SNIPPETS: SnippetGroup[] = [
  {
    heading: "Inspect",
    snippets: [
      {
        label: "List tables",
        description: "All base tables, excluding system schemas",
        readOnly: true,
        sql:
          "SELECT table_schema, table_name\n" +
          "FROM information_schema.tables\n" +
          "WHERE table_schema NOT IN ('pg_catalog', 'information_schema')\n" +
          "  AND table_type = 'BASE TABLE'\n" +
          "ORDER BY table_schema, table_name;",
      },
      {
        label: "Columns for a table",
        readOnly: true,
        sql:
          "SELECT column_name, data_type, is_nullable, column_default\n" +
          "FROM information_schema.columns\n" +
          "WHERE table_schema = 'public' AND table_name = 'todos'\n" +
          "ORDER BY ordinal_position;",
      },
      {
        label: "Database size",
        readOnly: true,
        sql:
          "SELECT pg_size_pretty(pg_database_size(current_database())) AS size;",
      },
      {
        label: "Largest tables",
        readOnly: true,
        sql:
          "SELECT schemaname, tablename,\n" +
          "       pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size\n" +
          "FROM pg_tables\n" +
          "WHERE schemaname NOT IN ('pg_catalog','information_schema')\n" +
          "ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC\n" +
          "LIMIT 10;",
      },
    ],
  },
  {
    heading: "Create table",
    snippets: [
      {
        label: "Table with RLS (recommended)",
        description: "uuidv7 key, timestamps, RLS on, API grants",
        readOnly: false,
        sql: `-- Recommended new-table pattern. uuidv7() is a time-ordered,
-- unguessable primary key (Postgres 18+).
CREATE TABLE public.example (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  title      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Tables in the public schema are exposed by PostgREST. Enable RLS so rows
-- stay locked down until a policy grants access.
ALTER TABLE public.example ENABLE ROW LEVEL SECURITY;

-- PostgREST connects as anon (no token) or authenticated (valid JWT). Grant
-- the privileges the API role needs, then scope the rows with policies.
GRANT SELECT ON public.example TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.example TO authenticated;`,
      },
      {
        label: "Keep updated_at current",
        description: "Trigger that bumps updated_at on every UPDATE",
        readOnly: false,
        sql: `CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER example_set_updated_at
  BEFORE UPDATE ON public.example
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();`,
      },
      {
        label: "Foreign key + index",
        description: "Reference another table and index the key",
        readOnly: false,
        sql: `-- ON DELETE CASCADE removes children when the parent is deleted.
ALTER TABLE public.example
  ADD COLUMN owner_id uuid NOT NULL
    REFERENCES auth.users (id) ON DELETE CASCADE;

-- Always index a foreign key you filter or join on.
CREATE INDEX example_owner_id_idx ON public.example (owner_id);`,
      },
    ],
  },
  {
    heading: "Row-level security",
    snippets: [
      {
        label: "Enable RLS",
        readOnly: false,
        sql: "ALTER TABLE public.example ENABLE ROW LEVEL SECURITY;",
      },
      {
        label: "Policy: public read",
        description: "Anyone, even anonymous, can read every row",
        readOnly: false,
        sql: `CREATE POLICY example_select_public
  ON public.example
  FOR SELECT
  TO anon, authenticated
  USING (true);`,
      },
      {
        label: "Policy: authenticated insert",
        description: "Only signed-in callers can insert",
        readOnly: false,
        sql: `CREATE POLICY example_insert_authenticated
  ON public.example
  FOR INSERT
  TO authenticated
  WITH CHECK (true);`,
      },
      {
        label: "Policy: owner-only access",
        description: "Each user reads/writes only their own rows (JWT sub)",
        readOnly: false,
        sql: `-- The JWT subject (sub) is the user id; PostgREST exposes the
-- token's claims through the request.jwt.claims setting.
CREATE POLICY example_owner_all
  ON public.example
  FOR ALL
  TO authenticated
  USING      (owner_id = (current_setting('request.jwt.claims', true)::json ->> 'sub')::uuid)
  WITH CHECK (owner_id = (current_setting('request.jwt.claims', true)::json ->> 'sub')::uuid);`,
      },
    ],
  },
  {
    heading: "Indexes & plans",
    snippets: [
      {
        label: "Create index",
        readOnly: false,
        sql: "CREATE INDEX example_created_at_idx ON public.example (created_at);",
      },
      {
        label: "Unique constraint",
        readOnly: false,
        sql: `ALTER TABLE public.example
  ADD CONSTRAINT example_title_unique UNIQUE (title);`,
      },
      {
        label: "Check a query plan",
        description: "EXPLAIN shows index usage without running the query",
        readOnly: true,
        sql: `EXPLAIN
SELECT * FROM public.example
WHERE created_at > now() - interval '7 days';`,
      },
    ],
  },
  {
    heading: "System",
    snippets: [
      {
        label: "Postgres version",
        readOnly: true,
        sql: "SELECT version();",
      },
      {
        label: "Current user / role",
        readOnly: true,
        sql: "SELECT current_user, current_role, session_user;",
      },
      {
        label: "Active connections",
        readOnly: true,
        sql:
          "SELECT pid, usename, application_name, state, query_start\n" +
          "FROM pg_stat_activity\n" +
          "WHERE state IS NOT NULL\n" +
          "ORDER BY query_start DESC NULLS LAST;",
      },
    ],
  },
  {
    heading: "Audit",
    snippets: [
      {
        label: "Recent audit entries",
        readOnly: true,
        sql:
          "SELECT created_at, actor, role, action, target, success\n" +
          "FROM _dashboard.audit_log\n" +
          "ORDER BY id DESC\n" +
          "LIMIT 50;",
      },
      {
        label: "Audit by action type",
        readOnly: true,
        sql:
          "SELECT action, count(*) AS n\n" +
          "FROM _dashboard.audit_log\n" +
          "GROUP BY action\n" +
          "ORDER BY n DESC;",
      },
    ],
  },
];

function renderCell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// Serialize a single value for export. Unlike renderCell, NULL becomes an empty
// field (not the display em-dash) and Dates become ISO strings so the output
// round-trips as real data.
function exportValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// RFC-4180-style CSV: quote any field containing a comma, quote, CR or LF, and
// double up embedded quotes. CRLF row terminators for spreadsheet compatibility.
function toCsv(fields: string[], rows: Record<string, unknown>[]): string {
  const esc = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const header = fields.map(esc).join(",");
  const body = rows.map((r) => fields.map((f) => esc(exportValue(r[f]))).join(",")).join("\r\n");
  return body ? `${header}\r\n${body}` : header;
}

function CopyIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

// Copy CSV / copy JSON / download CSV, aligned to the right of the result
// header. The copy buttons flash a green "Copied" state for ~1.5s after a
// successful clipboard write.
function ResultActions({ result }: { result: Success }) {
  const [copied, setCopied] = useState<"csv" | "json" | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (result.fields.length === 0 || result.rows.length === 0) return null;

  const copy = async (kind: "csv" | "json") => {
    const text =
      kind === "csv"
        ? toCsv(result.fields, result.rows)
        : JSON.stringify(result.rows, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(null), 1500);
    } catch {
      // Clipboard can be unavailable (insecure context / denied permission);
      // fail silently rather than throwing in an event handler.
    }
  };

  const downloadCsv = () => {
    const blob = new Blob([toCsv(result.fields, result.rows)], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "query-result.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const copyBtn = (kind: "csv" | "json", label: string) => {
    const active = copied === kind;
    return (
      <button
        type="button"
        onClick={() => copy(kind)}
        title={`Copy result as ${label}`}
        aria-label={`Copy result as ${label}`}
        className={
          "inline-flex items-center gap-1 rounded border px-2 py-1 transition-colors " +
          (active
            ? "border-emerald-700 bg-emerald-950/40 text-emerald-300"
            : "border-neutral-700 bg-neutral-900 text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100")
        }
      >
        {active ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
        <span className="font-medium">{active ? "Copied" : label}</span>
      </button>
    );
  };

  return (
    <div className="ml-auto flex items-center gap-1.5">
      {copyBtn("csv", "CSV")}
      {copyBtn("json", "JSON")}
      <button
        type="button"
        onClick={downloadCsv}
        title="Export result as a CSV file"
        aria-label="Export result as a CSV file"
        className="inline-flex items-center gap-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
      >
        <DownloadIcon className="h-3.5 w-3.5" />
        <span className="font-medium">Export</span>
      </button>
    </div>
  );
}

function Result({ result }: { result: QueryResult }) {
  if (!result.ok) {
    return (
      <div className="mt-4 rounded border border-red-900/50 bg-red-950/30 px-3 py-2">
        <div className="text-sm font-medium text-red-300">Query failed</div>
        <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-red-200">
          {result.error}
        </pre>
        {result.code && (
          <div className="mt-1 text-xs text-red-400">
            Postgres error code: {result.code}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-400">
        <span className="rounded border border-neutral-700 px-2 py-0.5 font-mono text-neutral-200">
          {result.command ?? "OK"}
        </span>
        {result.rowCount !== null && (
          <span>
            {result.rowCount.toLocaleString()} {result.rowCount === 1 ? "row" : "rows"}
          </span>
        )}
        <span>{result.durationMs} ms</span>
        {result.truncated && (
          <span className="text-amber-400">
            Showing first {result.rows.length} rows
          </span>
        )}
        <ResultActions result={result} />
      </div>

      {result.fields.length > 0 && result.rows.length > 0 ? (
        <Card className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-700 bg-neutral-800/60 text-left text-neutral-400">
                {result.fields.map((f) => (
                  <th key={f} className="px-3 py-2 font-mono font-normal text-neutral-100">
                    {f}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr
                  key={i}
                  className="border-b border-neutral-800 last:border-b-0 odd:bg-neutral-900 even:bg-neutral-950/40 hover:bg-neutral-800/50"
                >
                  {result.fields.map((f) => {
                    const text = renderCell(row[f]);
                    return (
                      <td
                        key={f}
                        className="max-w-xs truncate px-3 py-2 font-mono text-neutral-300"
                        title={text}
                      >
                        {text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <p className="mt-3 text-sm text-neutral-500">
          {result.rowCount === null
            ? "No result set."
            : `Affected ${result.rowCount} row${result.rowCount === 1 ? "" : "s"}.`}
        </p>
      )}
    </div>
  );
}

function Snippets({
  readOnly,
  onPick,
}: {
  readOnly: boolean;
  onPick: (sql: string) => void;
}) {
  return (
    <aside className="w-60 shrink-0 border-r border-neutral-800 pr-4">
      <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
        Snippets
      </h2>
      <div className="mt-2 space-y-4">
        {SNIPPETS.map((group) => {
          const visible = group.snippets.filter((s) => !readOnly || s.readOnly);
          if (visible.length === 0) return null;
          return (
            <div key={group.heading}>
              <div className="text-xs font-medium text-neutral-400">{group.heading}</div>
              <div className="mt-1 space-y-0.5">
                {visible.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => onPick(s.sql)}
                    title={s.description ?? s.label}
                    className="block w-full truncate rounded px-2 py-1 text-left text-sm text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

export function SqlEditor({ role }: { role: UserRole }) {
  const [result, formAction, isPending] = useActionState<QueryResult | null, FormData>(
    runQuery,
    null,
  );
  const formRef = useRef<HTMLFormElement | null>(null);
  // Controlled state so React 19 doesn't reset the editor after the server
  // action completes — the user wants to see / edit / re-run their last query.
  const [sqlText, setSqlText] = useState("");

  // Ctrl/Cmd+Enter submits the form from inside CodeMirror.
  const submitKeymap = Prec.highest(
    keymap.of([
      {
        key: "Mod-Enter",
        run: () => {
          formRef.current?.requestSubmit();
          return true;
        },
      },
    ]),
  );

  const readOnly = role === "read_only";

  return (
    <div className="flex gap-4">
      <Snippets readOnly={readOnly} onPick={setSqlText} />

      <form ref={formRef} action={formAction} className="flex-1 min-w-0">
        {/* CodeMirror isn't a native form input, so we mirror its value into a
            hidden input so the server action's FormData picks it up. */}
        <input type="hidden" name="sql" value={sqlText} />
        <div className="overflow-hidden rounded border border-neutral-700">
          {/* Tall while composing; shrinks once a result is showing so the
              output has room below. */}
          <CodeMirror
            value={sqlText}
            onChange={setSqlText}
            theme="dark"
            extensions={[sql({ dialect: PostgreSQL, upperCaseKeywords: true }), submitKeymap]}
            basicSetup={{
              lineNumbers: true,
              foldGutter: false,
              highlightActiveLine: true,
              highlightActiveLineGutter: true,
              autocompletion: false,
            }}
            placeholder={
              readOnly
                ? "SELECT * FROM public.todos;\n\n(Ctrl+Enter to run — read-only users can run SELECT only)"
                : "SELECT * FROM public.todos;\n\n(Ctrl+Enter to run)"
            }
            height={result ? "260px" : "60vh"}
          />
        </div>
        <div className="mt-2 flex items-center justify-between">
          <div className="text-xs text-neutral-500">
            {readOnly
              ? "You can run SELECT / WITH / EXPLAIN / SHOW."
              : "Statements run as dashboard_admin."}
          </div>
          <button
            type="submit"
            disabled={isPending}
            className="rounded border border-neutral-700 bg-neutral-800 px-4 py-1.5 text-sm font-medium hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending ? "Running…" : "Run"}
          </button>
        </div>

        {result && <Result result={result} />}
      </form>
    </div>
  );
}
