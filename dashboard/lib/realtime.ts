import { pool } from "./db";

// Identifier names that are safe to pass to enable/disable_realtime SQL
// helpers. The helpers themselves quote with %I, but we also reject anything
// that doesn't look like a normal Postgres identifier so we fail fast.
export const SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export type RealtimeMode = "basic" | "authorized";

export type RealtimeTable = {
  schema: string;
  table: string;
  enabled: boolean;
  // Only meaningful when enabled. 'basic' = legacy table-level broadcast (no
  // RLS); 'authorized' = per-subscriber RLS filtering.
  mode: RealtimeMode;
  // Whether the table has RLS turned on — surfaced so the UI can recommend
  // authorized mode and warn when it can't actually filter.
  rls_enabled: boolean;
};

export async function listRealtimeStatus(): Promise<RealtimeTable[]> {
  // Joins every base table in every non-system schema against the dashboard's
  // realtime_tables table so the UI can show one row per table with its
  // current toggle state, mode, and whether RLS is on.
  const { rows } = await pool().query<RealtimeTable>(
    `SELECT n.nspname AS schema,
            c.relname AS "table",
            COALESCE(r.enabled, false) AS enabled,
            COALESCE(r.mode, 'basic') AS mode,
            c.relrowsecurity AS rls_enabled
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN _dashboard.realtime_tables r
              ON r.schema = n.nspname AND r."table" = c.relname
      WHERE c.relkind = 'r'
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
        AND n.nspname NOT LIKE 'pg_temp%'
      ORDER BY n.nspname, c.relname`,
  );
  return rows;
}

export async function enableRealtime(
  schema: string,
  table: string,
  mode: RealtimeMode = "basic",
): Promise<void> {
  if (!SAFE_IDENT.test(schema) || !SAFE_IDENT.test(table)) {
    throw new Error("Invalid identifier");
  }
  if (mode !== "basic" && mode !== "authorized") {
    throw new Error("Invalid realtime mode");
  }
  await pool().query("SELECT _dashboard.enable_realtime($1, $2, $3)", [
    schema,
    table,
    mode,
  ]);
}

// The mode for a table, or null if realtime isn't enabled for it. Used by the
// SSE route to decide whether to apply per-subscriber RLS filtering.
export async function getRealtimeMode(
  schema: string,
  table: string,
): Promise<RealtimeMode | null> {
  const { rows } = await pool().query<{ enabled: boolean; mode: RealtimeMode }>(
    `SELECT enabled, mode FROM _dashboard.realtime_tables
      WHERE schema = $1 AND "table" = $2`,
    [schema, table],
  );
  const r = rows[0];
  if (!r || !r.enabled) return null;
  return r.mode;
}

export async function disableRealtime(schema: string, table: string): Promise<void> {
  if (!SAFE_IDENT.test(schema) || !SAFE_IDENT.test(table)) {
    throw new Error("Invalid identifier");
  }
  await pool().query("SELECT _dashboard.disable_realtime($1, $2)", [schema, table]);
}
