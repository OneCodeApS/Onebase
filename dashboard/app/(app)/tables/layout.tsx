import { pool } from "@/lib/db";
import { TablesSidebar, type TableEntry } from "./_components/TablesSidebar";
import { getSession } from "@/lib/session";

// System schemas enforce invariants (audit hash chain, AES-GCM env vars,
// Argon2 password hashing). The dashboard hides them from read_only users
// entirely — they have no business poking at audit rows or session tokens
// even read-side. Admin and read_write can opt in via the sidebar toggle.
const SYSTEM_SCHEMAS = new Set(["_dashboard", "auth"]);

// Loads tables across every non-system schema in one shot. The sidebar
// filters them client-side by the active `?schema=` param, so navigating
// between schemas doesn't refetch.
async function loadTables(): Promise<TableEntry[]> {
  const { rows } = await pool().query<TableEntry>(
    `SELECT n.nspname              AS schema,
            c.relname              AS table_name,
            c.reltuples::bigint    AS approx_rows
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
        AND n.nspname NOT LIKE 'pg_temp%'
      ORDER BY n.nspname, c.relname`,
  );
  return rows;
}

export default async function TablesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  const canViewSystemSchemas = session.role !== "read_only";
  const allTables = await loadTables();
  const tables = canViewSystemSchemas
    ? allTables
    : allTables.filter((t) => !SYSTEM_SCHEMAS.has(t.schema));
  return (
    // h-full + overflow-hidden pins this layout to the app shell's <main>
    // viewport, so the sidebar's table list and the table content scroll
    // independently instead of growing the document.
    <div className="flex h-full overflow-hidden">
      <TablesSidebar
        tables={tables}
        canViewSystemSchemas={canViewSystemSchemas}
      />
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
