import Link from "next/link";
import { getSession } from "@/lib/session";
import { formatBytes, getDashboardStats } from "@/lib/stats";
import { Card } from "./_components/Card";

function StatCard({
  href,
  label,
  value,
  hint,
}: {
  href?: string;
  label: string;
  value: string | number;
  hint?: string;
}) {
  const body = (
    <Card padded className="h-full">
      <div className="text-xs uppercase tracking-wider text-neutral-500">
        {label}
      </div>
      <div className="mt-1 font-mono text-2xl text-neutral-100">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-neutral-500">{hint}</div>}
    </Card>
  );
  if (!href) return body;
  return (
    <Link href={href} className="block transition hover:brightness-110">
      {body}
    </Link>
  );
}

export default async function Home() {
  const session = await getSession();
  const isAdmin = session.role === "admin";
  const stats = await getDashboardStats(isAdmin);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-2xl font-semibold">Welcome</h1>
      <p className="mt-2 text-neutral-400">
        Signed in as{" "}
        <span className="font-mono text-neutral-100">{session.email}</span>{" "}
        <span className="text-neutral-500">({session.role})</span>.
      </p>

      <h2 className="mt-10 text-sm font-medium uppercase tracking-wider text-neutral-500">
        Resources
      </h2>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <StatCard
          href="/tables"
          label="Tables"
          value={stats.tables}
          hint="in public schema"
        />
        <StatCard
          href="/storage"
          label="Storage buckets"
          value={stats.buckets}
          hint={`${stats.minio.objects} object${stats.minio.objects === 1 ? "" : "s"} · ${formatBytes(stats.minio.bytes)}`}
        />
        {isAdmin && stats.admin && (
          <>
            <StatCard
              href="/admin/functions"
              label="Edge functions"
              value={`${stats.admin.functions.enabled} / ${stats.admin.functions.total}`}
              hint="enabled / total"
            />
            <StatCard
              href="/admin/cron"
              label="Cron jobs"
              value={`${stats.admin.cron.enabled} / ${stats.admin.cron.total}`}
              hint="enabled / total"
            />
            <StatCard
              href="/admin/end-users"
              label="End users"
              value={`${stats.admin.endUsers.active} / ${stats.admin.endUsers.total}`}
              hint="active / total"
            />
            <StatCard
              href="/admin/audit"
              label="Audit log rows"
              value={stats.admin.auditRows.toLocaleString()}
            />
          </>
        )}
      </div>

      {isAdmin && stats.admin && (
        <>
          <h2 className="mt-10 text-sm font-medium uppercase tracking-wider text-neutral-500">
            Server capacity used
          </h2>
          <p className="mt-1 text-xs text-neutral-500">
            How much each subsystem is currently consuming. Pruning audit rows
            (Settings → Logs) shrinks the database; deleting objects shrinks storage.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard
              label="Database"
              value={formatBytes(stats.admin.dbBytes)}
              hint={`audit_log: ${formatBytes(stats.admin.auditTableBytes)}`}
            />
            <StatCard
              label="Object storage"
              value={formatBytes(stats.minio.bytes)}
              hint={`${stats.minio.objects} object${stats.minio.objects === 1 ? "" : "s"} across ${stats.buckets} bucket${stats.buckets === 1 ? "" : "s"}`}
            />
            <StatCard
              label="Audit files"
              value={formatBytes(stats.admin.auditFilesBytes)}
              hint={`${stats.admin.auditFilesCount} JSONL file${stats.admin.auditFilesCount === 1 ? "" : "s"} on disk`}
            />
          </div>
        </>
      )}

      {isAdmin && stats.admin && (
        <>
          <h2 className="mt-10 text-sm font-medium uppercase tracking-wider text-neutral-500">
            Database health
          </h2>
          <p className="mt-1 text-xs text-neutral-500">
            Live snapshot from{" "}
            <span className="font-mono">pg_stat_activity</span> and{" "}
            <span className="font-mono">pg_stat_database</span>. Refreshes when
            you reload this page.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard
              label="Connections"
              value={`${stats.admin.dbHealth.connections.total} / ${stats.admin.dbHealth.connections.max}`}
              hint={`${stats.admin.dbHealth.connections.active} active · ${stats.admin.dbHealth.connections.idle} idle`}
            />
            <CacheHitCard ratio={stats.admin.dbHealth.cacheHitRatio} />
            <LongestQueryCard
              seconds={stats.admin.dbHealth.longestActiveSeconds}
              query={stats.admin.dbHealth.longestActiveQuery}
            />
          </div>
        </>
      )}

      <p className="mt-10 text-sm text-neutral-500">
        Use the sidebar to browse tables, manage users, or open settings.
      </p>
    </main>
  );
}

function CacheHitCard({ ratio }: { ratio: number | null }) {
  if (ratio === null) {
    return (
      <Card padded className="h-full">
        <div className="text-xs uppercase tracking-wider text-neutral-500">
          Cache hit ratio
        </div>
        <div className="mt-1 font-mono text-2xl text-neutral-500">—</div>
        <div className="mt-0.5 text-xs text-neutral-500">No reads yet</div>
      </Card>
    );
  }
  const pct = ratio * 100;
  const color =
    pct >= 99
      ? "text-emerald-400"
      : pct >= 95
        ? "text-amber-400"
        : "text-red-400";
  const verdict =
    pct >= 99
      ? "healthy"
      : pct >= 95
        ? "warming up or under-sized cache"
        : "high disk pressure — consider more RAM";
  return (
    <Card padded className="h-full">
      <div className="text-xs uppercase tracking-wider text-neutral-500">
        Cache hit ratio
      </div>
      <div className={`mt-1 font-mono text-2xl ${color}`}>{pct.toFixed(2)}%</div>
      <div className="mt-0.5 text-xs text-neutral-500">{verdict}</div>
    </Card>
  );
}

function LongestQueryCard({
  seconds,
  query,
}: {
  seconds: number | null;
  query: string | null;
}) {
  if (seconds === null) {
    return (
      <Card padded className="h-full">
        <div className="text-xs uppercase tracking-wider text-neutral-500">
          Longest active query
        </div>
        <div className="mt-1 font-mono text-2xl text-emerald-400">—</div>
        <div className="mt-0.5 text-xs text-neutral-500">Nothing running</div>
      </Card>
    );
  }
  const color =
    seconds >= 30
      ? "text-red-400"
      : seconds >= 5
        ? "text-amber-400"
        : "text-emerald-400";
  const display =
    seconds < 1
      ? `${(seconds * 1000).toFixed(0)}ms`
      : seconds < 60
        ? `${seconds.toFixed(1)}s`
        : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return (
    <Card padded className="h-full">
      <div className="text-xs uppercase tracking-wider text-neutral-500">
        Longest active query
      </div>
      <div className={`mt-1 font-mono text-2xl ${color}`}>{display}</div>
      <div
        className="mt-0.5 truncate font-mono text-xs text-neutral-500"
        title={query ?? ""}
      >
        {query ?? "—"}
      </div>
    </Card>
  );
}
