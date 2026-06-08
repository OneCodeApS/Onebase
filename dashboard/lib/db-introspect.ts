import { pool } from "./db";

// Postgres-side metadata reads. These all run as dashboard_admin (which has
// pg_read_all_stats and BYPASSRLS) so they see everything users created.
//
// Identifier names from these views are unquoted strings; whenever they're
// reused in a generated SQL statement, they MUST go through quoteIdent.

// Rule for a Postgres identifier that we'll quote and embed in DDL.
// Postgres itself accepts almost anything if quoted, but we constrain to a
// safe subset to keep generated SQL legible and avoid edge cases.
export const SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_$]{0,62}$/;

export function quoteIdent(ident: string): string {
  if (!SAFE_IDENT.test(ident)) {
    throw new Error(`Invalid identifier: ${ident}`);
  }
  return `"${ident}"`;
}

const SYSTEM_SCHEMAS = `(
  'pg_catalog', 'information_schema', 'pg_toast'
)`;

export async function listUserSchemas(): Promise<string[]> {
  const { rows } = await pool().query<{ nspname: string }>(`
    SELECT nspname
      FROM pg_namespace
     WHERE nspname NOT IN ${SYSTEM_SCHEMAS}
       AND nspname NOT LIKE 'pg_temp_%'
       AND nspname NOT LIKE 'pg_toast_temp_%'
     ORDER BY nspname
  `);
  return rows.map((r) => r.nspname);
}

export async function listTablesInSchema(schema: string): Promise<string[]> {
  if (!SAFE_IDENT.test(schema)) return [];
  const { rows } = await pool().query<{ tablename: string }>(
    `SELECT tablename
       FROM pg_tables
      WHERE schemaname = $1
      ORDER BY tablename`,
    [schema],
  );
  return rows.map((r) => r.tablename);
}

// All non-system Postgres roles, used to populate the policy form. Excludes
// internal pg_* roles.
export async function listRoles(): Promise<string[]> {
  const { rows } = await pool().query<{ rolname: string }>(
    `SELECT rolname
       FROM pg_roles
      WHERE rolname NOT LIKE 'pg_%'
      ORDER BY rolname`,
  );
  return rows.map((r) => r.rolname);
}

// ─── Policies ────────────────────────────────────────────────────────────────

export type PolicyRow = {
  schema: string;
  table: string;
  name: string;
  permissive: "PERMISSIVE" | "RESTRICTIVE";
  roles: string[];
  cmd: "ALL" | "SELECT" | "INSERT" | "UPDATE" | "DELETE";
  using_expr: string | null;
  check_expr: string | null;
};

export async function listPolicies(schema?: string): Promise<PolicyRow[]> {
  const params: string[] = [];
  let where = `WHERE schemaname NOT IN ${SYSTEM_SCHEMAS}`;
  if (schema) {
    params.push(schema);
    where = `WHERE schemaname = $1`;
  }
  const { rows } = await pool().query<{
    schema: string;
    table: string;
    name: string;
    permissive: string;
    roles: string[];
    cmd: string;
    using_expr: string | null;
    check_expr: string | null;
  }>(
    `SELECT schemaname AS schema,
            tablename  AS "table",
            policyname AS name,
            permissive,
            roles::text[] AS roles,
            cmd,
            qual       AS using_expr,
            with_check AS check_expr
       FROM pg_policies
       ${where}
       ORDER BY schemaname, "table", name`,
    params,
  );
  // Roles is array of names; "public" appears as a plain name. Trim any
  // surrounding quotes that Postgres adds for casing.
  return rows.map((r) => ({
    ...r,
    permissive: r.permissive as PolicyRow["permissive"],
    cmd: r.cmd as PolicyRow["cmd"],
  }));
}

// Per-table RLS status — whether RLS is enabled at all, and if forced. A
// table with RLS disabled has no protection regardless of how many policies
// exist (policies are inert until RLS is enabled on the table).
export type TableRlsStatus = {
  schema: string;
  table: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  policy_count: number;
};

export async function listTablesRlsStatus(
  schema?: string,
): Promise<TableRlsStatus[]> {
  const params: string[] = [];
  let where = `WHERE n.nspname NOT IN ${SYSTEM_SCHEMAS} AND c.relkind = 'r'`;
  if (schema) {
    params.push(schema);
    where = `WHERE n.nspname = $1 AND c.relkind = 'r'`;
  }
  const { rows } = await pool().query<TableRlsStatus>(
    `SELECT n.nspname AS schema,
            c.relname  AS "table",
            c.relrowsecurity      AS rls_enabled,
            c.relforcerowsecurity AS rls_forced,
            (SELECT count(*)::int
               FROM pg_policies p
              WHERE p.schemaname = n.nspname
                AND p.tablename  = c.relname) AS policy_count
       FROM pg_class c
       JOIN pg_namespace n ON c.relnamespace = n.oid
       ${where}
       ORDER BY n.nspname, c.relname`,
    params,
  );
  return rows;
}

// ─── Grants (table / view privileges) ────────────────────────────────────────

export type TableGrant = {
  grantee: string; // role name, or 'PUBLIC'
  privileges: string[]; // canonical order, e.g. ['SELECT', 'INSERT']
  grantable: string[]; // subset of `privileges` held WITH GRANT OPTION
};

export type TableGrantsRow = {
  schema: string;
  table: string;
  kind: "table" | "view" | "materialized view" | "partitioned table";
  // The owner has every privilege implicitly; it never appears in `grants`.
  owner: string;
  grants: TableGrant[]; // explicit GRANTs to other roles + PUBLIC
};

// Canonical display order for table-level privileges.
const PRIVILEGE_ORDER = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
  "MAINTAIN",
];

function sortPrivileges(privs: string[]): string[] {
  return [...privs].sort(
    (a, b) =>
      (PRIVILEGE_ORDER.indexOf(a) + 1 || 99) -
      (PRIVILEGE_ORDER.indexOf(b) + 1 || 99),
  );
}

// Table / view privilege grants for a schema. relacl holds the explicit grants
// and is NULL when only the owner has access (owner privileges are implicit and
// never stored in relacl) — that surfaces here as an empty `grants` array.
// aclexplode flattens relacl into (grantee, privilege, grantable); grantee oid 0
// is PUBLIC. Runs as dashboard_admin, so it sees every object.
export async function listTableGrants(
  schema: string,
): Promise<TableGrantsRow[]> {
  if (!SAFE_IDENT.test(schema)) return [];
  const { rows } = await pool().query<{
    schema: string;
    table: string;
    kind: TableGrantsRow["kind"];
    owner: string;
    acl: { grantee: string; privilege: string; grantable: boolean }[];
  }>(
    `SELECT n.nspname AS schema,
            c.relname AS "table",
            CASE c.relkind
              WHEN 'r' THEN 'table'
              WHEN 'v' THEN 'view'
              WHEN 'm' THEN 'materialized view'
              WHEN 'p' THEN 'partitioned table'
            END AS kind,
            o.rolname AS owner,
            COALESCE(
              json_agg(
                json_build_object(
                  'grantee',   COALESCE(g.rolname, 'PUBLIC'),
                  'privilege', acl.privilege_type,
                  'grantable', acl.is_grantable
                )
                ORDER BY COALESCE(g.rolname, 'PUBLIC'), acl.privilege_type
              ) FILTER (WHERE acl.privilege_type IS NOT NULL),
              '[]'::json
            ) AS acl
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_roles     o ON o.oid = c.relowner
       LEFT JOIN LATERAL aclexplode(c.relacl) acl ON true
       LEFT JOIN pg_roles g ON g.oid = acl.grantee
      WHERE n.nspname = $1
        AND c.relkind IN ('r', 'v', 'm', 'p')
      GROUP BY n.nspname, c.relname, c.relkind, o.rolname
      ORDER BY c.relname`,
    [schema],
  );

  return rows.map((r) => {
    // Collapse the flat (grantee, privilege) pairs into one row per grantee.
    const byGrantee = new Map<
      string,
      { privileges: string[]; grantable: string[] }
    >();
    for (const a of r.acl) {
      let entry = byGrantee.get(a.grantee);
      if (!entry) {
        entry = { privileges: [], grantable: [] };
        byGrantee.set(a.grantee, entry);
      }
      entry.privileges.push(a.privilege);
      if (a.grantable) entry.grantable.push(a.privilege);
    }
    const grants: TableGrant[] = [...byGrantee.entries()]
      // Drop the owner's own entry. Postgres lists the owner in relacl (with
      // full privileges) as soon as any grant exists, but that's just the
      // implicit ownership the Owner column already conveys — showing it on
      // every row is noise. Other roles + PUBLIC are what matter here.
      .filter(([grantee]) => grantee !== r.owner)
      .map(([grantee, v]) => ({
        grantee,
        privileges: sortPrivileges(v.privileges),
        grantable: sortPrivileges(v.grantable),
      }))
      .sort((a, b) => a.grantee.localeCompare(b.grantee));
    return {
      schema: r.schema,
      table: r.table,
      kind: r.kind,
      owner: r.owner,
      grants,
    };
  });
}

// ─── DB functions (PLpgSQL, SQL, etc.) ───────────────────────────────────────

export type DbFunctionRow = {
  oid: string;
  schema: string;
  name: string;
  args: string;
  returns: string;
  language: string;
  security_definer: boolean;
  volatility: "immutable" | "stable" | "volatile";
  kind: "function" | "procedure" | "aggregate" | "window";
  owner: string;
};

export type DbFunctionDetail = DbFunctionRow & { definition: string };

export async function listDbFunctions(
  schema: string,
  // When false (the default), excludes functions installed by an extension
  // (pgcrypto's armor/crypt/pgp_*, citext's operators, etc.) so the list
  // shows only what the project / dashboard user has actually written.
  // We detect those via pg_depend with deptype 'e' — the canonical "object
  // belongs to an extension" link.
  includeExtensions = false,
): Promise<DbFunctionRow[]> {
  if (!SAFE_IDENT.test(schema)) return [];
  const extensionFilter = includeExtensions
    ? ""
    : `AND NOT EXISTS (
         SELECT 1 FROM pg_depend d
          WHERE d.objid = p.oid
            AND d.classid = 'pg_proc'::regclass
            AND d.deptype = 'e'
       )`;
  const { rows } = await pool().query<{
    oid: string;
    schema: string;
    name: string;
    args: string;
    returns: string;
    language: string;
    security_definer: boolean;
    volatility: string;
    kind: string;
    owner: string;
  }>(
    `SELECT p.oid::text AS oid,
            n.nspname   AS schema,
            p.proname   AS name,
            pg_get_function_identity_arguments(p.oid) AS args,
            pg_get_function_result(p.oid) AS returns,
            l.lanname AS language,
            p.prosecdef AS security_definer,
            CASE p.provolatile
              WHEN 'i' THEN 'immutable'
              WHEN 's' THEN 'stable'
              WHEN 'v' THEN 'volatile'
            END AS volatility,
            CASE p.prokind
              WHEN 'f' THEN 'function'
              WHEN 'p' THEN 'procedure'
              WHEN 'a' THEN 'aggregate'
              WHEN 'w' THEN 'window'
            END AS kind,
            r.rolname AS owner
       FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       JOIN pg_language  l ON p.prolang      = l.oid
       JOIN pg_roles     r ON p.proowner     = r.oid
      WHERE n.nspname = $1
      ${extensionFilter}
      ORDER BY p.proname, p.oid`,
    [schema],
  );
  return rows.map((r) => ({
    ...r,
    volatility: r.volatility as DbFunctionRow["volatility"],
    kind: r.kind as DbFunctionRow["kind"],
  }));
}

// Count of extension-provided functions in a schema, for the "N hidden" hint
// next to the toggle.
export async function countExtensionFunctions(schema: string): Promise<number> {
  if (!SAFE_IDENT.test(schema)) return 0;
  const { rows } = await pool().query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       JOIN pg_depend d
         ON d.objid = p.oid
        AND d.classid = 'pg_proc'::regclass
        AND d.deptype = 'e'
      WHERE n.nspname = $1`,
    [schema],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function getDbFunctionByOid(
  oid: string,
): Promise<DbFunctionDetail | null> {
  if (!/^\d+$/.test(oid)) return null;
  const { rows } = await pool().query<{
    oid: string;
    schema: string;
    name: string;
    args: string;
    returns: string;
    language: string;
    security_definer: boolean;
    volatility: string;
    kind: string;
    owner: string;
    definition: string;
  }>(
    `SELECT p.oid::text AS oid,
            n.nspname   AS schema,
            p.proname   AS name,
            pg_get_function_identity_arguments(p.oid) AS args,
            pg_get_function_result(p.oid) AS returns,
            l.lanname AS language,
            p.prosecdef AS security_definer,
            CASE p.provolatile
              WHEN 'i' THEN 'immutable'
              WHEN 's' THEN 'stable'
              WHEN 'v' THEN 'volatile'
            END AS volatility,
            CASE p.prokind
              WHEN 'f' THEN 'function'
              WHEN 'p' THEN 'procedure'
              WHEN 'a' THEN 'aggregate'
              WHEN 'w' THEN 'window'
            END AS kind,
            r.rolname AS owner,
            pg_get_functiondef(p.oid) AS definition
       FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       JOIN pg_language  l ON p.prolang      = l.oid
       JOIN pg_roles     r ON p.proowner     = r.oid
      WHERE p.oid = $1::oid`,
    [oid],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    ...r,
    volatility: r.volatility as DbFunctionRow["volatility"],
    kind: r.kind as DbFunctionRow["kind"],
  };
}
