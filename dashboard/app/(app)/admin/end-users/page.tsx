import { pool } from "@/lib/db";
import { Card } from "../../_components/Card";
import { disableEndUser, enableEndUser } from "./actions";
import { CreateMenu } from "./_components/CreateMenu";
import { DeleteUserButton } from "./_components/DeleteUserButton";
import { PasswordResetModal } from "./_components/PasswordResetModal";

const PAGE_SIZE = 50;

type Row = {
  id: string;
  email: string;
  email_verified_at: Date | null;
  created_at: Date;
  last_sign_in_at: Date | null;
  disabled_at: Date | null;
  providers: string[];
  active_sessions: number;
};

type SearchParams = {
  q?: string;
  status?: string;
  page?: string;
  error?: string;
  ok?: string;
};

function buildWhere(filters: { q?: string; status?: string }) {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filters.q) {
    params.push(`%${filters.q.toLowerCase()}%`);
    conds.push(`lower(u.email) LIKE $${params.length}`);
  }
  if (filters.status === "active") conds.push("u.disabled_at IS NULL");
  if (filters.status === "disabled") conds.push("u.disabled_at IS NOT NULL");
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  return { where, params };
}

async function loadCount(where: string, params: unknown[]): Promise<number> {
  const { rows } = await pool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM auth.users u ${where}`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}

async function loadRows(
  where: string,
  params: unknown[],
  limit: number,
  offset: number,
): Promise<Row[]> {
  const { rows } = await pool().query<Row>(
    `SELECT u.id, u.email, u.email_verified_at, u.created_at,
            u.last_sign_in_at, u.disabled_at,
            COALESCE(
              ARRAY(SELECT DISTINCT provider FROM auth.identities WHERE user_id = u.id ORDER BY provider),
              ARRAY[]::text[]
            ) AS providers,
            COALESCE(
              (SELECT count(*) FROM auth.sessions
                 WHERE user_id = u.id
                   AND revoked_at IS NULL
                   AND expires_at > now()),
              0
            )::int AS active_sessions
       FROM auth.users u
       ${where}
       ORDER BY u.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  return rows;
}

function formatTime(d: Date | string | null): string {
  if (!d) return "—";
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().replace("T", " ").slice(0, 19);
}

export default async function EndUsersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const filters = {
    q: sp.q?.trim() ?? "",
    status:
      sp.status === "active" || sp.status === "disabled" ? sp.status : "",
  };
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const { where, params } = buildWhere(filters);
  const [total, rows] = await Promise.all([
    loadCount(where, params),
    loadRows(where, params, PAGE_SIZE, offset),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + rows.length, total);

  return (
    <main className="px-6 py-10">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">End users</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Application end-user accounts. These are separate from dashboard
            operators — they sign in via{" "}
            <span className="font-mono">/auth/v1/*</span> and hit the API with JWTs.
          </p>
        </div>
        <CreateMenu />
      </div>

      {sp.error && (
        <p className="mt-3 rounded border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">
          {sp.error}
        </p>
      )}
      {sp.ok && (
        <p className="mt-3 rounded border border-emerald-900/50 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-300">
          {sp.ok}
        </p>
      )}

      <Card padded className="mt-6">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wider text-neutral-500">
              Email contains
            </span>
            <input
              type="text"
              name="q"
              defaultValue={filters.q}
              placeholder="search…"
              className="w-64 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wider text-neutral-500">
              Status
            </span>
            <select
              name="status"
              defaultValue={filters.status}
              className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm"
            >
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="disabled">Disabled</option>
            </select>
          </label>
          <div className="flex gap-2">
            <button
              type="submit"
              className="rounded border border-neutral-700 bg-neutral-800 px-3 py-1 text-sm hover:bg-neutral-700"
            >
              Apply
            </button>
            <a
              href="?"
              className="rounded border border-neutral-700 px-3 py-1 text-sm hover:bg-neutral-800"
            >
              Clear
            </a>
          </div>
        </form>
      </Card>

      <Card className="mt-6 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-700 bg-neutral-800/60 text-left text-neutral-400">
              <th className="px-3 py-2 font-normal">Email</th>
              <th className="px-3 py-2 font-normal">Providers</th>
              <th className="px-3 py-2 font-normal">Status</th>
              <th className="px-3 py-2 font-normal">Last sign-in</th>
              <th className="px-3 py-2 font-normal">Created</th>
              <th className="px-3 py-2 font-normal text-right">Sessions</th>
              <th className="px-3 py-2 font-normal" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-neutral-500">
                  No users.
                </td>
              </tr>
            ) : (
              rows.map((u) => (
                <tr
                  key={u.id}
                  className="border-b border-neutral-800 last:border-b-0 odd:bg-neutral-900 even:bg-neutral-950/40 hover:bg-neutral-800/50"
                >
                  <td className="px-3 py-2 font-mono text-neutral-200">
                    {u.email}
                  </td>
                  <td className="px-3 py-2 text-neutral-400">
                    {u.providers.length === 0
                      ? "—"
                      : u.providers.join(", ")}
                  </td>
                  <td className="px-3 py-2">
                    {u.disabled_at ? (
                      <span className="text-amber-400">disabled</span>
                    ) : (
                      <span className="text-emerald-400">active</span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-neutral-500">
                    {formatTime(u.last_sign_in_at)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-neutral-500">
                    {formatTime(u.created_at)}
                  </td>
                  <td className="px-3 py-2 text-right text-neutral-400">
                    {u.active_sessions}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap justify-end gap-3">
                      <form
                        action={u.disabled_at ? enableEndUser : disableEndUser}
                        className="inline"
                      >
                        <input type="hidden" name="id" value={u.id} />
                        <button
                          type="submit"
                          className="text-xs text-neutral-400 underline hover:text-neutral-100"
                        >
                          {u.disabled_at ? "Enable" : "Disable"}
                        </button>
                      </form>
                      <PasswordResetModal id={u.id} email={u.email} />
                      <DeleteUserButton id={u.id} email={u.email} />
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>

      <nav className="mt-4 flex items-center justify-between text-sm text-neutral-400">
        <span>
          {from}–{to} of {total.toLocaleString()}
        </span>
        <div className="flex gap-2">
          {page > 1 && (
            <a
              href={pageHref(page - 1, filters)}
              className="rounded border border-neutral-700 px-2 py-1 hover:bg-neutral-800"
            >
              ← Prev
            </a>
          )}
          <span className="px-2 py-1 text-neutral-500">
            Page {page} of {totalPages}
          </span>
          {page < totalPages && (
            <a
              href={pageHref(page + 1, filters)}
              className="rounded border border-neutral-700 px-2 py-1 hover:bg-neutral-800"
            >
              Next →
            </a>
          )}
        </div>
      </nav>
    </main>
  );
}

function pageHref(
  page: number,
  filters: { q?: string; status?: string },
): string {
  const p = new URLSearchParams();
  if (filters.q) p.set("q", filters.q);
  if (filters.status) p.set("status", filters.status);
  if (page > 1) p.set("page", String(page));
  const qs = p.toString();
  return qs ? `?${qs}` : "?";
}
