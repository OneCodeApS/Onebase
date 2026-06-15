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
