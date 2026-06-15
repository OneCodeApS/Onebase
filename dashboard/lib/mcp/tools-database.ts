import { pool } from "../db";
import { SAFE_IDENT, listTablesRlsStatus, listUserSchemas } from "../db-introspect";
import { confirmationRequest, looksDestructive, verifyConfirmToken } from "./confirm";
import { highestSqlLevel, runSqlAtLevel, touchesProtectedObjects } from "./sql";
import { generateTypescriptTypes } from "./typegen";
import { wrapUntrusted } from "./untrusted";
import type { ToolDef } from "./types";

// Cap on rows serialised into the agent's context. Postgres still runs the
// full query (statement_timeout from db.ts is the hard ceiling).
const MAX_ROWS = 200;

// Schema the MCP never introspects or generates types for — it's the
// dashboard's private internals. (`auth` structure IS listed: agents need it
// to write policies referencing auth helpers; its DATA is blocked in sql.ts.)
const HIDDEN_SCHEMAS = new Set(["_dashboard"]);

const MIGRATION_NAME = /^[a-z][a-z0-9_]{0,62}$/;

function requestedSchemas(args: Record<string, unknown>): string[] {
  const raw = Array.isArray(args.schemas) ? args.schemas.map(String) : ["public"];
  const schemas = raw.filter((s) => SAFE_IDENT.test(s) && !HIDDEN_SCHEMAS.has(s));
  if (schemas.length === 0) throw new Error("No valid schemas requested");
  return schemas;
}

export const databaseTools: ToolDef[] = [
  {
    name: "list_tables",
    description:
      "List tables in the given schemas (default: public) with columns, primary keys, foreign keys, and RLS status. Start here before writing queries or migrations.",
    scope: "db:read",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        schemas: {
          type: "array",
          items: { type: "string" },
          description: "Schemas to inspect. Defaults to [\"public\"].",
        },
      },
    },
    handler: async (args) => {
      const schemas = requestedSchemas(args);

      const { rows: columns } = await pool().query<{
        schema: string;
        table: string;
        column: string;
        data_type: string;
        nullable: boolean;
        default: string | null;
      }>(
        `SELECT c.table_schema AS schema, c.table_name AS "table",
                c.column_name AS "column", c.data_type,
                c.is_nullable = 'YES' AS nullable, c.column_default AS "default"
           FROM information_schema.columns c
           JOIN information_schema.tables t
             ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = ANY($1) AND t.table_type = 'BASE TABLE'
          ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
        [schemas],
      );

      const { rows: constraints } = await pool().query<{
        schema: string;
        table: string;
        name: string;
        type: string;
        definition: string;
      }>(
        `SELECT n.nspname AS schema, rel.relname AS "table",
                con.conname AS name, con.contype AS type,
                pg_get_constraintdef(con.oid) AS definition
           FROM pg_constraint con
           JOIN pg_class rel ON rel.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = rel.relnamespace
          WHERE n.nspname = ANY($1) AND con.contype IN ('p', 'f')
          ORDER BY n.nspname, rel.relname, con.conname`,
        [schemas],
      );

      type TableInfo = {
        columns: { name: string; type: string; nullable: boolean; default: string | null }[];
        primary_key: string | null;
        foreign_keys: string[];
        rls_enabled: boolean;
        policy_count: number;
      };
      const tables = new Map<string, TableInfo>();
      const key = (s: string, t: string) => `${s}.${t}`;

      for (const c of columns) {
        let t = tables.get(key(c.schema, c.table));
        if (!t) {
          t = { columns: [], primary_key: null, foreign_keys: [], rls_enabled: false, policy_count: 0 };
          tables.set(key(c.schema, c.table), t);
        }
        t.columns.push({ name: c.column, type: c.data_type, nullable: c.nullable, default: c.default });
      }
      for (const con of constraints) {
        const t = tables.get(key(con.schema, con.table));
        if (!t) continue;
        if (con.type === "p") t.primary_key = con.definition;
        else t.foreign_keys.push(con.definition);
      }
      for (const schema of schemas) {
        for (const s of await listTablesRlsStatus(schema)) {
          const t = tables.get(key(s.schema, s.table));
          if (t) {
            t.rls_enabled = s.rls_enabled;
            t.policy_count = s.policy_count;
          }
        }
      }

      const result = Object.fromEntries(tables);
      return { text: wrapUntrusted(`Tables in ${schemas.join(", ")}:`, result) };
    },
  },

  {
    name: "list_schemas",
    description: "List all user schemas in the database.",
    scope: "db:read",
    readOnly: true,
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const schemas = (await listUserSchemas()).filter((s) => !HIDDEN_SCHEMAS.has(s));
      return { text: JSON.stringify(schemas) };
    },
  },

  {
    name: "list_extensions",
    description: "List installed Postgres extensions with versions.",
    scope: "db:read",
    readOnly: true,
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const { rows } = await pool().query(
        `SELECT e.extname AS name, e.extversion AS version, n.nspname AS schema
           FROM pg_extension e
           JOIN pg_namespace n ON n.oid = e.extnamespace
          ORDER BY e.extname`,
      );
      return { text: JSON.stringify(rows, null, 1) };
    },
  },

  {
    name: "execute_sql",
    description:
      "Run a SQL statement. Executes at the strongest level the token allows: db:read → read-only transaction; db:write → restricted role (DML on all data, no DDL/TRUNCATE); db:ddl → full access. Use apply_migration for schema changes so they are recorded. Destructive statements (DROP, TRUNCATE, unfiltered DELETE/UPDATE) require a confirm_token round-trip. Results are truncated to 200 rows.",
    scope: "db:read",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "The SQL to execute." },
        confirm_token: {
          type: "string",
          description: "Echo of the token returned when a destructive statement needs confirmation.",
        },
      },
      required: ["sql"],
    },
    handler: async (args, ctx) => {
      const sql = String(args.sql ?? "").trim();
      if (!sql) return { text: "sql is required", isError: true };

      const blocked = touchesProtectedObjects(sql);
      if (blocked) {
        return {
          text: `Refused: the statement references ${blocked}, which is not reachable through MCP SQL (credentials, secrets, or the audit log). Use the dedicated tools (get_logs, list_functions, …) instead.`,
          isError: true,
        };
      }

      const level = highestSqlLevel(ctx.auth);
      if (level === null) return { text: "Token lacks a db scope", isError: true };

      if (level !== "read") {
        const reason = looksDestructive(sql);
        if (reason) {
          const token = typeof args.confirm_token === "string" ? args.confirm_token : "";
          if (!token || !verifyConfirmToken(sql, token)) {
            return { text: confirmationRequest(reason, sql) };
          }
        }
      }

      const started = Date.now();
      const r = await runSqlAtLevel(level, sql);
      const all = (r.rows ?? []) as Record<string, unknown>[];
      const truncated = all.length > MAX_ROWS;

      const summary = {
        level,
        command: r.command ?? null,
        row_count: r.rowCount ?? null,
        duration_ms: Date.now() - started,
        truncated,
        rows: truncated ? all.slice(0, MAX_ROWS) : all,
      };
      return { text: wrapUntrusted("SQL result:", summary) };
    },
  },

  {
    name: "explain_query",
    description:
      "Show the Postgres execution plan for a query (EXPLAIN). Set analyze=true to actually run it and get real timings — safe even for writes, because the plan runs inside a read-only transaction.",
    scope: "db:read",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "Query to explain (without the EXPLAIN keyword)." },
        analyze: { type: "boolean", description: "Execute and report actual times/buffers. Default false." },
      },
      required: ["sql"],
    },
    handler: async (args) => {
      const sql = String(args.sql ?? "").trim();
      if (!sql) return { text: "sql is required", isError: true };
      const blocked = touchesProtectedObjects(sql);
      if (blocked) {
        return { text: `Refused: references protected object ${blocked}`, isError: true };
      }
      const opts = args.analyze === true ? "ANALYZE, BUFFERS" : "COSTS";
      const r = await runSqlAtLevel("read", `EXPLAIN (${opts}, FORMAT TEXT) ${sql}`);
      const plan = (r.rows as Record<string, string>[])
        .map((row) => Object.values(row)[0])
        .join("\n");
      return { text: wrapUntrusted("Query plan:", plan) };
    },
  },

  {
    name: "apply_migration",
    description:
      "Apply a named DDL migration. The SQL runs in a transaction, is recorded in the migrations ledger (name, SQL, who, when), and PostgREST's schema cache is reloaded afterwards. Use this for ALL schema changes instead of execute_sql. Names must be snake_case and unique (e.g. add_orders_table). Note: statements that cannot run in a transaction (CREATE INDEX CONCURRENTLY, VACUUM) are not supported here.",
    scope: "db:ddl",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Unique snake_case migration name." },
        sql: { type: "string", description: "The DDL to apply." },
        confirm_token: {
          type: "string",
          description: "Echo of the token returned when a destructive migration needs confirmation.",
        },
      },
      required: ["name", "sql"],
    },
    handler: async (args, ctx) => {
      const name = String(args.name ?? "").trim();
      const sql = String(args.sql ?? "").trim();
      if (!MIGRATION_NAME.test(name)) {
        return { text: "Migration name must match ^[a-z][a-z0-9_]{0,62}$", isError: true };
      }
      if (!sql) return { text: "sql is required", isError: true };

      const blocked = touchesProtectedObjects(sql);
      if (blocked) {
        return { text: `Refused: migrations may not touch ${blocked}`, isError: true };
      }
      const reason = looksDestructive(sql);
      if (reason) {
        const token = typeof args.confirm_token === "string" ? args.confirm_token : "";
        if (!token || !verifyConfirmToken(sql, token)) {
          return { text: confirmationRequest(reason, sql) };
        }
      }

      const client = await pool().connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          `INSERT INTO _dashboard.migrations (name, sql, applied_by, token_id)
           VALUES ($1, $2, $3, $4)`,
          [name, sql, ctx.auth.email, ctx.auth.tokenId],
        );
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        const err = e as { message?: string; code?: string };
        if (err.code === "23505") {
          return { text: `A migration named "${name}" already exists — pick a new name.`, isError: true };
        }
        throw e;
      } finally {
        client.release();
      }

      // Best-effort schema-cache reload; the migration itself already
      // committed. See reload_postgrest_schema for the caveat.
      await pool().query(`NOTIFY pgrst, 'reload schema'`).catch(() => {});

      return {
        text: `Migration "${name}" applied and recorded. PostgREST schema reload was requested — if /rest/v1 doesn't reflect the change, the postgrest container may need a restart (its NOTIFY listener is disabled when running behind PgBouncer).`,
      };
    },
  },

  {
    name: "list_migrations",
    description: "List migrations applied through apply_migration (the MCP migration ledger).",
    scope: "db:read",
    readOnly: true,
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const { rows } = await pool().query(
        `SELECT id, name, applied_at, applied_by FROM _dashboard.migrations ORDER BY id`,
      );
      return { text: JSON.stringify(rows, null, 1) };
    },
  },

  {
    name: "generate_typescript_types",
    description:
      "Generate TypeScript types (Row/Insert/Update per table, plus enums) for the given schemas from live database introspection. Default schema: public.",
    scope: "db:read",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        schemas: { type: "array", items: { type: "string" }, description: "Defaults to [\"public\"]." },
      },
    },
    handler: async (args) => {
      const schemas = requestedSchemas(args).filter((s) => s !== "auth");
      return { text: await generateTypescriptTypes(schemas) };
    },
  },

  {
    name: "reload_postgrest_schema",
    description:
      "Ask PostgREST to reload its schema cache (needed after DDL before new tables/columns appear under /rest/v1). Sends NOTIFY pgrst.",
    scope: "db:write",
    readOnly: false,
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      await pool().query(`NOTIFY pgrst, 'reload schema'`);
      return {
        text: "NOTIFY pgrst sent. Caveat: this instance may run PostgREST with PGRST_DB_CHANNEL_ENABLED=false (required behind PgBouncer transaction pooling), in which case the listener is off and a `docker compose restart postgrest` is needed instead.",
      };
    },
  },
];
