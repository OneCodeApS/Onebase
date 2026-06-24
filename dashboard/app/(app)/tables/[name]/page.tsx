import Link from "next/link";
import { notFound } from "next/navigation";
import { pool } from "@/lib/db";
import { Card } from "../../_components/Card";
import { RefreshButton } from "../../_components/RefreshButton";
import {
  SchemaPanel,
  type SchemaColumn,
  type SchemaConstraint,
  type SchemaIndex,
} from "../_components/SchemaPanel";
import { RowFilter } from "../_components/RowFilter";
import { AddColumnDrawer } from "../_components/AddColumnDrawer";
import { getSession } from "@/lib/session";

const PAGE_SIZE = 50;

// Identifiers in Postgres can be letters/digits/underscore (and dollar sign,
// but we don't allow those). Validating here is belt-and-suspenders — we also
// confirm the table exists in information_schema before interpolating its name
// into the data query. Same rules apply to schema names.
const SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const DEFAULT_SCHEMA = "public";

type Column = {
  column_name: string;
  data_type: string;
};

async function loadColumns(schema: string, table: string): Promise<Column[]> {
  const { rows } = await pool().query<Column>(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position`,
    [schema, table],
  );
  return rows;
}

async function loadRowCount(schema: string, table: string): Promise<number> {
  const { rows } = await pool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM "${schema}"."${table}"`,
  );
  return Number(rows[0]?.n ?? 0);
}

// relkind ('r' table / 'v' view / 'm' materialized view), the RLS flag, and the
// planner's row estimate in one read. RLS only ever applies to ordinary tables;
// views inherit access from their underlying tables, so relrowsecurity is
// meaningless for them. reltuples is the cheap estimate ANALYZE/VACUUM keeps on
// pg_class — used to avoid an exact count(*) scan on large tables (see below).
async function loadRelInfo(
  schema: string,
  table: string,
): Promise<{ relkind: string; rls: boolean; reltuples: number }> {
  const { rows } = await pool().query<{ relkind: string; rls: boolean; reltuples: string }>(
    `SELECT c.relkind::text          AS relkind,
            c.relrowsecurity         AS rls,
            c.reltuples::bigint::text AS reltuples
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, table],
  );
  return {
    relkind: rows[0]?.relkind ?? "r",
    rls: rows[0]?.rls ?? false,
    // -1 means "never analyzed" — treat as unknown so we fall back to an exact count.
    reltuples: Number(rows[0]?.reltuples ?? -1),
  };
}

// The single-column primary key, or null when the table has no PK or a
// composite one. Keyset pagination needs one unique, ordered column to seek on;
// anything else falls back to OFFSET paging.
async function loadPrimaryKeyColumn(schema: string, table: string): Promise<string | null> {
  const { rows } = await pool().query<{ attname: string }>(
    `SELECT a.attname AS attname
       FROM pg_index i
       JOIN pg_class c       ON c.oid = i.indrelid
       JOIN pg_namespace n   ON n.oid = c.relnamespace
       JOIN pg_attribute a   ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
      WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary`,
    [schema, table],
  );
  // Exactly one row = single-column PK. Zero = no PK, >1 = composite.
  if (rows.length !== 1) return null;
  const col = rows[0].attname;
  // Belt-and-suspenders before we interpolate the name into a query.
  return SAFE_IDENT.test(col) ? col : null;
}

const KIND_LABEL: Record<string, string> = {
  v: "View",
  m: "Materialized view",
};

async function loadRows(
  schema: string,
  table: string,
  limit: number,
  offset: number,
): Promise<Record<string, unknown>[]> {
  const { rows } = await pool().query<Record<string, unknown>>(
    `SELECT * FROM "${schema}"."${table}" ORDER BY 1 LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows;
}

// Single-column row filter from the Data-tab UI. `col` is always validated
// against the table's real columns (and SAFE_IDENT) before it gets here.
type RowFilterSpec = { col: string; op: "contains" | "eq"; val: string };

// Appends the filter predicate to `params` and returns its SQL fragment (or ""
// when there's no filter). The value is always a bound parameter — only the
// (validated) column name is interpolated. Comparing against `::text` keeps one
// code path for every column type; it forgoes the column's index, which is fine
// for an ad-hoc admin filter.
function filterClause(filter: RowFilterSpec | null, params: unknown[]): string {
  if (!filter) return "";
  if (filter.op === "contains") {
    params.push(`%${filter.val}%`);
    return `"${filter.col}"::text ILIKE $${params.length}`;
  }
  params.push(filter.val);
  return `"${filter.col}"::text = $${params.length}`;
}

// Keyset (cursor) pagination — seeks directly to `pk > cursor` instead of
// walking OFFSET rows, so it stays fast at any depth on large tables. Always
// fetches limit+1 rows so the caller can tell whether another page exists in
// that direction. Returns rows in ascending PK order regardless of direction.
// An optional single-column filter rides along as an extra WHERE predicate.
type KeysetDir = "first" | "next" | "prev";

async function loadRowsKeyset(
  schema: string,
  table: string,
  pk: string,
  dir: KeysetDir,
  cursor: string | null,
  limit: number,
  filter: RowFilterSpec | null,
): Promise<Record<string, unknown>[]> {
  const probe = limit + 1;
  const params: unknown[] = [];
  const conds: string[] = [];
  const fc = filterClause(filter, params);
  if (fc) conds.push(fc);

  if (dir === "prev" && cursor !== null) {
    conds.push(`"${pk}" < $${params.push(cursor)}`);
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const lim = `$${params.push(probe)}`;
    // Walk backwards (DESC) from the cursor, then flip to ASC for display.
    const { rows } = await pool().query<Record<string, unknown>>(
      `SELECT * FROM (
         SELECT * FROM "${schema}"."${table}" ${where} ORDER BY "${pk}" DESC LIMIT ${lim}
       ) s ORDER BY "${pk}" ASC`,
      params,
    );
    return rows;
  }
  if (dir === "next" && cursor !== null) {
    conds.push(`"${pk}" > $${params.push(cursor)}`);
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const lim = `$${params.push(probe)}`;
    const { rows } = await pool().query<Record<string, unknown>>(
      `SELECT * FROM "${schema}"."${table}" ${where} ORDER BY "${pk}" ASC LIMIT ${lim}`,
      params,
    );
    return rows;
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const lim = `$${params.push(probe)}`;
  const { rows } = await pool().query<Record<string, unknown>>(
    `SELECT * FROM "${schema}"."${table}" ${where} ORDER BY "${pk}" ASC LIMIT ${lim}`,
    params,
  );
  return rows;
}

// The cursor is the PK value of an edge row, carried in the URL. Stringify so
// it round-trips through the query string; Postgres re-parses it against the
// PK's real type on the next request.
function cursorValue(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

// Threshold above which we trust pg_class.reltuples instead of paying for an
// exact count(*). Below it, count(*) is sub-millisecond, so we keep it exact.
const COUNT_EXACT_MAX = 50_000;

// --- Schema introspection (for the Schema panel at the bottom) --------------
// All three read pg_catalog with bound params (no identifier interpolation)
// and lean on the pg_get_* helpers so the output matches what psql \d shows.

async function loadSchemaColumns(schema: string, table: string): Promise<SchemaColumn[]> {
  const { rows } = await pool().query<SchemaColumn>(
    `SELECT a.attname                              AS name,
            format_type(a.atttypid, a.atttypmod)   AS type,
            a.attnotnull                           AS not_null,
            pg_get_expr(ad.adbin, ad.adrelid)      AS default_expr,
            EXISTS (
              SELECT 1 FROM pg_constraint con
               WHERE con.conrelid = c.oid AND con.contype = 'p'
                 AND a.attnum = ANY (con.conkey)
            )                                      AS is_primary_key
       FROM pg_attribute a
       JOIN pg_class c     ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      WHERE n.nspname = $1 AND c.relname = $2
        AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [schema, table],
  );
  return rows;
}

async function loadIndexes(schema: string, table: string): Promise<SchemaIndex[]> {
  const { rows } = await pool().query<SchemaIndex>(
    `SELECT i.relname                       AS name,
            pg_get_indexdef(ix.indexrelid)  AS definition,
            ix.indisunique                  AS is_unique,
            ix.indisprimary                 AS is_primary
       FROM pg_index ix
       JOIN pg_class i     ON i.oid = ix.indexrelid
       JOIN pg_class t     ON t.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = $2
      ORDER BY ix.indisprimary DESC, i.relname`,
    [schema, table],
  );
  return rows;
}

async function loadConstraints(schema: string, table: string): Promise<SchemaConstraint[]> {
  const { rows } = await pool().query<SchemaConstraint>(
    `SELECT con.conname AS name,
            CASE con.contype
              WHEN 'p' THEN 'primary key'
              WHEN 'f' THEN 'foreign key'
              WHEN 'u' THEN 'unique'
              WHEN 'c' THEN 'check'
              WHEN 'x' THEN 'exclude'
              ELSE con.contype::text
            END                            AS type,
            pg_get_constraintdef(con.oid)  AS definition
       FROM pg_constraint con
       JOIN pg_class c     ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2
      ORDER BY con.contype, con.conname`,
    [schema, table],
  );
  return rows;
}

function renderCell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// Tables under SYSTEM_SCHEMAS have invariants the row viewer can't safely
// preserve (audit hash chain, AES-GCM ciphertext, Argon2id password hashes,
// scheduler re-registration). The viewer marks them read-only and points at
// the hand-built admin page when there is one. SQL editor is still the
// unrestricted escape hatch.
const SYSTEM_SCHEMAS = new Set(["_dashboard", "auth"]);

// Schema-qualified table → admin page that knows how to mutate it safely.
// Missing entries fall back to a generic "managed by the admin UI" hint.
const ADMIN_PAGE: Record<string, { href: string; label: string }> = {
  "_dashboard.users": { href: "/admin/users", label: "Dashboard users" },
  "_dashboard.audit_log": { href: "/admin/audit", label: "Audit log" },
  "_dashboard.functions": { href: "/admin/functions", label: "Edge functions" },
  "_dashboard.function_env": { href: "/admin/functions/env", label: "Function env vars" },
  "_dashboard.cron_jobs": { href: "/admin/cron", label: "Cron jobs" },
  "_dashboard.settings": { href: "/admin/settings", label: "Settings" },
  "_dashboard.bucket_policies": { href: "/storage", label: "Storage buckets" },
  "auth.users": { href: "/admin/end-users", label: "End users" },
  "auth.providers": { href: "/admin/auth-providers", label: "Auth providers" },
};

// Columns containing secrets or other values we never want to render plainly
// in the table browser. Browsing a table that contains one of these will show
// a masked placeholder instead. Defense in depth — admins can still query the
// underlying values via the SQL editor if they really need to.
const SENSITIVE_COLUMNS = new Set<string>([
  // Even though value_encrypted is ciphertext, masking it keeps the table
  // browser from giving away ciphertext length / structure for free.
  "_dashboard.function_env.value",
  "_dashboard.function_env.value_encrypted",
  "_dashboard.users.password_hash",
  "auth.users.encrypted_password",
  "auth.sessions.refresh_token_hash",
]);

function isSensitive(schema: string, table: string, column: string): boolean {
  return SENSITIVE_COLUMNS.has(`${schema}.${table}.${column}`);
}

function maskedDisplay(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  const len = typeof v === "string" ? v.length : String(v).length;
  return `•••••• (${len} chars)`;
}

// Carries the `?schema=` param through pagination links so Next/Prev don't
// drop the user back into the default schema.
function pageHref(name: string, schema: string, page: number): string {
  const params = new URLSearchParams();
  if (schema !== DEFAULT_SCHEMA) params.set("schema", schema);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs
    ? `/tables/${encodeURIComponent(name)}?${qs}`
    : `/tables/${encodeURIComponent(name)}`;
}

// Keyset equivalent of pageHref: carries a single `after` or `before` cursor
// (the PK of the page edge) instead of a page number, plus the active filter so
// Prev/Next stay within the filtered set.
function cursorHref(
  name: string,
  schema: string,
  cur: { after?: string; before?: string },
  filter: RowFilterSpec | null,
): string {
  const params = new URLSearchParams();
  if (schema !== DEFAULT_SCHEMA) params.set("schema", schema);
  if (cur.after) params.set("after", cur.after);
  else if (cur.before) params.set("before", cur.before);
  if (filter) {
    params.set("fcol", filter.col);
    params.set("fop", filter.op);
    params.set("fval", filter.val);
  }
  const qs = params.toString();
  return qs
    ? `/tables/${encodeURIComponent(name)}?${qs}`
    : `/tables/${encodeURIComponent(name)}`;
}

// Link for the top-level Data/Schema tabs. Preserves the active schema, drops
// paging (the Schema tab has no pages), and omits the default `view=data`.
function tabHref(name: string, schema: string, view: "data" | "schema"): string {
  const params = new URLSearchParams();
  if (schema !== DEFAULT_SCHEMA) params.set("schema", schema);
  if (view === "schema") params.set("view", "schema");
  const qs = params.toString();
  return qs
    ? `/tables/${encodeURIComponent(name)}?${qs}`
    : `/tables/${encodeURIComponent(name)}`;
}

export default async function TableRowsPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{
    page?: string;
    schema?: string;
    view?: string;
    after?: string;
    before?: string;
    fcol?: string;
    fop?: string;
    fval?: string;
    ok?: string;
    error?: string;
  }>;
}) {
  const { name: rawName } = await params;
  const sp = await searchParams;
  const name = decodeURIComponent(rawName);
  const schema = (sp.schema ?? DEFAULT_SCHEMA).trim();

  if (!SAFE_IDENT.test(name)) notFound();
  if (!SAFE_IDENT.test(schema)) notFound();

  // read_only users have no access to system schemas, even via direct URL.
  // 404 (not 403) so the existence of the table isn't advertised.
  const session = await getSession();
  if (session.role === "read_only" && SYSTEM_SCHEMAS.has(schema)) {
    notFound();
  }

  const columns = await loadColumns(schema, name);
  if (columns.length === 0) notFound();

  const view = sp.view === "schema" ? "schema" : "data";

  // Single-column filter from the Data-tab UI. Only honoured when the column is
  // a real column of this table (and SAFE_IDENT) and a value was supplied — so a
  // hand-crafted ?fcol can't inject anything; it just gets ignored.
  const colNames = new Set(columns.map((c) => c.column_name));
  const fcol = (sp.fcol ?? "").trim();
  const fval = sp.fval ?? "";
  const filter: RowFilterSpec | null =
    fcol && fval !== "" && SAFE_IDENT.test(fcol) && colNames.has(fcol)
      ? { col: fcol, op: sp.fop === "eq" ? "eq" : "contains", val: fval }
      : null;

  const isSystemSchema = SYSTEM_SCHEMAS.has(schema);
  const adminPage = ADMIN_PAGE[`${schema}.${name}`];
  // relkind / RLS / row-estimate in one read. Tables are created without RLS by
  // design; for non-system (API-exposed) schemas we surface a warning so an
  // exposed table isn't left wide open by accident — we don't force RLS on.
  // Views have no RLS of their own, so we skip both the query and the warning.
  const { relkind, rls, reltuples } = await loadRelInfo(schema, name);
  const isView = relkind === "v" || relkind === "m";
  const kindLabel = KIND_LABEL[relkind];
  const rlsEnabled = isSystemSchema || isView ? true : rls;

  // Estimated count on large tables, exact on small ones. An exact count(*)
  // scans the whole relation — sub-millisecond at thousands of rows, a
  // multi-second stall at millions. That stall (plus deep OFFSET) is what made
  // pagination hang on large prod tables, so above COUNT_EXACT_MAX we trust the
  // planner's estimate instead.
  const useEstimate = reltuples >= 0 && reltuples > COUNT_EXACT_MAX;
  const total = useEstimate ? reltuples : await loadRowCount(schema, name);

  // Keyset paging needs a single-column PK on a real table (not a view). Views
  // and PK-less / composite-PK tables fall back to OFFSET paging below.
  const pkCol = isView ? null : await loadPrimaryKeyColumn(schema, name);

  // The Data-tab "+" column (Add column) — admins only, real tables, never
  // system schemas. addColumn re-checks all of this server-side regardless.
  const canAddColumn = session.role === "admin" && !isSystemSchema && !isView;

  let rows: Record<string, unknown>[] = [];
  let schemaColumns: SchemaColumn[] = [];
  let indexes: SchemaIndex[] = [];
  let constraints: SchemaConstraint[] = [];

  // Pagination state shared by both modes; populated per branch below.
  let showPrev = false;
  let showNext = false;
  let prevHref = "";
  let nextHref = "";
  // Offset-mode-only position readout.
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  let from = 0;
  let to = 0;

  if (view === "schema") {
    [schemaColumns, indexes, constraints] = await Promise.all([
      loadSchemaColumns(schema, name),
      loadIndexes(schema, name),
      loadConstraints(schema, name),
    ]);
  } else if (pkCol) {
    // --- Keyset mode ---------------------------------------------------------
    const dir: KeysetDir = sp.before ? "prev" : sp.after ? "next" : "first";
    const cursor = sp.before ?? sp.after ?? null;
    const fetched = await loadRowsKeyset(schema, name, pkCol, dir, cursor, PAGE_SIZE, filter);
    const hasExtra = fetched.length > PAGE_SIZE;

    // Drop the probe row: forward queries keep the first PAGE_SIZE; the backward
    // query keeps the last PAGE_SIZE (its extra row is the oldest of the batch).
    if (dir === "prev") {
      rows = hasExtra ? fetched.slice(fetched.length - PAGE_SIZE) : fetched;
    } else {
      rows = hasExtra ? fetched.slice(0, PAGE_SIZE) : fetched;
    }

    if (rows.length > 0) {
      const firstPk = cursorValue(rows[0][pkCol]);
      const lastPk = cursorValue(rows[rows.length - 1][pkCol]);
      // Next exists if we found more going forward, or we arrived by going back.
      showNext = dir === "prev" ? true : hasExtra;
      // Prev exists if we arrived by going forward, or older rows still remain.
      showPrev = dir === "next" ? true : dir === "prev" ? hasExtra : false;
      nextHref = cursorHref(name, schema, { after: lastPk }, filter);
      prevHref = cursorHref(name, schema, { before: firstPk }, filter);
    }
  } else {
    // --- Offset fallback (views, PK-less / composite-PK tables) --------------
    const offset = (page - 1) * PAGE_SIZE;
    rows = await loadRows(schema, name, PAGE_SIZE, offset);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    showPrev = page > 1;
    showNext = page < totalPages;
    prevHref = pageHref(name, schema, page - 1);
    nextHref = pageHref(name, schema, page + 1);
    from = total === 0 ? 0 : offset + 1;
    to = Math.min(offset + rows.length, total);
  }

  return (
    // h-full + flex column so the data table can flex to fill the leftover
    // height and scroll internally — keeps the page itself from overflowing
    // (no second, page-level vertical scrollbar).
    <main className="flex h-full flex-col px-6 py-10">
      {(sp.error || sp.ok) && (
        <div className="mb-4">
          {sp.error && (
            <p className="rounded border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">
              {sp.error}
            </p>
          )}
          {sp.ok && (
            <p className="rounded border border-emerald-900/50 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-300">
              {sp.ok}
            </p>
          )}
        </div>
      )}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <span className="font-mono">{schema}.{name}</span>
            {kindLabel && (
              <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                {kindLabel}
              </span>
            )}
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            {useEstimate && "~"}
            {total.toLocaleString()} {total === 1 ? "row" : "rows"}
            {useEstimate && " (estimated)"} ·{" "}
            {columns.length} {columns.length === 1 ? "column" : "columns"}
          </p>
        </div>
        <RefreshButton />
      </div>

      {isSystemSchema && (
        <div className="mt-4 rounded border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
          <span className="font-medium">Read-only.</span>{" "}
          This is a system table — direct edits would bypass invariants
          (audit hash chain, encrypted env vars, password hashing, scheduler
          state).{" "}
          {adminPage ? (
            <>
              Use{" "}
              <Link
                href={adminPage.href}
                className="underline decoration-amber-500/50 underline-offset-2 hover:decoration-amber-300"
              >
                {adminPage.label}
              </Link>{" "}
              to modify rows safely.
            </>
          ) : (
            <>Mutations should go through the SQL editor with care, or the corresponding admin page.</>
          )}
        </div>
      )}

      {!isSystemSchema && !rlsEnabled && (
        <div className="mt-4 rounded border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
          <span className="font-medium">Row Level Security is off.</span>{" "}
          New tables are created without RLS by design — but while it&apos;s off,
          any role you{" "}
          <Link
            href="/admin/grants"
            className="underline decoration-amber-500/50 underline-offset-2 hover:decoration-amber-300"
          >
            grant access
          </Link>{" "}
          (including <span className="font-mono">anon</span> /{" "}
          <span className="font-mono">authenticated</span> over the API) can read
          and write <em>every</em> row. Enable RLS and add{" "}
          <Link
            href="/admin/policies"
            className="underline decoration-amber-500/50 underline-offset-2 hover:decoration-amber-300"
          >
            policies
          </Link>{" "}
          to restrict access per row.
        </div>
      )}

      <div className="mt-6 flex gap-1 border-b border-neutral-800">
        <Link
          href={tabHref(name, schema, "data")}
          className={`-mb-px border-b-2 px-3 py-2 text-sm ${
            view === "data"
              ? "border-neutral-300 text-neutral-100"
              : "border-transparent text-neutral-500 hover:text-neutral-300"
          }`}
        >
          Data
        </Link>
        <Link
          href={tabHref(name, schema, "schema")}
          className={`-mb-px border-b-2 px-3 py-2 text-sm ${
            view === "schema"
              ? "border-neutral-300 text-neutral-100"
              : "border-transparent text-neutral-500 hover:text-neutral-300"
          }`}
        >
          Schema
        </Link>
      </div>

      {view === "schema" ? (
        <SchemaPanel
          schema={schema}
          name={name}
          columns={schemaColumns}
          indexes={indexes}
          constraints={constraints}
        />
      ) : (
        <div className="mt-6 flex min-h-0 flex-1 flex-col">
          {/* Filtering rides on the keyset query, so it's only offered for
              keyset-paged tables (single-column PK), not the offset fallback. */}
          {pkCol && (
            <RowFilter
              name={name}
              schema={schema}
              columns={columns}
              current={filter}
            />
          )}
          <Card className="mt-3 min-h-0 flex-1 overflow-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="sticky top-0 z-10 border-b border-neutral-700 bg-neutral-800 text-left text-neutral-400">
                  {columns.map((c) => (
                    <th key={c.column_name} className="px-3 py-2 font-normal">
                      <div className="font-mono text-neutral-100">{c.column_name}</div>
                      <div className="text-xs text-neutral-500">{c.data_type}</div>
                    </th>
                  ))}
                  {canAddColumn && (
                    <th className="w-10 px-2 py-2 align-middle font-normal">
                      <AddColumnDrawer schema={schema} table={name} />
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={columns.length + (canAddColumn ? 1 : 0)}
                      className="px-3 py-6 text-center text-neutral-500"
                    >
                      No rows.
                    </td>
                  </tr>
                ) : (
                  rows.map((row, i) => (
                    <tr
                      key={i}
                      className="border-b border-neutral-800 last:border-b-0 odd:bg-neutral-900 even:bg-neutral-950/40 hover:bg-neutral-800/50"
                    >
                      {columns.map((c) => {
                        const sensitive = isSensitive(schema, name, c.column_name);
                        const raw = row[c.column_name];
                        const text = sensitive ? maskedDisplay(raw) : renderCell(raw);
                        return (
                          <td
                            key={c.column_name}
                            className={`max-w-xs truncate px-3 py-2 font-mono ${
                              sensitive ? "text-neutral-500" : "text-neutral-300"
                            }`}
                            // Don't put the real value in a title= attribute — that
                            // would re-expose it on hover.
                            title={sensitive ? "masked" : text}
                          >
                            {text}
                          </td>
                        );
                      })}
                      {canAddColumn && <td className="w-10 px-2 py-2" aria-hidden="true" />}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </Card>

          <nav className="mt-4 flex items-center justify-between text-sm text-neutral-400">
            <span>
              {pkCol && filter ? (
                <>Filtered by <span className="font-mono text-neutral-300">{filter.col}</span></>
              ) : pkCol ? (
                <>
                  {useEstimate && "~"}
                  {total.toLocaleString()} {total === 1 ? "row" : "rows"}
                  {useEstimate && " (estimated)"}
                </>
              ) : (
                <>
                  {from}–{to} of {total.toLocaleString()}
                </>
              )}
            </span>
            <div className="flex gap-2">
              {showPrev && (
                <Link
                  href={prevHref}
                  className="rounded border border-neutral-700 px-2 py-1 hover:bg-neutral-800"
                >
                  ← Prev
                </Link>
              )}
              {!pkCol && (
                <span className="px-2 py-1 text-neutral-500">
                  Page {page} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}
                </span>
              )}
              {showNext && (
                <Link
                  href={nextHref}
                  className="rounded border border-neutral-700 px-2 py-1 hover:bg-neutral-800"
                >
                  Next →
                </Link>
              )}
            </div>
          </nav>
        </div>
      )}
    </main>
  );
}
