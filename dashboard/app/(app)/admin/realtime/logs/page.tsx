import Link from "next/link";
import { pool } from "@/lib/db";
import { Card } from "../../../_components/Card";
import { clearRealtimeLogs } from "./actions";

const PAGE_SIZE = 100;

type Row = {
  id: string;
  created_at: Date;
  schema: string;
  table: string;
  level: "info" | "warn" | "error";
  event: string;
  subscriber: string | null;
  detail: Record<string, unknown>;
};

type SearchParams = {
  table?: string;
  level?: string;
  event?: string;
  page?: string;
};

type Filters = { table: string; level: string; event: string };

function parseFilters(sp: SearchParams): Filters {
  const level = ["info", "warn", "error"].includes(sp.level ?? "") ? sp.level! : "";
  return {
    table: sp.table?.trim() ?? "",
    level,
    event: sp.event?.trim() ?? "",
  };
}

// Parameterised WHERE — user input is only ever passed as positional params.
function buildWhere(f: Filters): { where: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];

  if (f.table) {
    params.push(`%${f.table.toLowerCase()}%`);
    conds.push(`lower(schema || '.' || "table") LIKE $${params.length}`);
  }
  if (f.level) {
    params.push(f.level);
    conds.push(`level = $${params.length}`);
  }
  if (f.event) {
    params.push(`%${f.event.toLowerCase()}%`);
    conds.push(`lower(event) LIKE $${params.length}`);
  }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  return { where, params };
}

async function loadCount(where: string, params: unknown[]): Promise<number> {
  const { rows } = await pool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM _dashboard.realtime_logs ${where}`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}

async function loadRows(
  where: string,
  params: unknown[],
  limit: number,
  offset: number,
): Promise<Row[]> {
  const { rows } = await pool().query<Row>(
    `SELECT id, created_at, schema, "table", level, event, subscriber, detail
       FROM _dashboard.realtime_logs
       ${where}
       ORDER BY id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  return rows;
}

function formatTime(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().replace("T", " ").slice(0, 19);
}

const LEVEL_STYLE: Record<Row["level"], string> = {
  info: "border-neutral-700 bg-neutral-800/40 text-neutral-300",
  warn: "border-amber-900/60 bg-amber-950/40 text-amber-300",
  error: "border-red-900/60 bg-red-950/40 text-red-300",
};

function pageHref(filters: Filters, page: number): string {
  const sp = new URLSearchParams();
  if (filters.table) sp.set("table", filters.table);
  if (filters.level) sp.set("level", filters.level);
  if (filters.event) sp.set("event", filters.event);
  if (page > 1) sp.set("page", String(page));
  const qs = sp.toString();
  return qs ? `/admin/realtime/logs?${qs}` : "/admin/realtime/logs";
}

export default async function RealtimeLogsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const filters = parseFilters(sp);
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const { where, params } = buildWhere(filters);
  const [total, rows] = await Promise.all([
    loadCount(where, params),
    loadRows(where, params, PAGE_SIZE, offset),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + rows.length, total);

  return (
    <main className="px-6 py-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm text-neutral-500">
            <Link href="/admin/realtime" className="hover:text-neutral-300">
              Realtime
            </Link>
            <span>/</span>
            <span className="text-neutral-300">Logs</span>
          </div>
          <h1 className="mt-1 text-2xl font-semibold">Realtime logs</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Diagnostics for the change stream — authorize errors, per-subscriber
            denials, and connection lifecycle. Authorized mode fails closed and
            drops events silently; this is where the reason surfaces.{" "}
            {total.toLocaleString()} {total === 1 ? "entry" : "entries"} match.
          </p>
        </div>
        <form action={clearRealtimeLogs}>
          <button
            type="submit"
            className="rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800"
          >
            Clear logs
          </button>
        </form>
      </div>

      {/* Filters — plain GET form, re-renders the page server-side. */}
      <Card padded className="mt-6">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-neutral-400">
            Table
            <input
              type="search"
              name="table"
              defaultValue={filters.table}
              placeholder="schema.table"
              className="w-48 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-400">
            Level
            <select
              name="level"
              defaultValue={filters.level}
              className="w-32 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-200 focus:border-neutral-500 focus:outline-none"
            >
              <option value="">All</option>
              <option value="error">error</option>
              <option value="warn">warn</option>
              <option value="info">info</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-400">
            Event
            <input
              type="search"
              name="event"
              defaultValue={filters.event}
              placeholder="authorize_error…"
              className="w-48 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
            />
          </label>
          <button
            type="submit"
            className="rounded border border-neutral-600 bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700"
          >
            Apply
          </button>
          <Link
            href="/admin/realtime/logs"
            className="rounded px-3 py-1.5 text-sm text-neutral-500 hover:text-neutral-300"
          >
            Reset
          </Link>
        </form>
      </Card>

      <Card className="mt-6 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-700 bg-neutral-800/60 text-left text-neutral-400">
              <th className="px-3 py-2 font-normal">When</th>
              <th className="px-3 py-2 font-normal">Level</th>
              <th className="px-3 py-2 font-normal">Table</th>
              <th className="px-3 py-2 font-normal">Event</th>
              <th className="px-3 py-2 font-normal">Subscriber</th>
              <th className="px-3 py-2 font-normal">Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-neutral-500">
                  No log entries.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-neutral-800 last:border-b-0 odd:bg-neutral-900 even:bg-neutral-950/40 hover:bg-neutral-800/50"
                >
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-neutral-400">
                    {formatTime(r.created_at)}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded border px-1.5 py-0.5 text-xs ${LEVEL_STYLE[r.level]}`}
                    >
                      {r.level}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-neutral-300">
                    {r.schema}.{r.table}
                  </td>
                  <td className="px-3 py-2 font-mono text-neutral-200">{r.event}</td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-neutral-500">
                    {r.subscriber ?? "—"}
                  </td>
                  <td className="max-w-md truncate px-3 py-2 font-mono text-xs text-neutral-400">
                    {Object.keys(r.detail).length ? (
                      <span title={JSON.stringify(r.detail)}>
                        {JSON.stringify(r.detail)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>

      <div className="mt-4 flex items-center justify-between text-sm text-neutral-500">
        <span>
          {from}–{to} of {total.toLocaleString()}
        </span>
        <div className="flex items-center gap-2">
          {page > 1 ? (
            <Link
              href={pageHref(filters, page - 1)}
              className="rounded border border-neutral-700 px-3 py-1 text-neutral-300 hover:bg-neutral-800"
            >
              ← Prev
            </Link>
          ) : (
            <span className="rounded border border-neutral-800 px-3 py-1 text-neutral-600">
              ← Prev
            </span>
          )}
          <span className="text-neutral-500">
            Page {page} of {totalPages}
          </span>
          {page < totalPages ? (
            <Link
              href={pageHref(filters, page + 1)}
              className="rounded border border-neutral-700 px-3 py-1 text-neutral-300 hover:bg-neutral-800"
            >
              Next →
            </Link>
          ) : (
            <span className="rounded border border-neutral-800 px-3 py-1 text-neutral-600">
              Next →
            </span>
          )}
        </div>
      </div>
    </main>
  );
}
