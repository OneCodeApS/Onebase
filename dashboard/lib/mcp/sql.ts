import type { QueryResult as PgQueryResult } from "pg";
import { pool } from "../db";
import { scopeAllowed, type TokenAuth } from "../access-tokens";

// SQL execution for MCP tools. Each level SET ROLEs into a Postgres role whose
// grants ARE the boundary (not statement parsing), per 0027_mcp_sql_roles.sql:
//   ddl   — dashboard_admin, autocommit (db:ddl scope, admin-only tokens)
//   write — SET LOCAL ROLE mcp_writer in a transaction: DML on the public
//           application schema only; no DDL, and no reach into _dashboard/auth
//   read  — READ ONLY transaction + SET LOCAL ROLE mcp_reader: SELECT on public
//           only, so a db:read token cannot read credentials/secrets/audit even
//           if it slips a quoted identifier past PROTECTED_OBJECTS

export type SqlLevel = "read" | "write" | "ddl";

// The strongest level this token is entitled to. Tools run at this level —
// the DB-side restrictions of the level itself are what bound the blast
// radius, not statement parsing.
export function highestSqlLevel(auth: TokenAuth): SqlLevel | null {
  if (scopeAllowed(auth, "db:ddl")) return "ddl";
  if (scopeAllowed(auth, "db:write")) return "write";
  if (scopeAllowed(auth, "db:read")) return "read";
  return null;
}

// Objects raw MCP SQL must never touch, regardless of scope: credentials
// (access tokens, end-user sessions/identities, magic links), secrets
// (encrypted function env, OAuth provider config), and the audit log (only
// readable via get_logs, which is gated by logs:read). For db:read/db:write
// the hard boundary is now the mcp_reader/mcp_writer grants (these schemas are
// simply unreachable). This regex is defense-in-depth there, and remains a
// real guard on the db:ddl path, which runs as dashboard_admin. It is a string
// guardrail — bypassable via quoting/search_path — so it must NOT be relied on
// alone. Note `auth.uid()` and friends still pass: only the listed table names
// match.
const PROTECTED_OBJECTS =
  /(_dashboard\s*\.\s*(access_tokens|function_env|audit_log)|auth\s*\.\s*(users|identities|sessions|providers|settings|magic_link_tokens))/i;

export function touchesProtectedObjects(sql: string): string | null {
  const m = sql.match(PROTECTED_OBJECTS);
  return m ? m[0].replace(/\s+/g, "") : null;
}

export async function runSqlAtLevel(
  level: SqlLevel,
  sql: string,
): Promise<PgQueryResult> {
  if (level === "ddl") {
    // Autocommit, matching the SQL editor's admin path (so VACUUM, CREATE
    // INDEX CONCURRENTLY, etc. work).
    return pool().query(sql);
  }
  const client = await pool().connect();
  try {
    if (level === "write") {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE mcp_writer");
    } else {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL ROLE mcp_reader");
    }
    const r = await client.query(sql);
    await client.query("COMMIT");
    return r;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
