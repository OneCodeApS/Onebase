# TODOs

Open items surfaced during recent work but deferred. Not a backlog of features — only items where we made an explicit "park it for now" call and where future-me (or future-you) should know it's known.

Sorted roughly by when it bites, not by effort.

---

## Hits first under sustained load

### Audit chain advisory lock
`lib/audit.ts` serialises inserts with `pg_advisory_xact_lock(CHAIN_LOCK_KEY)` so the SHA-256 chain is well-defined. Caps audited writes at roughly **500/sec**.

- **Hits when:** sustained logins + edge-function invocations + SQL editor activity together push audit throughput past that. Likely the first real ceiling once end-user auth is in production traffic.
- **Options when needed:**
  1. Drop the lock; compute `prev_hash` from a small in-process buffer and flush asynchronously. Chain remains intact but writes don't serialise.
  2. Shard the chain by actor or by hour — multiple parallel chains, verified independently.
  3. Drop the chain altogether and rely on the JSONL files for tamper evidence.
- **Note:** every option weakens the current "any row tampered with after the fact is detectable" guarantee somewhat. Discuss before touching.

### Single dashboard process
`instrumentation.ts` boots the cron scheduler and the audit-retention sweeper in-process. Running two dashboard replicas behind Caddy would double-fire both.

- **Hits when:** we want horizontal scaling for throughput or HA.
- **Fix:** extract scheduler + sweeper into either (a) a dedicated worker container, or (b) a leader-elect pattern using a Postgres session-level advisory lock so only one replica's scheduler is "active" at a time.
- **Also needed before this works:** the edge-function compile cache (`globalThis.__fnCompileCache`) is per-process. Multi-instance means each replica compiles its own copy — fine, just understand the memory cost scales with replicas.

### MinIO walk on every Home load
`lib/stats.ts:getMinioStats()` lists every object in every bucket on every Home page render. Fine to ~10k objects, sluggish at 100k+, painful at 1M+.

- **Hits when:** the storage layer actually has tens of thousands of objects.
- **Cheap fix:** cache the result in `globalThis` with a 60s TTL, refreshed in the background.
- **Better fix:** wrap the capacity section in a `<Suspense>` boundary so resource counts paint immediately and capacity streams in.

---

## Auth follow-ups (from the verify_jwt rollout)

### CORS on `/functions/v1/*`
Edge functions accept JWTs but don't set CORS headers. The `lib/cors.ts` helper now used by `/auth/v1/*` is ready — function invocation routes just need to be wrapped with `withCors(handler, { methods: ["GET", "POST", ...] })` and export an `OPTIONS = corsPreflight(...)`. Per-function origin overrides (a `cors_origins` column on `_dashboard.functions`) can layer on top later if a single global allowlist isn't enough.

### Storage: resumable uploads (TUS / S3 multipart)
Single-PUT presigned URLs work up to S3's per-object limit but can't resume on connection drop. Two options when this becomes a real problem:
  - **S3 multipart via presigned URLs** — `POST /storage/v1/object/multipart/<bucket>/<key>` returns `upload_id` + N presigned part URLs. Client PUTs ~5 MB chunks in parallel; failed parts retried individually; `.../complete` tells MinIO to assemble. MinIO supports this natively.
  - **TUS protocol** — Supabase's path. Server runs `tus-node-server`, client uses `tus-js-client`. The chunks would need to go through Node (TUS isn't an S3 protocol), so this gives up the "no Node in byte path" property — only worth it if the upload-resume UX matters more than the bandwidth cost.

### Storage: per-bucket ACL beyond visibility
The dashboard issues SigV4 URLs to any caller with an `authenticated` or `service_role` JWT — no per-bucket or per-object check beyond visibility. Once buckets need ownership-aware reads, add either:
  - A `_dashboard.bucket_acl` table (bucket × role × perm), checked inside the sign / upload route handlers before minting the URL.
  - Or a `_dashboard.storage_objects` table mirroring object → owner, with RLS policies against it (Supabase pattern; tracks objects in Postgres for free, but doubles writes per upload via MinIO bucket-notification events).

### Storage: fetch-time audit via MinIO notifications
URL issuance is audited via the server actions on the bucket UI, but the new public proxy routes (`/sign`, `/sign-batch`, `/upload`) write no audit rows yet — and MinIO data-plane fetches never touch the dashboard, so they're invisible to `_dashboard.audit_log`. Two fixes:
  - **Issuance audit** — `await audit({...})` inside the sign/upload route handlers. Easy. Captures "user X requested a URL for bucket/key" but not whether it was used.
  - **Fetch audit via MinIO webhooks** — `mc admin config set minio notify_webhook:audit endpoint=http://dashboard:3000/_internal/storage-events`; MinIO POSTs an event per S3 op (`s3:ObjectCreated:Put`, `s3:ObjectAccessed:Get`, `s3:ObjectRemoved:Delete`) with bucket / key / IP / status / size. Dashboard verifies a shared-secret header, writes via `lib/audit.ts`. Authoritative — catches what actually happened. User identity isn't recoverable from MinIO alone; correlate by issuance row + bucket/key/time if needed.

### Storage: reserved bucket names
Caddy routes `/storage/v1/object/sign/*`, `/sign-batch`, `/upload/*` to the dashboard before the strip-and-forward to MinIO. A bucket literally named `sign`, `sign-batch`, or `upload` is unreachable as a result. Add those to the bucket-name validation in `app/(app)/storage/actions.ts:BUCKET_NAME` to fail early.

### Per-function role policy
`verify_jwt` is binary today: any signed JWT works (anon / authenticated / service_role). For most functions an admin probably wants more: "only authenticated users, not anon" or "service_role only".

- **Fix:** add a `min_role` column (`anon` / `authenticated` / `service_role`), enforced in the HTTP route. Function code stops needing the `if (ctx.user?.role === "anon") return 401` boilerplate.

### Key rotation runbook
The `/admin/api-keys` page tells you "rotating PGRST_JWT_SECRET invalidates everything" but doesn't give a procedure. Worth a short doc — when to rotate, the actual command sequence, what gets signed out, expected downtime.

### Function-level audit search
Failed JWT attempts get audited (`success=false`, `metadata.error: 'invalid_token' | 'missing_token'`). The invocations page shows them but there's no easy way to ask "show me all 401s for `foo` in the last hour" — useful when something's misbehaving.

- **Fix:** add status / error filters to `/admin/functions/[name]/invocations`. Or just a "failed only" toggle.

### PostgREST schema-cache reload button
Now doubly relevant: `verify_jwt` checks happen in the dashboard, but the underlying tables PostgREST exposes also need its cache to be up to date after DDL. `PGRST_DB_CHANNEL_ENABLED=false` (PgBouncer compat) means today's only option is `docker compose restart postgrest`. An admin button issuing `NOTIFY pgrst, '"reload"'` is the obvious fix and was already noted under Operational.

---

## Latent / operational

### ~~`postgres/init/*.sql` is behind `postgres/migrations/*.sql`~~ — RESOLVED
Fresh installs run the init scripts on first boot. The init scripts used to only seed the v0.1.0 schema; migrations 0004–0014 added realtime, functions/verify_jwt, function_env (+ encryption + nullable value), and cron jobs, none of which were in init — so a fresh install ended up with a less complete schema than an upgraded one. The user hit this when `_dashboard.cron_jobs` was missing.

- **Fixed:** the missing schema is now folded into init — `auth.settings`/`auth.providers` into `06_auth.sql`, plus new `09_realtime.sql`, `10_functions.sql`, `11_function_env.sql`, `12_cron_jobs.sql`. Verified by booting a fresh Postgres from the init scripts alone and diffing its schema against an init+migrations DB: byte-identical (261 inventory lines, 0 differences).
- Migrations stay idempotent, so running them on a fresh install is a harmless no-op. Going forward, **any new migration must also be reflected in init** to keep them converged.

### Caddy routing for `/functions/v1/*`
Edge functions live on the `dashboard.*` host. External callers expect them under `api.*` (Supabase convention, what the function-author template hints at). Currently a 404 if you hit `api.example.com/functions/v1/<name>`.

- **Fix:** Caddyfile `handle /functions/v1/*` block on the API host that reverse_proxies to `dashboard:3000`. Dashboard middleware (`middleware.ts:29-31`) already lets `/functions/v1/*` through without a session.

### PostgREST schema-cache reload
`PGRST_DB_CHANNEL_ENABLED=false` (required for PgBouncer transaction mode) means PostgREST no longer auto-detects schema changes.

- **Workaround today:** `docker compose restart postgrest` after DDL.
- **Better fix:** an admin button in the dashboard ("Reload PostgREST schema cache") that issues `NOTIFY pgrst, '"reload"'` over the dashboard's direct connection to Postgres (the dashboard talks to PgBouncer normally, but `pool()` could be swapped for `realtimePool()` for this one NOTIFY since LISTEN/NOTIFY don't need session pinning for a one-shot publish).

### Audit retention applies to the database only
The 30-day prune wipes rows from `_dashboard.audit_log`. The on-disk JSONL files at `${AUDIT_LOG_DIR}/<subdir>/audit-YYYY-MM-DD.jsonl` are never deleted by us.

- **Intentional today:** the files are the long-term archive.
- **Add later if needed:** a separate `audit_files_retention_days` setting and matching prune step, mirroring the DB one.

### Password rotation procedure
Older installs may have base64-generated passwords containing `/` or `+`, which break URL-form Postgres connection strings (we hit this on `AUTHENTICATOR_PASSWORD`).

- **README** now recommends `openssl rand -hex 24` to prevent it on fresh installs.
- **Missing:** a documented rotation procedure for existing installs (`ALTER ROLE … WITH PASSWORD …`; update `.env`; restart `pgbouncer` + `postgrest` + `dashboard`).

---

## Code quality / minor

### Next.js 16 middleware deprecation
Dev server emits: *"The 'middleware' file convention is deprecated. Please use 'proxy' instead."*

- **Fix:** rename `dashboard/middleware.ts` → `dashboard/proxy.ts`. Confirm Next 16's proxy convention is API-compatible (it appears to be — same `NextRequest`, same `NextResponse`).

### `serverActions` experimental flag
Next prints a warning that server actions are an experiment. Stable in Next 15+; the flag may already be unneeded — check `dashboard/next.config.ts`.

### Load testing
Everything in the recent perf pass (pool bumps, PgBouncer, function compile cache) was speculative — sized for "1000+ users". We have not actually load-tested.

- **Before optimising further:** run `oha`, `wrk`, or `k6` against `api.*` (PostgREST), `dashboard.*/functions/v1/<fn>` (edge functions), and `dashboard.*/auth/v1/*` (end-user auth). Find the real bottleneck, then fix it.
