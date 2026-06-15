import type { QueryResult as PgQueryResult } from "pg";
import { pool } from "../db";
import { scopeAllowed, type TokenAuth } from "../access-tokens";

// SQL execution for MCP tools, reusing the exact role discipline the SQL
// editor established (app/(app)/sql/actions.ts):
//   ddl   — dashboard_admin, autocommit (db:ddl scope, admin-owned tokens)
//   write — SET LOCAL ROLE dashboard_sql_rw in a transaction (DML, no DDL)
//   read  — READ ONLY transaction (any write errors at the DB layer)

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
// readable via get_logs, which is gated by logs:read). A string guardrail in
// the same spirit as the SQL editor's read-only regex — the hard boundary
// remains scopes + Postgres roles. Note `auth.uid()` and friends still pass:
// only the listed table names match.
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
      await client.query("SET LOCAL ROLE dashboard_sql_rw");
    } else {
      await client.query("BEGIN READ ONLY");
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
