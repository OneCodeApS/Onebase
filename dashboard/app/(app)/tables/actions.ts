"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { pool } from "@/lib/db";
import { quoteIdent, SAFE_IDENT, loadPrimaryKeyColumn } from "@/lib/db-introspect";
import { audit } from "@/lib/audit";
import { getSession } from "@/lib/session";

// System schemas enforce platform invariants (audit hash chain, AES-GCM env
// vars, Argon2 password hashing, scheduler state). Dropping their tables would
// brick the install, so deletion is refused regardless of role — this mirrors
// the read-only treatment of these schemas in the tables sidebar.
const PROTECTED_SCHEMAS = new Set([
  "_dashboard",
  "auth",
  "pg_catalog",
  "information_schema",
]);

async function clientIp(): Promise<string | null> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return h.get("x-real-ip");
}

function redirectTables(error?: string, ok?: string): never {
  const params = new URLSearchParams();
  if (error) params.set("error", error);
  if (ok) params.set("ok", ok);
  const qs = params.toString();
  redirect(`/tables${qs ? "?" + qs : ""}`);
}

// Back to a specific table's Data tab (where the Add-column "+" lives), carrying
// the ok/error banner. Mirrors the table page's own schema query handling; the
// Data tab is the default view, so we don't set ?view.
function redirectTable(
  name: string,
  schema: string,
  opts: { error?: string; ok?: string },
): never {
  const params = new URLSearchParams();
  if (schema !== "public") params.set("schema", schema);
  if (opts.error) params.set("error", opts.error);
  if (opts.ok) params.set("ok", opts.ok);
  const qs = params.toString();
  redirect(`/tables/${encodeURIComponent(name)}${qs ? "?" + qs : ""}`);
}

// Run one DML statement as the session's role. admin executes as
// dashboard_admin; read_write runs inside a transaction after SET LOCAL ROLE
// dashboard_sql_rw (mirrors the SQL editor), so the DB layer, not this code,
// is what denies anything beyond plain DML.
async function runAsRole(role: "admin" | "read_write", sql: string, params: unknown[]) {
  if (role === "admin") return pool().query(sql, params);
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE dashboard_sql_rw");
    const r = await client.query(sql, params);
    await client.query("COMMIT");
    return r;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Curated allow-list for the "Add column" form. Keys are the values the <select>
// submits; values are the literal SQL types we emit. Constraining to this set
// means the type fragment of the generated DDL is never user-controlled text —
// only the (quoted, validated) column name is. Anything fancier (arrays, custom
// types, generated columns, defaults) goes through the SQL editor.
const COLUMN_TYPES: Record<string, string> = {
  text: "text",
  integer: "integer",
  bigint: "bigint",
  boolean: "boolean",
  timestamptz: "timestamptz",
  date: "date",
  uuid: "uuid",
  numeric: "numeric",
  jsonb: "jsonb",
};

export async function addColumn(formData: FormData) {
  const session = await getSession();
  if (session.role !== "admin") throw new Error("Admin only");
  const ip = await clientIp();

  const schema = String(formData.get("schema") ?? "").trim();
  const table = String(formData.get("table") ?? "").trim();
  const column = String(formData.get("column") ?? "").trim();
  const typeKey = String(formData.get("type") ?? "").trim();
  const notNull = formData.get("not_null") === "on";
  const target = `${schema}.${table}`;

  try {
    if (!SAFE_IDENT.test(schema)) throw new Error("Unsafe schema identifier");
    if (!SAFE_IDENT.test(table)) throw new Error("Unsafe table identifier");
    if (!SAFE_IDENT.test(column)) {
      throw new Error(
        "Invalid column name — use letters, digits and underscores, not starting with a digit.",
      );
    }
    const sqlType = COLUMN_TYPES[typeKey];
    if (!sqlType) throw new Error(`Unsupported column type: ${typeKey}`);
    if (PROTECTED_SCHEMAS.has(schema)) {
      throw new Error(
        `Tables in "${schema}" are managed by the platform and can't be altered here`,
      );
    }

    // A NOT NULL column with no default only succeeds on an empty table —
    // existing rows would have no value for it. Check up front so we can give a
    // clear message instead of a raw Postgres error. (A row inserted between this
    // check and the ALTER would still be caught by Postgres and surfaced below.)
    if (notNull) {
      const { rows } = await pool().query(
        `SELECT 1 FROM ${quoteIdent(schema)}.${quoteIdent(table)} LIMIT 1`,
      );
      if (rows.length > 0) {
        throw new Error(
          "Can't add a NOT NULL column without a default to a table that already has rows. Add it as nullable, or set a default via the SQL editor.",
        );
      }
    }

    await pool().query(
      `ALTER TABLE ${quoteIdent(schema)}.${quoteIdent(table)} ` +
        `ADD COLUMN ${quoteIdent(column)} ${sqlType}${notNull ? " NOT NULL" : ""}`,
    );
  } catch (e) {
    const msg = (e as Error).message.split("\n")[0];
    await audit({
      actor: session.email!,
      actorId: session.userId,
      role: "admin",
      action: "table.add_column",
      target,
      success: false,
      ip,
      sessionId: session.sessionId ?? null,
      metadata: { error: msg, schema, table, column, type: typeKey, notNull },
    });
    redirectTable(table, schema, { error: msg });
  }

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role: "admin",
    action: "table.add_column",
    target,
    success: true,
    ip,
    sessionId: session.sessionId ?? null,
    metadata: { schema, table, column, type: typeKey, notNull },
  });

  // "layout" so the sidebar (column counts) and the table page both refresh.
  revalidatePath("/tables", "layout");
  redirectTable(table, schema, { ok: `Added column ${column}` });
}

// pg_class.relkind → the matching DROP verb. Anything else is rejected rather
// than silently treated as a table.
const DROP_VERB: Record<string, string> = {
  r: "DROP TABLE",
  v: "DROP VIEW",
  m: "DROP MATERIALIZED VIEW",
};

export async function deleteTable(formData: FormData) {
  const session = await getSession();
  if (session.role !== "admin") throw new Error("Admin only");
  const ip = await clientIp();

  const schema = String(formData.get("schema") ?? "").trim();
  const table = String(formData.get("table") ?? "").trim();
  // Default to a table for backwards-compat with any caller that omits kind.
  const kind = String(formData.get("kind") ?? "r").trim();
  const target = `${schema}.${table}`;

  try {
    if (!SAFE_IDENT.test(schema)) throw new Error("Unsafe schema identifier");
    if (!SAFE_IDENT.test(table)) throw new Error("Unsafe table identifier");
    const dropVerb = DROP_VERB[kind];
    if (!dropVerb) throw new Error(`Unsupported object kind: ${kind}`);
    if (PROTECTED_SCHEMAS.has(schema)) {
      throw new Error(
        `Objects in "${schema}" are managed by the platform and can't be dropped here`,
      );
    }
    // RESTRICT (the default): the drop fails if other objects depend on this
    // one, so an admin can't silently cascade away dependent views / foreign
    // keys with one click. Use the SQL editor for a deliberate CASCADE.
    await pool().query(
      `${dropVerb} ${quoteIdent(schema)}.${quoteIdent(table)}`,
    );
  } catch (e) {
    const msg = (e as Error).message.split("\n")[0];
    await audit({
      actor: session.email!,
      actorId: session.userId,
      role: "admin",
      action: "table.delete",
      target,
      success: false,
      ip,
      sessionId: session.sessionId ?? null,
      metadata: { error: msg, schema, table, kind },
    });
    redirectTables(msg);
  }

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role: "admin",
    action: "table.delete",
    target,
    success: true,
    ip,
    sessionId: session.sessionId ?? null,
    metadata: { schema, table, kind },
  });

  // "layout" so the sidebar's table list (loaded in tables/layout.tsx) drops
  // the deleted entry, not just the page body.
  revalidatePath("/tables", "layout");
  redirectTables(undefined, `Dropped ${target}`);
}

// One row from the Data tab's "Insert row" drawer. admin and read_write only;
// read_write runs under dashboard_sql_rw inside a transaction, mirroring the
// SQL editor, so the DB layer (not this code) is what denies DDL. Real tables
// in non-protected schemas only. Only columns that exist on the table and are
// not generated / GENERATED ALWAYS AS IDENTITY are taken from the form; blank
// fields are omitted so the column default applies. Values travel as query
// parameters and Postgres casts them to each column's type.
export async function insertRow(formData: FormData) {
  const session = await getSession();
  const role = session.role;
  if (role !== "admin" && role !== "read_write") {
    throw new Error("Admin or read/write only");
  }
  const ip = await clientIp();

  const schema = String(formData.get("schema") ?? "").trim();
  const table = String(formData.get("table") ?? "").trim();
  const target = `${schema}.${table}`;
  const colNames: string[] = [];

  try {
    if (!SAFE_IDENT.test(schema)) throw new Error("Unsafe schema identifier");
    if (!SAFE_IDENT.test(table)) throw new Error("Unsafe table identifier");
    if (PROTECTED_SCHEMAS.has(schema)) {
      throw new Error(
        `Tables in "${schema}" are managed by the platform and can't be edited here`,
      );
    }

    const rel = await pool().query<{ relkind: string }>(
      `SELECT c.relkind::text AS relkind
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, table],
    );
    const relkind = rel.rows[0]?.relkind;
    if (relkind !== "r" && relkind !== "p") {
      throw new Error("Rows can only be inserted into tables, not views");
    }

    const { rows: cols } = await pool().query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
          AND is_generated = 'NEVER'
          AND (is_identity = 'NO' OR identity_generation = 'BY DEFAULT')
        ORDER BY ordinal_position`,
      [schema, table],
    );
    const values: string[] = [];
    for (const c of cols) {
      const v = formData.get(`col:${c.column_name}`);
      // shortcut: blank means "use the column default" -- there is no way to
      // insert an empty string or an explicit NULL over a non-null default;
      // add a per-field null toggle in the drawer if that is ever needed.
      if (typeof v === "string" && v !== "") {
        colNames.push(c.column_name);
        values.push(v);
      }
    }

    const qualified = `${quoteIdent(schema)}.${quoteIdent(table)}`;
    const sql =
      colNames.length === 0
        ? `INSERT INTO ${qualified} DEFAULT VALUES`
        : `INSERT INTO ${qualified} (${colNames.map(quoteIdent).join(", ")}) ` +
          `VALUES (${values.map((_, i) => `$${i + 1}`).join(", ")})`;

    await runAsRole(role, sql, values);
  } catch (e) {
    const msg = (e as Error).message.split("\n")[0];
    await audit({
      actor: session.email!,
      actorId: session.userId,
      role,
      action: "table.insert_row",
      target,
      success: false,
      ip,
      sessionId: session.sessionId ?? null,
      metadata: { error: msg, schema, table, columns: colNames },
    });
    redirectTable(table, schema, { error: msg });
  }

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role,
    action: "table.insert_row",
    target,
    success: true,
    ip,
    sessionId: session.sessionId ?? null,
    metadata: { schema, table, columns: colNames },
  });

  // "layout" so the row count on the page and the sidebar both refresh.
  revalidatePath("/tables", "layout");
  redirectTable(table, schema, { ok: "Inserted 1 row" });
}

// Hard cap on one bulk delete; the Data tab shows PAGE_SIZE (50) rows, so this
// only guards against a hand-crafted request, not real use.
const MAX_DELETE_ROWS = 500;

// The rows ticked on the Data tab. Same gating as insertRow. Rows are addressed
// by the table's single-column primary key, resolved here from pg_index --
// never taken from the form -- so tables without one are refused (the UI shows
// no checkboxes for them). Views can't have a PK, so this also rules them out.
// Keys travel as one array parameter; Postgres casts it to the key's type.
export async function deleteRows(formData: FormData) {
  const session = await getSession();
  const role = session.role;
  if (role !== "admin" && role !== "read_write") {
    throw new Error("Admin or read/write only");
  }
  const ip = await clientIp();

  const schema = String(formData.get("schema") ?? "").trim();
  const table = String(formData.get("table") ?? "").trim();
  const pks = [
    ...new Set(
      formData.getAll("pk").filter((v): v is string => typeof v === "string" && v !== ""),
    ),
  ];
  const target = `${schema}.${table}`;
  let pkCol: string | null = null;
  let deleted = 0;

  try {
    if (!SAFE_IDENT.test(schema)) throw new Error("Unsafe schema identifier");
    if (!SAFE_IDENT.test(table)) throw new Error("Unsafe table identifier");
    if (PROTECTED_SCHEMAS.has(schema)) {
      throw new Error(
        `Tables in "${schema}" are managed by the platform and can't be edited here`,
      );
    }
    if (pks.length === 0) throw new Error("No rows selected");
    if (pks.length > MAX_DELETE_ROWS) {
      throw new Error(`Select at most ${MAX_DELETE_ROWS} rows at a time`);
    }
    pkCol = await loadPrimaryKeyColumn(schema, table);
    if (!pkCol) {
      throw new Error("Rows can only be deleted from tables with a single-column primary key");
    }
    const r = await runAsRole(
      role,
      `DELETE FROM ${quoteIdent(schema)}.${quoteIdent(table)} WHERE ${quoteIdent(pkCol)} = ANY($1)`,
      [pks],
    );
    deleted = r.rowCount ?? 0;
    if (deleted === 0) throw new Error("No matching rows -- they may already have been deleted");
  } catch (e) {
    const msg = (e as Error).message.split("\n")[0];
    await audit({
      actor: session.email!,
      actorId: session.userId,
      role,
      action: "table.delete_rows",
      target,
      success: false,
      ip,
      sessionId: session.sessionId ?? null,
      metadata: { error: msg, schema, table, pkColumn: pkCol, requested: pks.length, pks: pks.slice(0, 100) },
    });
    redirectTable(table, schema, { error: msg });
  }

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role,
    action: "table.delete_rows",
    target,
    success: true,
    ip,
    sessionId: session.sessionId ?? null,
    metadata: { schema, table, pkColumn: pkCol, requested: pks.length, deleted, pks: pks.slice(0, 100) },
  });

  revalidatePath("/tables", "layout");
  const noun = deleted === 1 ? "row" : "rows";
  redirectTable(table, schema, {
    ok:
      deleted === pks.length
        ? `Deleted ${deleted} ${noun}`
        : `Deleted ${deleted} of ${pks.length} rows (the rest no longer existed)`,
  });
}

// The edited fields of one row from the Data tab's Edit drawer. Same gating and
// PK handling as deleteRows. Only `set:<col>` / `null:<col>` entries for columns
// that exist and are updatable (not generated, not GENERATED ALWAYS AS IDENTITY,
// not the PK itself) are honoured; anything else in the form is ignored. Values
// travel as parameters and Postgres casts them to each column's type.
export async function updateRow(formData: FormData) {
  const session = await getSession();
  const role = session.role;
  if (role !== "admin" && role !== "read_write") {
    throw new Error("Admin or read/write only");
  }
  const ip = await clientIp();

  const schema = String(formData.get("schema") ?? "").trim();
  const table = String(formData.get("table") ?? "").trim();
  const pk = String(formData.get("pk") ?? "");
  const target = `${schema}.${table}`;
  let pkCol: string | null = null;
  const changed: string[] = [];

  try {
    if (!SAFE_IDENT.test(schema)) throw new Error("Unsafe schema identifier");
    if (!SAFE_IDENT.test(table)) throw new Error("Unsafe table identifier");
    if (PROTECTED_SCHEMAS.has(schema)) {
      throw new Error(
        `Tables in "${schema}" are managed by the platform and can't be edited here`,
      );
    }
    pkCol = await loadPrimaryKeyColumn(schema, table);
    if (!pkCol) {
      throw new Error("Rows can only be edited in tables with a single-column primary key");
    }

    const { rows: cols } = await pool().query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
          AND is_generated = 'NEVER'
          AND (is_identity = 'NO' OR identity_generation = 'BY DEFAULT')
        ORDER BY ordinal_position`,
      [schema, table],
    );
    const sets: string[] = [];
    const params: unknown[] = [pk];
    for (const c of cols) {
      if (c.column_name === pkCol) continue;
      if (formData.get(`null:${c.column_name}`) === "1") {
        sets.push(`${quoteIdent(c.column_name)} = NULL`);
        changed.push(c.column_name);
        continue;
      }
      const v = formData.get(`set:${c.column_name}`);
      if (typeof v === "string") {
        params.push(v);
        sets.push(`${quoteIdent(c.column_name)} = $${params.length}`);
        changed.push(c.column_name);
      }
    }
    if (sets.length === 0) throw new Error("No changes to save");

    const r = await runAsRole(
      role,
      `UPDATE ${quoteIdent(schema)}.${quoteIdent(table)} SET ${sets.join(", ")} ` +
        `WHERE ${quoteIdent(pkCol)} = $1`,
      params,
    );
    if (r.rowCount === 0) throw new Error("Row not found -- it may have been deleted");
  } catch (e) {
    const msg = (e as Error).message.split("\n")[0];
    await audit({
      actor: session.email!,
      actorId: session.userId,
      role,
      action: "table.update_row",
      target,
      success: false,
      ip,
      sessionId: session.sessionId ?? null,
      metadata: { error: msg, schema, table, pkColumn: pkCol, pk, columns: changed },
    });
    redirectTable(table, schema, { error: msg });
  }

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role,
    action: "table.update_row",
    target,
    success: true,
    ip,
    sessionId: session.sessionId ?? null,
    metadata: { schema, table, pkColumn: pkCol, pk, columns: changed },
  });

  revalidatePath("/tables", "layout");
  redirectTable(table, schema, {
    ok: `Updated ${changed.length} ${changed.length === 1 ? "field" : "fields"}`,
  });
}
