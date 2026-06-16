"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { pool } from "@/lib/db";
import { quoteIdent, SAFE_IDENT } from "@/lib/db-introspect";
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
