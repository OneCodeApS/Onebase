import { pool } from "./db";

// Configurable, DB-backed rate limiting for the public auth endpoints. Config
// lives in _dashboard.rate_limits (admin-editable at /admin/rate-limits); the
// counter is taken atomically by the _dashboard.rate_limit_take() SQL function,
// so a limit holds across ALL dashboard replicas — a per-process in-memory
// counter would let an attacker multiply the limit by spreading attempts over
// the replicas Caddy round-robins across.

export type RateLimitConfig = {
  area: string;
  max_attempts: number;
  window_seconds: number;
  enabled: boolean;
};

// Fallback if a config row is missing (e.g. a new area added in code before its
// seed row exists). Keep in sync with the seeds in 13_rate_limits.sql.
const DEFAULTS: Record<string, { max_attempts: number; window_seconds: number }> = {
  signin: { max_attempts: 10, window_seconds: 300 },
  signup: { max_attempts: 5, window_seconds: 3600 },
  magiclink: { max_attempts: 10, window_seconds: 600 },
  // Keyed per user id, not per IP — PUT /auth/v1/user is authenticated, so the
  // account is the meaningful subject, and an office behind one egress IP must
  // not burn through each other's budget.
  password_update: { max_attempts: 5, window_seconds: 900 },
};

// Small per-process cache so we don't read config on every attempt. Config
// changes rarely; a few seconds of staleness is fine, and updateRateLimit()
// busts it locally.
type Cached = { at: number; map: Map<string, RateLimitConfig> };
const CACHE_TTL_MS = 5_000;
const g = globalThis as unknown as { __rateLimitCache?: Cached };

async function loadConfig(): Promise<Map<string, RateLimitConfig>> {
  const now = Date.now();
  if (g.__rateLimitCache && now - g.__rateLimitCache.at < CACHE_TTL_MS) {
    return g.__rateLimitCache.map;
  }
  const map = new Map<string, RateLimitConfig>();
  try {
    const { rows } = await pool().query<RateLimitConfig>(
      `SELECT area, max_attempts, window_seconds, enabled FROM _dashboard.rate_limits`,
    );
    for (const r of rows) map.set(r.area, r);
  } catch {
    // table missing / transient DB issue — callers fall back to DEFAULTS
  }
  g.__rateLimitCache = { at: now, map };
  return map;
}

export type RateLimitResult = { ok: boolean; retryAfter: number };

// Record one attempt for (area, identifier) and report whether it's allowed.
// Fails OPEN (allows) on any limiter error — a transient DB hiccup must not
// lock every user out of signing in.
export async function checkRateLimit(
  area: string,
  identifier: string,
): Promise<RateLimitResult> {
  const cfg =
    (await loadConfig()).get(area) ??
    ({
      area,
      enabled: true,
      ...(DEFAULTS[area] ?? { max_attempts: 30, window_seconds: 60 }),
    } as RateLimitConfig);

  if (!cfg.enabled) return { ok: true, retryAfter: 0 };

  try {
    const { rows } = await pool().query<{ allowed: boolean }>(
      `SELECT _dashboard.rate_limit_take($1, $2, $3) AS allowed`,
      [`${area}:${identifier}`, cfg.max_attempts, cfg.window_seconds],
    );
    const allowed = rows[0]?.allowed ?? true;
    return { ok: allowed, retryAfter: allowed ? 0 : cfg.window_seconds };
  } catch {
    return { ok: true, retryAfter: 0 };
  }
}

// --- admin config management (Admin → Rate limits) ---

export async function listRateLimits(): Promise<RateLimitConfig[]> {
  const { rows } = await pool().query<RateLimitConfig>(
    `SELECT area, max_attempts, window_seconds, enabled
       FROM _dashboard.rate_limits
      ORDER BY area`,
  );
  return rows;
}

export async function updateRateLimit(
  area: string,
  input: { max_attempts: number; window_seconds: number; enabled: boolean },
  updatedBy: string | null,
): Promise<void> {
  await pool().query(
    `UPDATE _dashboard.rate_limits
        SET max_attempts = $2, window_seconds = $3, enabled = $4,
            updated_by = $5, updated_at = now()
      WHERE area = $1`,
    [area, input.max_attempts, input.window_seconds, input.enabled, updatedBy],
  );
  g.__rateLimitCache = undefined; // bust the local cache immediately
}

// Drop stale counter rows. Called from the daily maintenance sweep so the
// hits table doesn't grow unbounded with one row per (area, IP) ever seen.
export async function pruneRateLimitHits(): Promise<void> {
  await pool().query(
    `DELETE FROM _dashboard.rate_limit_hits WHERE window_start < now() - interval '1 day'`,
  );
}
