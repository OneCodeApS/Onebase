import { promises as fs } from "node:fs";
import path from "node:path";
import { pool } from "./db";
import { minio } from "./minio";

// Public-facing stats. Cheap counts only — object-storage usage is NOT in here
// because measuring it means walking every key in every bucket. That lives in
// getStorageUsage() below, which the page renders behind its own <Suspense>.
export type PublicStats = {
  tables: number;
  buckets: number;
};

// Object-storage usage. `partial` is true when the walk hit MAX_SCAN_OBJECTS
// and stopped, in which case the numbers are a floor, not a total.
export type StorageUsage = {
  objects: number;
  bytes: number;
  partial: boolean;
};

// Admin-only stats. Cheap counts plus the capacity section.
export type AdminStats = {
  functions: { total: number; enabled: number };
  cron: { total: number; enabled: number };
  endUsers: { total: number; active: number };
  auditRows: number;
  dbBytes: number;
  auditTableBytes: number;
  auditFilesBytes: number;
  auditFilesCount: number;
  dbHealth: DbHealth;
};

// Live Postgres health snapshot. All values are cheap reads of pg_stat_*.
export type DbHealth = {
  connections: { active: number; idle: number; total: number; max: number };
  cacheHitRatio: number | null; // 0..1, null when DB has no read traffic yet
  longestActiveSeconds: number | null;
  longestActiveQuery: string | null;
};

export type DashboardStats = PublicStats & { admin?: AdminStats };

async function countTables(): Promise<number> {
  const { rows } = await pool().query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'`,
  );
  return Number(rows[0]?.n ?? 0);
}

async function countBuckets(): Promise<number> {
  try {
    return (await minio.listBuckets()).length;
  } catch (e) {
    console.error("[stats] failed listing buckets", e);
    return 0;
  }
}

// Measuring object-storage usage means listing every key in every bucket —
// there is no S3 call that reports it. On an install with hundreds of thousands
// of objects the old unbounded walk ran on every dashboard render and blocked
// the whole page behind it. Two bounds now apply: the walk stops after
// MAX_SCAN_OBJECTS keys (reporting `partial`), and the result is cached for
// CACHE_TTL_MS so a page reload doesn't re-walk. Both are advisory numbers on a
// stat card, so a few minutes of staleness costs nothing.
const MAX_SCAN_OBJECTS = Number(process.env.STORAGE_STATS_MAX_OBJECTS ?? 50_000);
const CACHE_TTL_MS = Number(process.env.STORAGE_STATS_TTL_SECONDS ?? 300) * 1000;

declare global {
  // eslint-disable-next-line no-var
  var __storageUsage:
    | { at: number; value: StorageUsage }
    | undefined;
  // eslint-disable-next-line no-var
  var __storageUsageInflight: Promise<StorageUsage> | undefined;
}

async function scanStorageUsage(): Promise<StorageUsage> {
  let objects = 0;
  let bytes = 0;
  let partial = false;

  try {
    for (const b of await minio.listBuckets()) {
      if (objects >= MAX_SCAN_OBJECTS) {
        partial = true;
        break;
      }
      try {
        let token = "";
        for (;;) {
          // Flat listing (no delimiter) one S3 page at a time, so the loop can
          // stop at the cap instead of draining the whole bucket.
          const res = await minio.listObjectsV2Query(b.name, "", token, "", 1000, "");
          for (const o of res.objects) {
            objects += 1;
            bytes += o.size ?? 0;
          }
          if (objects >= MAX_SCAN_OBJECTS) {
            partial = partial || res.isTruncated;
            break;
          }
          if (!res.isTruncated || !res.nextContinuationToken) break;
          token = String(res.nextContinuationToken);
        }
      } catch (e) {
        // One bad bucket shouldn't sink the whole page. Log and move on.
        console.error(`[stats] failed listing bucket ${b.name}`, e);
      }
    }
  } catch (e) {
    console.error("[stats] failed listing buckets", e);
  }

  return { objects, bytes, partial };
}

// Cached, deduplicated storage usage. Concurrent callers share one walk.
export async function getStorageUsage(): Promise<StorageUsage> {
  const cached = globalThis.__storageUsage;
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  if (globalThis.__storageUsageInflight) return globalThis.__storageUsageInflight;

  const run = scanStorageUsage()
    .then((value) => {
      globalThis.__storageUsage = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      globalThis.__storageUsageInflight = undefined;
    });

  globalThis.__storageUsageInflight = run;
  return run;
}

async function getAuditFileStats(): Promise<{ bytes: number; count: number }> {
  const root = process.env.AUDIT_LOG_DIR ?? "/audit";
  let bytes = 0;
  let count = 0;
  try {
    // The dashboard creates one subdir under root and one JSONL file per day
    // inside it. Walk both levels; ignore anything that doesn't look like
    // our naming scheme so a misconfigured mount doesn't inflate the number.
    const subdirs = await fs.readdir(root, { withFileTypes: true });
    for (const sd of subdirs) {
      if (!sd.isDirectory()) continue;
      const dir = path.join(root, sd.name);
      let files: string[] = [];
      try {
        files = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!/^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
        try {
          const st = await fs.stat(path.join(dir, f));
          bytes += st.size;
          count += 1;
        } catch {
          // File may have rotated between readdir and stat — ignore.
        }
      }
    }
  } catch {
    // Audit dir missing on a fresh install. Zero is the right answer.
  }
  return { bytes, count };
}

async function getCounts() {
  const [fns, cron, endUsers, audit] = await Promise.all([
    pool().query<{ total: string; enabled: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE enabled)::text AS enabled
         FROM _dashboard.functions`,
    ),
    pool().query<{ total: string; enabled: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE enabled)::text AS enabled
         FROM _dashboard.cron_jobs`,
    ),
    pool().query<{ total: string; active: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE disabled_at IS NULL)::text AS active
         FROM auth.users`,
    ),
    pool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM _dashboard.audit_log`,
    ),
  ]);

  return {
    functions: {
      total: Number(fns.rows[0]?.total ?? 0),
      enabled: Number(fns.rows[0]?.enabled ?? 0),
    },
    cron: {
      total: Number(cron.rows[0]?.total ?? 0),
      enabled: Number(cron.rows[0]?.enabled ?? 0),
    },
    endUsers: {
      total: Number(endUsers.rows[0]?.total ?? 0),
      active: Number(endUsers.rows[0]?.active ?? 0),
    },
    auditRows: Number(audit.rows[0]?.n ?? 0),
  };
}

async function getDbHealth(): Promise<DbHealth> {
  // pg_stat_activity gives per-session state; pg_stat_database gives cumulative
  // block hit/read counts since stats reset (typically DB start). Both views
  // require pg_read_all_stats to be readable across all roles — granted to
  // dashboard_admin in postgres/init/02_roles.sql and migration 0013.
  const [conns, cache, longest, max] = await Promise.all([
    pool().query<{ active: string; idle: string; total: string }>(
      `SELECT
         count(*) FILTER (WHERE state = 'active')::text AS active,
         count(*) FILTER (WHERE state = 'idle')::text   AS idle,
         count(*)::text                                  AS total
       FROM pg_stat_activity
       WHERE backend_type = 'client backend'`,
    ),
    pool().query<{ hit: string | null; read: string | null }>(
      `SELECT sum(blks_hit)::text  AS hit,
              sum(blks_read)::text AS read
         FROM pg_stat_database
        WHERE datname = current_database()`,
    ),
    pool().query<{ seconds: string | null; query: string | null }>(
      `SELECT EXTRACT(EPOCH FROM (now() - query_start))::text AS seconds,
              query
         FROM pg_stat_activity
        WHERE state = 'active'
          AND backend_type = 'client backend'
          AND query NOT ILIKE '%pg_stat_activity%'
        ORDER BY query_start ASC
        LIMIT 1`,
    ),
    pool().query<{ max: string }>("SHOW max_connections"),
  ]);

  const hit = Number(cache.rows[0]?.hit ?? 0);
  const read = Number(cache.rows[0]?.read ?? 0);
  const ratio = hit + read > 0 ? hit / (hit + read) : null;

  const longestSeconds = longest.rows[0]?.seconds
    ? Number(longest.rows[0].seconds)
    : null;
  const longestQuery = longest.rows[0]?.query ?? null;

  return {
    connections: {
      active: Number(conns.rows[0]?.active ?? 0),
      idle: Number(conns.rows[0]?.idle ?? 0),
      total: Number(conns.rows[0]?.total ?? 0),
      max: Number(max.rows[0]?.max ?? 0),
    },
    cacheHitRatio: ratio,
    longestActiveSeconds: longestSeconds,
    longestActiveQuery: longestQuery,
  };
}

async function getCapacity() {
  const [db, auditTbl, auditFiles] = await Promise.all([
    pool().query<{ bytes: string }>(
      "SELECT pg_database_size(current_database())::text AS bytes",
    ),
    pool().query<{ bytes: string }>(
      "SELECT pg_total_relation_size('_dashboard.audit_log')::text AS bytes",
    ),
    getAuditFileStats(),
  ]);

  return {
    dbBytes: Number(db.rows[0]?.bytes ?? 0),
    auditTableBytes: Number(auditTbl.rows[0]?.bytes ?? 0),
    auditFilesBytes: auditFiles.bytes,
    auditFilesCount: auditFiles.count,
  };
}

export async function getDashboardStats(isAdmin: boolean): Promise<DashboardStats> {
  if (!isAdmin) {
    const [tables, buckets] = await Promise.all([countTables(), countBuckets()]);
    return { tables, buckets };
  }

  const [tables, buckets, counts, capacity, dbHealth] = await Promise.all([
    countTables(),
    countBuckets(),
    getCounts(),
    getCapacity(),
    getDbHealth(),
  ]);

  return {
    tables,
    buckets,
    admin: {
      ...counts,
      ...capacity,
      dbHealth,
    },
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 4).toFixed(2)} TB`;
}
