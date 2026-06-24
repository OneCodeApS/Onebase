# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the project is on `0.x`, minor version bumps (`0.1 → 0.2`) may include breaking changes; patch versions (`0.1.0 → 0.1.1`) will not.

## [Unreleased]

## [2.8.1] - 2026-06-24

### Changed

- **The Connect dialog is now tabbed.** The modal splits into an **Application** tab (the API URL / anon-key env vars + usage, visible to everyone) and an admin-only **Direct database** tab (the `ssh -L` command + `localhost` connection parameters for Power BI / SQL clients). The direct-database details were previously an appended section; non-admins now simply see the single Application view with no tab strip. Same information — just reorganised into tabs.
- **The admin Settings page is split into API / Database / Logs categories** behind a Functions-style sub-sidebar, and the main sidebar entry is renamed from **Audit settings** to **Settings** (under a renamed **Administration** group). `/admin/settings` redirects to the API category. *API* holds the max-rows cap; *Database* holds the `bi_readonly` password rotation; *Logs* holds the audit log destination, database retention, and prune. No settings were removed — the page outgrew the audit-only name once it covered API and direct-database access too. Form redirects now land back on the relevant category; the whole area stays admin-only.

## [2.8.0] - 2026-06-24

### Added

- **Direct database connection for BI tools / SQL clients (Power BI) over SSH.** The DB speaks the plain PostgreSQL wire protocol, but the port is never exposed publicly — so a new read-only **`bi_readonly`** login role + an SSH-tunnel workflow give Power BI, Excel, DBeaver, or `psql` safe access. `bi_readonly` has `SELECT` on the `public` schema **only** (never granted `USAGE` on `_dashboard` / `auth` / any management schema, so credentials, secrets, and the audit log are unreachable), and is `BYPASSRLS` so reporting sees every row (RLS still constrains the public PostgREST clients; `ALTER ROLE bi_readonly NOBYPASSRLS;` to opt out). The role is created disabled (`NOLOGIN`) and only flips to `LOGIN` once `BI_READONLY_PASSWORD` is configured, so it can never accept an empty password. New section in **docs/OPERATIONS.md** documents the one-time enable plus the `ssh -L 5432:localhost:5432 …` + client-setup steps.
- **Connect dialog → Direct database connection (admin-only).** The dashboard's **Connect** modal gains an admin-gated section with the install's real values pre-filled: the `ssh -L` command (host derived from `API_PUBLIC_URL`), the `localhost` connection parameters (port, database, `bi_readonly` user, "disable SSL — the tunnel encrypts" note), a Power BI hint, and copy buttons for the command and connection string. It renders only when the signed-in operator's role is `admin` — non-admins never see this privileged access path. The existing API URL / anon-key section is unchanged and stays visible to everyone.
- **Rotate the `bi_readonly` password from the dashboard (Admin → Settings → Direct database access).** A *Rotate password* button generates a strong (≈192-bit, connection-string-safe) password, sets it via a `SECURITY DEFINER` helper (`dashboard_admin` can't `ALTER ROLE` directly — same pattern as the API row-cap setting), and shows it **once**. It takes effect immediately with no restart, also serves as the in-UI way to set the password the first time (no `.env` edit needed), and is audited as `settings.bi_readonly_password.rotate`. The password is never written to the URL, the audit log, or the query text (bound parameter).

### Changed

- **Production Postgres is now published on the server's loopback (`127.0.0.1:5432:5432`)** instead of being fully unpublished (`docker-compose.prod.yml`). This is the SSH-tunnel target: still unreachable from off-box (loopback only), but `ssh -L` can now forward to it. To lock the DB down completely instead, set `ports: !override []` and use `docker exec`.

### Database

- **`0031_bi_readonly_rotate_fn.sql`** — `_dashboard.rotate_bi_readonly_password(text)`, the `SECURITY DEFINER` helper backing the dashboard's *Rotate password* button (validates length ≥ 16, requires the role to exist, `ALTER ROLE … LOGIN PASSWORD %L`). `EXECUTE` granted to `dashboard_admin` only. Idempotent; mirrored into `postgres/init/17_bi_readonly.sql` for fresh installs. On an **existing** install, apply it after `0030` to enable in-UI rotation.
- **`0030_bi_readonly_role.sql`** — creates the `bi_readonly` role with `SELECT` on `public` (existing + default privileges for both the bootstrap superuser and `dashboard_admin`-created tables), and seeds `LOGIN`/password from `BI_READONLY_PASSWORD`. The password is a **one-time seed**: it is applied only while the role has no password, so re-running the migration (every upgrade re-runs all migrations) can never revert a rotated password. **Rotate** with a single instant, no-restart statement — `ALTER ROLE bi_readonly PASSWORD '<new>';` (after a leak; `.env` is not re-asserted over it). Purely additive — no existing role is touched and nothing is `REVOKE`d. Idempotent; mirrored into `postgres/init/02_roles.sql` for fresh installs. On an **existing** install (only needed to use the feature): add `BI_READONLY_PASSWORD` to `.env`, recreate `postgres` so it sees the var (`docker compose … up -d postgres`), then apply `0030`.

## [2.7.0] - 2026-06-22

### Added

- **Owner filter on Admin → Access tokens.** A dropdown (shown only when more than one owner holds tokens) narrows the token table to a single owner's tokens, with per-owner counts in each option, so it stays clear who created what as the list grows. Filtering is client-side over the already-loaded list — nothing is refetched.

### Changed

- **Revoked tokens are now hidden from the Access tokens list.** `listTokens` filters `revoked_at IS NULL`, so revoked tokens no longer clutter the table. The row is kept in the database (revoke stays a soft-delete) and the revocation is recorded in the audit log, so nothing is lost — it just drops out of the live view.
- **The Claude Desktop connection snippet now uses the direct `cmd /c npx … --header "Authorization: Bearer <token>"` form**, replacing the `${AUTH_HEADER}` env-var indirection introduced in 2.6.0. A bare `"command": "npx"` frequently fails with `ENOENT` on Windows because the spawned process can't resolve the `npx` shim; running it through `cmd /c` resolves the shim, and passing the header as a single inline argv entry sidesteps the argument-splitting concern the env-var form was working around. The note now documents the macOS/Linux variant (`"command": "npx"`, drop `"/c"`). Docs-only — no behavioral change to the MCP server.

## [2.6.1] - 2026-06-22

### Fixed

- **Authorized-mode realtime delivered nothing — every event was silently dropped (regression present since 2.4.0).** `_dashboard.realtime_can_select` evaluates a table's RLS SELECT policy in the subscriber's context by doing `SET LOCAL ROLE authenticated` + setting `request.jwt.claims` (the same thing PostgREST does), over the hub's non-BYPASSRLS `authenticator` connection. But the function shipped as **`SECURITY DEFINER`**, and Postgres forbids changing the `role` GUC inside a security-definer function (`ERROR 42501: cannot set parameter "role" within security-definer function`). So the check threw on every call, the function's own `EXCEPTION WHEN OTHERS` swallowed it and returned `false`, and **every authorized-mode event, on every table, for every subscriber, was dropped.** Basic mode (no RLS check) was unaffected — hence "basic works, authorized = silence." The function is now **`SECURITY INVOKER`**, so it runs as the `authenticator` caller (which *is* allowed to `SET ROLE authenticated`, and is what the design always intended); `authenticator` is also granted `EXECUTE` on `_dashboard._policy_applies`, which it now evaluates as the caller. Anyone on 2.4.0–2.6.0 with a table in **authorized** mode is affected and should apply this. (The 2.5.0 realtime logs made this diagnosable: the swallowed `42501` now surfaces as an `authorize_error`.)

### Changed

- **Realtime logs are now capped at 24h across the board.** Previously `error` rows were kept 7 days (noise 24h); the log is a debugging aid, not an audit trail, so errors now expire after 24h too. The error/noise split and the row-count caps are retained, so a denial storm still can't evict error rows within the 24h window.

### Database

- **`0028_realtime_can_select_invoker.sql`** — `ALTER FUNCTION _dashboard.realtime_can_select(...) SECURITY INVOKER` and `GRANT EXECUTE ON FUNCTION _dashboard._policy_applies(oid[], text) TO authenticator`. Idempotent; mirrored into `postgres/init/09_realtime.sql` for fresh installs. On an **existing** install: apply `0028` (no dashboard redeploy needed — it's a database-only fix; authorized-mode delivery starts working immediately).
- **`0029_realtime_logs_24h.sql`** — redefines `_dashboard.prune_realtime_logs` so its default `p_error_age` is 24h (was 7 days). Idempotent; mirrored into `postgres/init/09_realtime.sql`. On an **existing** install: apply `0029` (database-only).

## [2.6.0] - 2026-06-22

### Security

- **MCP `db:read` / `db:write` scopes are now enforced by dedicated Postgres roles, not a string filter.** The MCP SQL paths previously ran reads as `dashboard_admin` and writes via `dashboard_sql_rw`, relying on the `PROTECTED_OBJECTS` regex to keep tokens out of credential/secret/audit tables. That regex is bypassable (a quoted identifier like `_dashboard."access_tokens"`, or `SET search_path` + an unqualified name), so a `db:read`/`db:write` token could in principle reach `auth.users`, `_dashboard.access_tokens`, or `_dashboard.function_env`. The read path now `SET ROLE`s into `mcp_reader` and the write path into `mcp_writer` — roles granted **only** on the `public` application schema, so `_dashboard`, `auth` and every other management schema are unreachable at the database layer regardless of how the SQL is written. `db:ddl` stays `dashboard_admin` (admin-scoped, trusted). The regex is retained as defense-in-depth and still guards the `db:ddl` path. Token scope selection and in-place editing are unchanged; the scopes you pick now map to a hard boundary.

### Fixed

- **`db:write` over MCP failed outright on PG16+.** `dashboard_sql_rw` is `NOINHERIT`, so `SET ROLE` stripped its `pg_*_all_data` privileges and every write hit `permission denied` — even on legitimate `public` tables. `mcp_writer` is granted directly (not via a predefined-role membership), so its privileges survive `SET ROLE`.

### Added

- **Claude Desktop connection instructions on Admin → Access tokens.** `claude_desktop_config.json` silently skips the `type: "http"` transport that Claude Code / Cursor use, so the page now documents the `mcp-remote` stdio bridge (with the env-var header form that avoids a known argument-splitting bug, and a Windows `cmd /c` note).

### Database

- **`0027_mcp_sql_roles.sql`** — adds `mcp_reader` (SELECT) and `mcp_writer` (SELECT/INSERT/UPDATE/DELETE) with explicit grants on `public` only, plus default privileges so future `dashboard_admin`-created tables are covered. Purely additive: no app-facing role (`anon`, `authenticated`, `authenticator`, `service_role`) is touched and nothing is `REVOKE`d, so application users are unaffected. Idempotent; mirrored into `postgres/init/02_roles.sql` for fresh installs. On an **existing** install: **apply `0027` before deploying the dashboard image** — the code `SET ROLE`s into these roles, so deploying the image first (without the roles) breaks all MCP SQL until the migration runs.

## [2.5.0] - 2026-06-22

### Added

- **Realtime logs — observability for the change stream (Admin → Realtime logs).** Authorized mode fails *closed*: if the per-subscriber RLS check errors, a payload won't parse, or the listener connection drops, the event is silently discarded — which made "basic works, authorized delivers nothing" impossible to diagnose. The fan-out path now records diagnostics to `_dashboard.realtime_logs` and a new admin page surfaces them with table / level / event filters and pagination. Captured events: `authorize_error` (the previously-swallowed exception, with its message), `authorize_deny` (a subscriber was filtered out by RLS), `subscribe`, `token_expired`, `realtime_disabled`, `invalid_token`, `subscribe_error`, `connection_lost`, and `payload_parse_error`. Each row carries the table, level (`info`/`warn`/`error`), the subscriber's `sub`, and a JSON detail. Successful delivery is never logged (it stays off the hot path).
- **Table search on Admin → Realtime.** A filter box narrows the table list by `schema.table`, with a live "N of M" count, so toggling realtime stays usable as the table list grows. A **View logs** link sits alongside it.

### Changed

- Realtime logging is bounded so it can never fill the disk or drown the signal: identical entries are throttled per `(table, event, subscriber)` — errors at most once per 10 s, routine denials/lifecycle at most once per minute — and writes are fire-and-forget so logging can never block or break delivery. Retention (`_dashboard.prune_realtime_logs`, run opportunistically) splits rare `error` rows (kept 7 days) from routine `info`/`warn` noise (kept 24 h, capped at 20 000 rows) under a 50 000-row absolute ceiling, so a denial storm on one table can never evict the error rows that matter.

### Database

- **`0026_realtime_logs.sql`** — adds `_dashboard.realtime_logs` (indexed by `created_at` and by `(schema, table, created_at)`) and `_dashboard.prune_realtime_logs(error_age, noise_age, max_rows, max_noise)`. Writes come from the dashboard (`dashboard_admin`); the table is never on the successful-delivery path. Idempotent; mirrored into `postgres/init/09_realtime.sql` for fresh installs. On an **existing** install: apply `0026`, then deploy the dashboard image (the engine instrumentation ships with it) — no config or restart beyond the normal deploy.

## [2.4.0] - 2026-06-17

### Added

- **Realtime "authorized" mode — per-subscriber RLS filtering.** Each realtime table now has a mode (Admin → Realtime): **basic** (the previous behavior — every change broadcast to all subscribers, RLS not applied) or **authorized** (each event is filtered per-subscriber by the table's RLS SELECT policy before delivery). In authorized mode, before an event reaches a given subscriber, the fan-out hub asks Postgres to re-evaluate the table's SELECT policy for the changed row in *that subscriber's* auth context (`role authenticated` + their JWT's `request.jwt.claims`), over a dedicated non-BYPASSRLS `authenticator` connection — the same predicate PostgREST applies. A row a user cannot SELECT via REST can no longer reach them via realtime. INSERT/UPDATE are checked against the new row, DELETE against the old. The decision is computed once per distinct user identity per event and reused across that user's subscribers. The Admin → Realtime page gains Off / Basic / Authorized controls and shows each table's RLS status.

### Security

- **Closed a realtime confidentiality gap.** Previously the change stream was strictly table-level: any authenticated user who subscribed to an enabled table received every row's full payload, including rows their RLS SELECT policy forbids. Tables switched to authorized mode are now filtered per-subscriber. **Existing enabled tables migrate as `basic`, preserving current behavior** — opt sensitive tables into authorized mode (which requires RLS enabled on the table). Fail-closed throughout: an RLS error, an invalid/expired JWT, a truncated (>~8 KB) DELETE, or any inability to establish context drops the event rather than sending it. JWTs that expire mid-stream now stop delivery and emit an `event: token_expired` (the client must mint a fresh token and reconnect) instead of streaming on under a stale token. The RLS check never runs on a BYPASSRLS connection. The "RLS does NOT filter events" caution is retired for authorized-mode tables (security advisor and docs updated accordingly); it still stands for basic mode.

### Database

- **`0025_realtime_authorized.sql`** — adds `_dashboard.realtime_tables.mode`; `_dashboard.realtime_can_select(schema, table, row, keys, op, claims)` (SECURITY INVOKER, fail-closed) which combines the table's permissive/restrictive SELECT policies and evaluates them against the changed row as `authenticated`; helper functions `_dashboard._pk_cols` and `_dashboard._policy_applies`; an updated `_dashboard.realtime_notify` trigger that attaches the primary key to oversized (truncated) events so authorized mode can still filter them; and an `enable_realtime(schema, table, mode)` overload. Idempotent; mirrored into `postgres/init/09_realtime.sql` for fresh installs. On an **existing** install: apply `0025`, then set `REALTIME_RLS_DATABASE_URL` (an `authenticator` connection) on the `dashboard` service and restart it.

## [2.3.0] - 2026-06-17

### Added

- **Nested folders in storage buckets** — the dashboard storage browser now supports Supabase-style folder hierarchies. Navigate into folders (tracked via a `?prefix=` query param with a clickable breadcrumb back to the bucket root), upload files into the folder you're viewing, and create empty folders with **New folder**. Folders are listed non-recursively so each level shows its subfolders (S3 *common prefixes*) above its files; an empty folder is materialised as a zero-byte `.emptyFolderPlaceholder` object that the listing hides. Deleting a folder removes every object beneath it (recursive). The `?prefix=` value is sanitised — leading/duplicate slashes are collapsed and any `..` traversal is rejected — so a folder prefix can never escape its bucket. The public storage API was already nesting-capable (the `/storage/v1/object/upload` and `/sign` routes accept multi-segment keys), so this change is dashboard-only; existing flat buckets are unaffected.

## [2.2.0] - 2026-06-16

### Changed

- **PostgREST now connects directly to Postgres instead of through PgBouncer.** It was routed through the transaction-mode pooler, which silently drops the session-level `LISTEN` PostgREST uses for schema-cache reloads — so the `pgrst` channel had to be disabled and any newly created table or column 404'd over `/rest/v1` until a manual `docker compose restart postgrest`. PostgREST self-pools (`PGRST_DB_POOL`) and reuses a bounded set of backends regardless of API traffic, so this does not change how it scales with users; PgBouncer is retained for the dashboard, serverless, and ad-hoc clients (and a comment on the service warns against routing PostgREST back through it). Prepared statements (`PGRST_DB_PREPARED_STATEMENTS`) are re-enabled now that connections aren't transaction-pooled — a small per-query win.

### Fixed

- **Newly created tables and columns no longer 404 over the REST API.** With PostgREST on a direct connection the `pgrst` `LISTEN` channel works again, and new DDL event triggers fire a schema-cache reload automatically (see Database), so a table created via the dashboard, SQL editor, or a migration is queryable at `/rest/v1/<table>` within a second — no restart required.

### Database

- **`0024_postgrest_reload.sql`** — `_dashboard.pgrst_reload()` plus `ddl_command_end` and `sql_drop` event triggers that `NOTIFY pgrst, 'reload schema'` after any schema change. Idempotent; mirrored into `postgres/init/16_postgrest_reload.sql` for fresh installs. On an **existing** install: apply `0024`, deploy the `postgrest` service change (direct connection + `PGRST_DB_CHANNEL_ENABLED=true`), and restart `postgrest` once to pick up the new config — after that, reloads are automatic.

## [2.1.0] - 2026-06-16

### Added

- **Row search in the table browser** — a single-column filter (contains / equals) on a table's Data tab. Applied server-side and composed with keyset pagination, so it searches the whole table rather than just the loaded page. The value is always a bound parameter and the column is validated against the table's real columns, so a hand-crafted query string can't inject. Shown for keyset-paged tables (those with a single-column primary key).
- **Add column from the table browser** — a trailing **+** column on the Data tab opens a right-side drawer to add a column. Admin-only, real tables in non-system schemas. Curated type allow-list (`text`, `integer`, `bigint`, `boolean`, `timestamptz`, `date`, `uuid`, `numeric`, `jsonb`) so the type fragment of the generated DDL is never user-controlled; optional `NOT NULL` (refused with a clear message on a table that already has rows). Audited as `table.add_column`.
- **Adjustable API row cap** — Admin → Settings now has **API — max rows per request**. It writes PostgREST's in-database config (`pgrst.db_max_rows` on the `authenticator` role, via a `SECURITY DEFINER` helper since `dashboard_admin` can't `ALTER ROLE` directly) and persists the value for display. The new value applies on the next `docker compose restart postgrest` (the page says so); the schema-cache reload re-enabled in 2.2.0 covers DDL, not this role-level config GUC. A static default of `1000` (`PGRST_DB_MAX_ROWS`) caps fresh installs from first boot.

### Changed

- **Table browser pagination is now keyset-based** for tables with a single-column primary key — it seeks via `WHERE pk > cursor` instead of `OFFSET`, so paging stays fast at any depth. Counts above 50k rows use the planner's estimate (`reltuples`) instead of an exact `count(*)`. Views and composite- / no-PK tables keep offset paging.
- **Table view layout** — the data grid now scrolls horizontally and vertically inside a height-bounded box with a sticky header. The page itself no longer shows a second vertical scrollbar, and the horizontal scrollbar is reachable without scrolling to the bottom of a long table.
- The admin settings page heading is now **Settings** (it hosts the new API section alongside the audit settings).

### Fixed

- **Table pagination could hang on large tables** — the "Next" button appeared stuck. Every page render ran an exact `count(*)` plus a deep `OFFSET` scan, which on large tables hit the 30s `statement_timeout` so the navigation never resolved. Keyset paging + estimated counts (above) fix it.

### Removed

- **The sample `todos` table is no longer created on fresh installs.** `postgres/init/04_sample_schema.sql` now only sets up the load-bearing `authenticated` role; it no longer creates the demo table, its policies, or seed rows. Existing databases are unaffected — init scripts run only on first boot.

### Database

- **`0023_api_max_rows.sql`** — `_dashboard.set_api_max_rows()`, the `SECURITY DEFINER` helper backing the adjustable API row cap. Idempotent; mirrored into `postgres/init/15_api_config.sql` for fresh installs. On an **existing** install, apply it (as postgres) and add `PGRST_DB_MAX_ROWS` (default `1000`) to the `postgrest` service env to get the cap.

## [2.0.4] - 2026-06-15

- fix 404 error on mcp page

## [2.0.3] - 2026-06-15

### Added

- **Built-in MCP server** at `api.*/mcp/v1` (Streamable HTTP, stateless) so AI coding agents (Claude Code, Cursor, VS Code) can work against an instance the way the Supabase MCP works against a Supabase project. 22 tools across database (list_tables, execute_sql, apply_migration + a new `_dashboard.migrations` ledger, generate_typescript_types), debugging (get_logs, get_advisors security lints, explain_query, verify_audit_chain), edge functions (list/get/deploy/invoke), storage, cron, and docs (search_docs, generate_client_snippet, get_api_url, get_anon_key). See `MCP-PLAN.md` for the design.
- **Personal access tokens** — Admin → Access tokens. Hashed at rest, expiring, individually revocable, scope-limited, read-only by default; capabilities are additionally capped by the owner's current dashboard role at use time. The connect page renders ready-to-paste Claude Code / Cursor config.
- **MCP safety rails** — SQL runs through the SQL editor's existing role ladder (read-only transaction / `dashboard_sql_rw` / admin); credentials, secrets, and the audit log are unreachable through raw MCP SQL; destructive statements require a confirm-token round-trip; all returned data is wrapped in prompt-injection boundaries; every tool call is rate-limited (new `mcp` area) and written to the hash-chained audit log, failing closed if the audit write fails. Threat model documented in `SECURITY.md`.

### Database

- **`0022_access_tokens.sql`** — `_dashboard.access_tokens`, the `_dashboard.migrations` ledger, and the `mcp` rate-limit seed. Idempotent; mirrored into `postgres/init/14_access_tokens.sql` for fresh installs.
## [2.0.2] - 2026-06-12

### Added

- **Connect button in a new top header.** Every authenticated page now has a slim top bar with a green **Connect** button (Supabase-style). It opens a modal pre-filled with this install's real connection values — the public API URL (`API_PUBLIC_URL`) and the anon key — formatted as ready-to-paste environment variables. A framework picker (Next.js / Vite / Expo / Server) switches the env-var prefix (`NEXT_PUBLIC_` / `VITE_` / `EXPO_PUBLIC_` / none) so the `ONEBASE_URL` and `ONEBASE_ANON_KEY` lines match the target app, with copy buttons for the `.env` block and a framework-agnostic `fetch` usage snippet. The anon key is shown in the clear because it's a public, embeddable credential; the modal points to **Admin → API keys** for the server-side `service_role` key. The button degrades to hidden if `API_PUBLIC_URL` is unset or the anon key can't be minted, rather than breaking the page.

## [2.0.1] - 2026-06-12

### Added

- **Views and materialized views now appear in the tables list.** The Tables sidebar previously listed only ordinary tables (`pg_class.relkind = 'r'`); it now also shows views (`v`) and materialized views (`m`), each with a `view` / `mview` badge. The table detail page badges them in the header and skips the "Row Level Security is off" warning, which doesn't apply to views. Dropping one issues the matching `DROP VIEW` / `DROP MATERIALIZED VIEW` instead of `DROP TABLE`.

## [2.0.0] - 2026-06-08

A scaling + security release. Realtime now fans out over a single Postgres connection (thousands of concurrent subscribers cost one connection, not one each); the cron scheduler and audit-retention sweeper are leader-elected so the dashboard can run multiple replicas; and a full security audit's findings are fixed across storage, auth, the SQL editor, edge functions, and rate limiting. **Major-upgrade release: ships new migrations (`0019`–`0021`) and behaviour changes that affect existing API clients — read Breaking first.** Fresh installs need no migration step; the init scripts already include everything.

### Breaking

- **Edge functions with `verify_jwt` now require an authenticated caller by default.** A valid signature is no longer sufficient — the caller's token role must be ≥ the function's new `min_role` (default `authenticated`), so the public `anon` key alone no longer reaches a JWT-gated function. To allow anon on a specific function, set its **Minimum role** to `anon` (Admin → Edge functions → Overview), or turn Verify JWT off for truly-public functions.
- **Storage signing is now bucket-visibility aware.** `authenticated` end-users may only sign GET/upload URLs for **public** buckets; **private** buckets require a `service_role` token (your backend signs on the user's behalf after its own check). Previously any authenticated user could sign for any object in any bucket.
- **The SQL editor no longer lets `read_write` users run DDL.** `read_write` now runs under a restricted role (DML on all data, but no `CREATE`/`DROP`/`ALTER`/`TRUNCATE`/role management); `read_only` runs in a read-only transaction; `admin` keeps full access.
- **Production compose runs 2 dashboard replicas** (`deploy.replicas: 2`). Set it back to `1` in `docker-compose.prod.yml` for a single-instance install. Caddy load-balances via a new `dashboard_lb` snippet — regenerate the HTTP-only Caddyfile from `docs/DEPLOY.md` (section 2.4) if you maintain one by hand.

### Database

Apply all new migrations (idempotent) before deploying the new image on an **existing** install. Fresh installs get them from the init scripts automatically.

- **`0019_rate_limits.sql`** — `_dashboard.rate_limits` (config) + `_dashboard.rate_limit_hits` (counter) + `rate_limit_take()` for cross-replica auth rate limiting.
- **`0020_sql_editor_role.sql`** — `dashboard_sql_rw` restricted role for the SQL editor (read/write all data, no DDL).
- **`0021_function_min_role.sql`** — adds `min_role` to `_dashboard.functions`.
- The init scripts (`postgres/init/*.sql`) are now a **complete** snapshot — every migration through `0021` is folded in, so a fresh database comes up fully initialised with no migration step (verified by diffing a from-init database against a fully-migrated one).

  ```bash
  docker compose -f docker-compose.yml -f docker-compose.prod.yml cp postgres/migrations postgres:/tmp/migrations
  docker compose -f docker-compose.yml -f docker-compose.prod.yml exec postgres bash -c \
    'for f in /tmp/migrations/*.sql; do echo "==> $f"; psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f "$f" || exit 1; done'
  ```

### Added

- **Horizontal scaling for the dashboard** — the cron scheduler and audit-log retention sweeper are leader-elected via a Postgres advisory lock (`lib/scheduler.ts`), so exactly one replica runs them with automatic failover. Run N replicas behind Caddy (dynamic-upstream load balancing). See `docs/OPERATIONS.md` → "Running multiple dashboard replicas".
- **Realtime fan-out** — all SSE subscribers on a replica share one Postgres `LISTEN` connection (`lib/realtime-listener.ts`); concurrency is bounded by memory, not DB connections. Load-tested to 2000 concurrent streams on a single connection.
- **Rate-limit settings** — Admin → Rate limits: per-area (sign in / sign up / magic link) configurable throttles, enforced in Postgres so they hold across replicas.
- **Grants page** — Admin → Schema → Grants: table/view privileges per schema.
- **Enums page** — Admin → Schema → Enums: user-defined enum types and their values.
- **Per-function minimum role** — Admin → Edge functions → Overview.
- **Delete a table from the UI** — hover a table in the Tables sidebar → ⋮ → Delete (admin-only, `RESTRICT`, audited).
- **Realtime load-test harness** — `npm run loadtest:realtime` (`dashboard/scripts/realtime-loadtest.mjs`).

### Security

- **Storage object-level authorization** on sign / sign-batch / upload (see Breaking).
- **Configurable, cross-replica auth rate limiting** on sign in / sign up / magic link.
- **Argon2id hardened** to OWASP parameters (m=19 MiB, t=2, p=1); existing hashes keep verifying.
- **`verify_jwt` is now an authorization floor** via `min_role` (see Breaking).
- **SQL editor privilege separation** (see Breaking).
- **Microsoft OAuth `return_to`** is validated against the redirect allowlist before tokens are issued — closes a token-leaking open redirect.
- **Constant-time sign-in** — argon2 verify always runs (against a decoy for unknown accounts), removing a user-enumeration timing oracle.
- **Security response headers** — `X-Frame-Options`, CSP `frame-ancestors`, `X-Content-Type-Options`, `Referrer-Policy`, HSTS, `Permissions-Policy` on every route.
- **RLS-off warnings** — public (RLS-disabled) tables are flagged in the Tables list (amber dot) and on the table page.

### Changed

- **`next dev` / `next build` use webpack** (`--webpack`), working around a Turbopack bug where `node-cron` in `instrumentation.ts` failed to resolve and leaked postcss worker processes into multi-GB of orphaned `node.exe`.
- **Sidebar** — RLS policies, DB functions, Grants, Realtime, and Enums are grouped under a collapsible **Schema** menu.

### Fixed

- **`postgres/init` no longer lags `postgres/migrations`** — fresh installs were missing everything from migration `0011` on (cron, functions, function-env, realtime, …); init is now a complete, verified snapshot, so a freshly-reset database is no longer missing tables like `_dashboard.cron_jobs`.
- **PgBouncer image build** — `pgbouncer/entrypoint.sh` is forced to LF; a CRLF checkout made the container fail with `exec /entrypoint.sh: no such file or directory`. Added `.gitattributes` to keep shell scripts LF on all platforms.

## [1.5.0] - 2026-06-05

Passwordless magic-link sign-in for end users, operator-side end-user creation, and a smoother tables browser. **This is a major-upgrade release: it ships a new database migration (`0018`) — apply it before deploying the new dashboard image.**

### Database

- **`0018_magic_link.sql`** — adds `auth.magic_link_tokens` (single-use, hashed sign-in tokens) and seeds the disabled `magiclink` row in `auth.providers`. Idempotent; safe to run with the rest of the migration loop:

  ```bash
  docker compose -f docker-compose.yml -f docker-compose.prod.yml cp \
    postgres/migrations postgres:/tmp/migrations
  docker compose -f docker-compose.yml -f docker-compose.prod.yml exec postgres bash -c '
    for f in /tmp/migrations/*.sql; do echo "==> $f"; psql -U postgres -d postgres -f "$f" || exit 1; done
  '
  ```

### Added

- **Magic-link (passwordless email) sign-in** — new `magiclink` auth provider, disabled by default. Two endpoints: `POST /auth/v1/magiclink` (`{email, redirect_to}` → always `200 {}`, no account enumeration) and `/auth/v1/magiclink/verify` (GET renders an auto-submitting confirm page so mail scanners can't burn the token; POST atomically consumes it and 303-redirects to the app with tokens in the URL fragment — same contract as the Microsoft callback, so `onecodebase-js`'s `getSessionFromUrl()` handles both). Security defaults: tokens are 32 random bytes stored as SHA-256 hashes, single-use, 15-minute expiry (configurable 1–60 min); `redirect_to` must be `https` and on the CORS origin allowlist (the `*` wildcard is rejected — no open redirects) and is pinned at request time; per-user cap (3/hour, silent) plus per-IP flood brake (429); users are only created on request when *Allow signups* is on — otherwise unknown emails are silently ignored. SMTP is configured per install in Admin → Auth providers (host/port/TLS/credentials, from address, app name, link expiry, session TTL); the SMTP password is stored AES-256-GCM-encrypted using the existing `FUNCTION_ENV_KEY`. Magic-link sessions can use a shorter refresh TTL (`session_ttl_days`, 1–30) than the platform's 30-day default — intended for external-user portals. **No new required env vars.**
- **Dev mail catcher** — `docker-compose.override.yml` (auto-loaded in dev only) ships a [Mailpit](https://github.com/axllent/mailpit) service: point the provider's SMTP host at `mailpit:1025` and read sent mail at `http://127.0.0.1:8025`. Production compose never loads it.

- **Create end users from the dashboard** — Admin → End users has a **+** button (top right) → *End user* → a slide-over panel from the right with email + password. Provisions the account directly (argon2-hashed, `email` identity row, audit-logged) so operators never need to enable public signups to onboard users. Pairs with the existing Reset password / Disable / Delete row actions.

### Changed

- **Tables sidebar scrolls independently** — the table list in `/tables` now has its own scrollbar instead of scrolling away with the page content; long table lists and long table pages no longer fight over one document scroll.
- **OAuth redirect base URL now defaults to `API_PUBLIC_URL`** — the Microsoft sign-in callback URL is derived from `API_PUBLIC_URL` (which every install already sets), so `AUTH_REDIRECT_BASE_URL` no longer needs to be configured. It remains available as an optional override for the rare case where the OAuth callback host differs from the api host, and is now forwarded to the dashboard container by `docker-compose.yml` when set. The Auth Providers admin page shows the resulting redirect URI (`<api-host>/auth/v1/microsoft/callback`) for copy-paste into the Azure app registration. No migration, no new required env vars — a normal patch upgrade.

## [1.4.0] - 2026-06-02

Dashboard admins can now manage RLS policies on tables they didn't create, and the realtime SSE endpoint is reachable from allowed browser origins. **This is a major-upgrade release: it ships a new database migration (`0016`) — apply it as the `postgres` superuser before deploying the new dashboard image.**

### Database

- **`0016_app_owner_rls.sql`** — introduces the `app_owner` owner role and reassigns existing `public` tables to it (see Added). Idempotent; safe to run with the rest of the migration loop. **Must be applied as the `postgres` superuser** (it creates a role, reassigns ownership, and creates an event trigger):

  ```bash
  docker compose -f docker-compose.yml -f docker-compose.prod.yml cp \
    postgres/migrations postgres:/tmp/migrations
  docker compose -f docker-compose.yml -f docker-compose.prod.yml exec postgres bash -c '
    for f in /tmp/migrations/*.sql; do echo "==> $f"; psql -U postgres -d postgres -f "$f" || exit 1; done
  '
  ```

### Added

- **Supabase-style `auth.*` RLS helpers** — `auth.uid()`, `auth.role()`, `auth.email()`, and `auth.jwt()` now ship in the `auth` schema, so apps ported from Supabase can write `USING (owner_id = auth.uid())` instead of repeating `(current_setting('request.jwt.claims', true)::json ->> 'sub')::uuid`. They wrap the verified JWT claims PostgREST already exposes via `request.jwt.claims` (shape fixed by the token signer: `sub`, `email`, `role`), are `STABLE` / `SECURITY INVOKER` (they read only request GUCs, never table data), and are granted `USAGE` + `EXECUTE` to `anon`, `authenticated`, and `service_role` — schema `USAGE` exposes no data since the `auth` tables carry no grants for those roles. New install: `postgres/init/08_auth_helpers.sql`. Existing install: run `postgres/migrations/0017_auth_helpers.sql` once as the `postgres` superuser (`docker compose exec -T postgres psql -U postgres -d "$POSTGRES_DB" < postgres/migrations/0017_auth_helpers.sql`).
- **`app_owner` shared owner role** — a NOLOGIN group role that owns every `public` table; `dashboard_admin` is a member `WITH INHERIT`, so it passes Postgres's ownership checks and the whole admin team (who share that one connection) can manage RLS without ownership being pinned to a single login role. A `SECURITY DEFINER` event trigger (`app_owner_assign_on_create`, in `_dashboard`) reassigns any newly created `public` table to `app_owner`, so RLS management never regresses for tables created via the SQL editor or `psql`. New install: `postgres/init/07_app_owner.sql`. Existing install: run `postgres/migrations/0016_app_owner_rls.sql` once as the `postgres` superuser (`docker compose exec -T postgres psql -U postgres -d "$POSTGRES_DB" < postgres/migrations/0016_app_owner_rls.sql`).

## [1.3.5] - 2026-05-28

Non-admin operators get read-only access to several admin pages, and the tables browser / policies / DB functions hide system schemas from `read_only`.

### Added

- **Read-access for non-admin roles** — `read_write` and `read_only` can now view (but not edit) RLS policies, DB functions, edge functions (Overview / Invocations / Logs tabs only — Code stays admin-only), and Cron jobs. Pages render without their write controls: no "+ New", Edit, or Delete buttons; the function Overview's Settings form is replaced by a read-only summary and the Danger zone is hidden; `/admin/db-functions/<oid>` shows the function source in a read-only CodeMirror. Server actions still call `requireAdmin()` so a direct POST from a non-admin is rejected — the UI changes are cosmetic, the action gates are the security boundary.

### Changed

- **System schemas hidden from `read_only`** — the tables browser, RLS policies, and DB functions pages all filter `_dashboard` and `auth` out of their schema pickers for `read_only`, and reject direct URLs like `/tables/audit_log?schema=_dashboard` or `/admin/db-functions/<oid>` (when the function lives in a system schema) with `404`. The tables sidebar's "Show system schemas" toggle is hidden from `read_only`, and its localStorage value is ignored so a returning `read_only` on a shared machine can't bring system schemas back. `read_write` and `admin` are unchanged. The SQL editor remains the deliberate escape hatch — `read_only` can still `SELECT … FROM _dashboard.audit_log` from `/sql`.

### Security

- Middleware's `/admin/*` gate now uses an explicit allowlist (`isNonAdminReadable`) for non-admin readable subpaths. Admin-only routes — `/admin/functions/env`, `/admin/functions/<name>/code`, `/admin/db-functions/new`, `/admin/api-keys`, `/admin/audit`, `/admin/auth-providers`, `/admin/cors`, `/admin/end-users`, `/admin/realtime`, `/admin/system`, `/admin/users`, `/admin/settings` — still return `404` (not `403`) for non-admins, matching the existing convention. Subpath matching is conservative: `/admin/functions/env/foo` and `/admin/functions/<name>/code/anything` are both blocked.

## [1.3.4] - 2026-05-27

### Added

- **Table schema view** — the table browser (`/tables/<name>`) now has **Data** / **Schema** tabs (URL-driven, `?view=schema`). The Schema tab renders the columns as a copyable `CREATE TABLE` statement (with a Copy button), alongside **Indexes** (`pg_get_indexdef`) and **Constraints** (`pg_get_constraintdef`) listings. Metadata is read from `pg_catalog` with bound parameters; identifiers in the generated DDL go through `quoteIdent`.
- **SQL editor best-practice snippets** — replaced the sample-data / CRUD example snippets with best-practice templates for this stack: an RLS-secured `uuidv7` table (with the `anon`/`authenticated` grants PostgREST needs), an `updated_at` trigger, a foreign key + index, RLS policies (public read / authenticated insert / owner-only via the JWT `sub` claim), and index / unique-constraint / `EXPLAIN` helpers. The read-only inspection queries are kept (the "Schema" group is renamed "Inspect").

### Changed

- **SQL editor sizing** — the editor is now tall (~60% of the viewport) while you compose and shrinks to a compact height once a result is on screen, leaving room for the output.
- **Themed scrollbars** — vertical and horizontal scrollbars across the dashboard now match the dark neutral UI (slim neutral-700 thumb, transparent track) instead of the OS default.

## [1.3.3] - 2026-05-27

**Upgrading from 1.3.2:** this release moves the bundled database from Postgres 16 to 18, so existing installs need a one-time Postgres major upgrade alongside the usual dashboard deploy:

```bash
git pull --ff-only             # pulls the new compose (postgres:18-alpine + PGDATA pin)
./scripts/pg-major-upgrade.sh  # migrates the DB 16 → 18 (backs up first; prompts before destructive steps)
./scripts/deploy.sh 1.3.3      # deploys the 1.3.3 dashboard image
```

Fresh installs get Postgres 18 automatically and skip the middle step. The dashboard runs against either major — the major upgrade is what makes the native `uuidv7()` default usable.

### Added

- **Component versions page** — Settings → Versions (`/admin/system`). Reads the live versions of the running stack at page load: Dashboard / Next.js / React / Node.js (from the dashboard process), PostgreSQL (`version()`), PgBouncer (admin-console `SHOW VERSION`, using the existing `dashboard_admin` credentials it already has admin/stats rights for), PostgREST (its `Server` header via `POSTGREST_INTERNAL_URL`, default `http://postgrest:3000`), and MinIO (SigV4 admin-info call with the existing root credentials). Detection is best-effort and fault-isolated — a down or unreachable service shows `unavailable` rather than breaking the page. Caddy is listed as not runtime-detectable (it hides its version and its admin API is container-local). Admin-gated like the other `/admin/*` pages.
- **Database backup & major-upgrade scripts** — `scripts/pg-backup.sh` dumps the whole cluster (all databases + roles) to a gzipped file under `./backups/`, and `scripts/pg-major-upgrade.sh` performs a safe dump-&-restore Postgres major upgrade with the stock image (back up → fresh cluster on the new major → restore in a throwaway container so the bundled `init/` scripts don't double-seed). Documented under [Upgrading PostgreSQL (major version)](docs/OPERATIONS.md#upgrading-postgresql-major-version).

### Changed

- **PostgreSQL upgraded to 18** (`postgres:18-alpine`) — for the native `uuidv7()` function. **New tables now default their primary key to `uuidv7()`** instead of `bigserial`/`gen_random_uuid()`: a time-ordered UUID that keeps UUIDs' unguessable / globally-unique properties while indexing far better than random `uuidv4`. The sample `public.todos` table demonstrates the convention (`id uuid PRIMARY KEY DEFAULT uuidv7()`); existing tables (`auth.*`, `_dashboard.*`) are unchanged. **Upgrade note:** `deploy.sh` only recreates the dashboard (`--no-deps`), so it never changes the running Postgres — existing installs keep their current major until an operator deliberately recreates the `postgres` service. A data volume initialised by an older major won't start under a newer one (Postgres refuses an incompatible data dir rather than harming the data), so a major upgrade needs a dump/restore (use `scripts/pg-major-upgrade.sh`); fresh installs initialise cleanly. The compose file also pins `PGDATA=/var/lib/postgresql/data`, because Postgres 18+ otherwise moves the data dir to a version-specific path (`/var/lib/postgresql/<major>/docker`) — pinning it keeps the data at the existing volume mount.

## [1.3.2] - 2026-05-27

CORS allowed-origins are now managed from the dashboard instead of only the `AUTH_ALLOWED_ORIGINS` env var.

### Added

- **CORS origins admin page** — Authentication → CORS origins. Add/remove the browser origins allowed to read responses from `/auth/v1/*` and the storage URL-issuance endpoints. Input is validated and canonicalized (via `URL.origin`, dropping any path/trailing slash; `*` is accepted for "any origin"), a `*` entry shows a warning, and every change writes an audit row (`settings.cors_origins.add` / `settings.cors_origins.remove`). Admin-gated like the other `/admin/*` pages.

### Changed

- **CORS allowlist is now database-backed** — `lib/cors.ts` reads the `auth_allowed_origins` setting (cached in-process for 30s, invalidated immediately on save) and falls back to the `AUTH_ALLOWED_ORIGINS` env var only until the list is first saved from the UI. After that the database is authoritative — even an empty list (explicit "allow nothing"); a DB error falls back to the env var rather than blocking requests. No migration: the setting row is created on first save, so existing env-configured installs keep working until then.
- **Dashboard user roles are editable inline** — the Role column on the Dashboard users page is now a dropdown that saves on selection, replacing the 1.3.1 "Make admin" button. The backing `setUserRole` action refuses to demote the last admin or to change your own role (enforced server-side and reflected in the UI), and audits each change as `user.role_change` with `{ from, to }`.

## [1.3.1] - 2026-05-27

### Added

Admin Role can now be given to dashboard users

## [1.3.0] - 2026-05-26

Public APIs consolidated under a single `api.*` host, end-user auth gets CORS, storage moves out from under its own subdomain to `api.*/storage/v1/object/*` (Caddy strips the prefix and forwards directly to MinIO — no Node in the byte path, so large videos and Range requests scale with MinIO bandwidth). Operator console gains the version chip, system-schema toggle in the tables browser, and reusable Loader / RefreshButton components.

### Added

- **Public API consolidation under `api.*`** — `/rest/v1/<table>` (PostgREST tables), `/rpc/v1/<fn>` (PostgREST RPC), `/auth/v1/*` (end-user auth), `/realtime` (SSE), `/functions/v1/<name>` (edge functions), and `/storage/v1/object/*` (storage proxy) all live on the api host. `dashboard.*` returns 404 for the API paths so there's one canonical surface for clients, docs, and CORS.
- **CORS at `lib/cors.ts`** — `withCors(handler, { methods })` adds `Access-Control-*` headers; `corsPreflight({ methods })` handles OPTIONS. Origin allowlist driven by new `AUTH_ALLOWED_ORIGINS` env var (empty / `*` / comma-separated origins). Applied to every `/auth/v1/*` route and the storage URL-issuance endpoints. Non-browser callers (curl, server-to-server) ignore CORS and keep working regardless of the setting.
- **Storage URL-issuance endpoints** — `POST /storage/v1/object/sign/<bucket>/<key>` returns a short-lived SigV4 GET URL; `POST /storage/v1/object/sign-batch` mints up to 100 in one call (for galleries); `POST /storage/v1/object/upload/<bucket>/<key>` validates bucket policy (max size, MIME allowlist) and returns a 5-minute presigned PUT. JWT-gated (authenticated or service_role).
- **System-schema toggle in the tables browser** — `_dashboard` and `auth` schemas are hidden by default; a "Show system schemas" checkbox in the sidebar reveals them and persists to localStorage. When a system schema is active, the sidebar shows a "Read-only · use the admin UI" pill; the row viewer shows a banner linking to the dedicated admin page (Dashboard users, End users, Audit log, Edge functions, Cron jobs, Storage buckets, Auth providers). SQL editor stays unrestricted as the escape hatch.
- **Reusable Loader / RefreshButton components** — `<Loader size="…" label="…" />` for inline spinners (drops into buttons or table cells); `<LoaderBlock />` for centered card-level loading; `<RefreshButton onRefresh?={…} />` calls `router.refresh()` inside a `useTransition` so server-rendered pages re-fetch with visible pending state. `tables/[name]/loading.tsx` wires up the Suspense fallback so the spinner shows on navigation, pagination, schema switches, and refresh.
- **Dashboard version chip in the sidebar** — `v<package.json#version>` rendered next to the "Onecodebase" header.

### Changed

- **Storage architecture: Caddy strip-and-forward** — `/storage/v1/object/*` is matched by Caddy on the api host. The three URL-issuance prefixes (`/sign/*`, `/sign-batch`, `/upload/*`) go to the dashboard; everything else under `/storage/v1/object/*` strips the prefix and forwards to internal MinIO. `header_up Host {host}` preserves the original Host header so SigV4 verifies against the same hostname the SDK signed. Bytes never traverse Node; HTTP Range requests / video seeking work natively because MinIO handles them.
- **`getShareLink` returns api-host URLs** — public buckets get `api.<host>/storage/v1/object/<bucket>/<key>` (no query; MinIO's anonymous-read ACL serves them); private buckets get the same path with a SigV4 query string. Caddy strips the prefix before MinIO sees the request, so signatures verify.
- **Sidebar scroll lock** — `(app)/layout.tsx` uses `h-screen overflow-hidden` (was `min-h-screen`) and `<main>` is the only scroll context, so long tables don't push the sidebar off-screen.
- **`FUNCTION_ENV_KEY` and `API_PUBLIC_URL` forwarded to the dashboard container** — both were latent bugs. `FUNCTION_ENV_KEY` was added in v1.0.0 but never wired through `docker-compose.yml`, so encrypted-env reads would have failed in a containerized install with a missing-key error. `API_PUBLIC_URL` is needed by `lib/minio.ts` to know which endpoint to sign storage URLs against.
- **MinIO `MINIO_BROWSER_REDIRECT_URL`** — now derived from `DASHBOARD_PUBLIC_URL` instead of `MINIO_PUBLIC_URL` (MinIO's console isn't publicly exposed and the old env var is gone).

### Removed

- **`files.*` hostname** — Caddy block and DNS record both retired. MinIO is internal-only, reached exclusively through `api.*/storage/v1/object/*`.
- **`FILES_HOST` and `MINIO_PUBLIC_URL` env vars** — gone from `.env.example`, `docker-compose.yml`, and both deployment guides.
- **Dead helpers** — `lib/minio.ts:minioPublicBaseUrl()` and `lib/storage.ts:publicReadPolicy()` (briefly removed earlier in this cycle, then restored when the visibility mirror returned); the abandoned `lib/storage-signing.ts` HMAC scheme that the first storage-proxy iteration used.

### Breaking

- **All public API URLs moved to `api.*` with new prefixes.** Tables at `https://api.<host>/<table>` → `https://api.<host>/rest/v1/<table>`. The same applies to RPC, auth, realtime, functions, and storage. Clients pointed at the old paths will 404. `dashboard.<host>` returns 404 for those paths now (used to forward them to the dashboard process); update any internal callers.
- **`files.<host>` is gone.** Existing presigned URLs from v1.2.0 stop resolving after the Caddy reload. The dashboard's Share button reissues against the new host; rerun any pinned share links you want to keep.
- **Public buckets need their MinIO ACL re-saved once.** The v1.2.0 → v1.3.0 churn intentionally cleared MinIO's anonymous-read policy mid-transition, then put it back in the final design. Open each public bucket's policy modal once and click Save — the dashboard re-mirrors the ACL, no other action needed.
- **`AUTH_ALLOWED_ORIGINS` is empty by default.** Browser apps from any cross-origin host will be blocked by CORS until this is set (`*` for local dev, explicit origin list for production). Non-browser clients (curl, server-to-server) work without it.
- **`FUNCTION_ENV_KEY` is now required at container start.** Existing installs that worked through v1.2.0 by chance (the env key wasn't enforced) will now fail to start the dashboard container until the key is in `.env`. Generate with `openssl rand -hex 32`.

## [1.2.0] - 2026-05-26

Design refresh for the login page.

### Changed

- **Login page redesign** — visual overhaul of `/login`. Layout, typography, and form styling refreshed; supporting UI extracted into `dashboard/app/login/_components/` for reuse and clarity.

## [1.1.0] - 2026-05-22

Operability + performance pass. The home page now gives admins a live overview, audit-log growth is bounded by a configurable retention window, deletes go through a single confirmation modal, and the data path is sized for a few hundred concurrent users via connection pooling + edge-function compile caching.

### Added

- **Edge function JWT gate** — new `verify_jwt` flag on `_dashboard.functions`, default ON. When on, `/functions/v1/<name>` requires a valid JWT signed with `PGRST_JWT_SECRET` (the same secret PostgREST uses). Accepts `Authorization: Bearer <token>`, the `apikey:` header (Supabase-client convention), or `?token=` for `EventSource`-style callers. Missing or invalid tokens get `401` with an audit row. The function receives the verified claims as `ctx.user = { id, email, role }` (each nullable) — `role` is the discriminator (`"anon"` / `"authenticated"` / `"service_role"`). Cron-triggered runs bypass the gate (they never enter the HTTP route).
- **API keys page** — `/admin/api-keys`. Renders the anon key (always visible) and the service-role key (masked behind a Reveal button) with copy buttons and inline guidance on which to use where. Both keys are deterministic JWTs derived from `PGRST_JWT_SECRET` (no `iat`, fixed `exp` of 2100-01-01) so they're stable across restarts. Every page visit writes an `api_keys.view` audit row.
- **Home overview** — admin-only Resource counts (tables, storage objects, edge functions, cron jobs, end users, audit rows), Server capacity used (database size, object storage, audit JSONL files), and live Database health (`pg_stat_activity` connections, cache hit ratio with colour-coded thresholds, longest active query).
- **Audit-log retention** — configurable from Admin → Audit settings. Defaults to 30 days. A daily in-process sweeper deletes rows older than `audit_retention_days`. Stores the last-deleted row's hash in `audit_chain_anchor` so the chain verifier still works on the retained window. Manual "Run prune now" button for ad-hoc runs.
- **Reusable confirm-delete modal** — `(app)/_components/ConfirmDeleteForm.tsx`. Replaces `window.confirm` + bare submit forms across cron jobs, function env vars, function "Danger zone", storage bucket / object, and end-user deletes. Each callsite has a tailored message about the side effects.
- **Cron schedule help** — small `?` icon next to the Schedule field in the cron-job modal expands an inline reference (field layout, operators, examples, UTC note).
- **Edge function trigger metadata** — every invocation (HTTP or cron-driven) writes one `function.invoke` audit row via a shared `auditInvocation` helper. New **Trigger** column on the invocations page shows `HTTP` or `cron: <job-name>`.
- **Server-side edge function syntax check** — `validateFunctionCode()` runs the same `new AsyncFunction(...)` compile step on save. Bad code is rejected with the SyntaxError, not silently stored.
- **PgBouncer service** — transaction-pool multiplexer in front of Postgres. PostgREST and the dashboard's general queries now route through `pgbouncer:6432`; realtime keeps a direct connection to Postgres for `LISTEN`. Image built from `pgbouncer/Dockerfile` (Alpine + the `pgbouncer` package); config generated from env vars at container start. Defaults: `pool_mode = transaction`, `default_pool_size = 30`, `max_client_conn = 1000`.
- **Realtime connection pool** — new `realtimePool()` in `lib/db.ts` bypasses PgBouncer (max 50, no statement timeout) so SSE `LISTEN` connections survive.
- **Edge function compile cache** — `getCompiled(fn)` keyed by `name + updated_at`. Repeat invocations skip the per-call `new AsyncFunction(...)` parse; edits bust the cache automatically via `updated_at = now()`.

### Changed

- **Connection pool sizes** — dashboard `pg.Pool max`: 10 → 30; `PGRST_DB_POOL`: 10 → 30.
- **Postgres `max_connections`** — 100 → 150 via the postgres service `command:` override. Postgres container recreates to pick this up.
- **PostgREST tuning for transaction pooling** — `PGRST_DB_PREPARED_STATEMENTS=false` (server-side prepared statements don't survive transaction pooling), `PGRST_DB_CHANNEL_ENABLED=false` (schema-cache reload via `LISTEN pgrst` doesn't either; restart PostgREST after DDL changes).
- **Password generation guidance in `README.md`** — `openssl rand -hex 24` instead of `openssl rand -base64 24`. Base64 can include `/` and `+`, both of which break URL-form Postgres connection strings.

### Database

- Migrations **0012** (`audit_retention_days = 30` seeded into `_dashboard.settings`), **0013** (`GRANT pg_read_all_stats TO dashboard_admin`, so the Home DB-health card can see all sessions), **0014** (`verify_jwt boolean DEFAULT true` on `_dashboard.functions`), and **0015** (`ALTER ROLE … SET statement_timeout = '30s'` for `dashboard_admin` and `authenticator`, since PgBouncer drops the client-side startup param). Applied in order via the existing major-upgrade flow.
- `postgres/init/03_audit_log.sql` and `02_roles.sql` mirror these for fresh installs.

### Security

- Edge function endpoints are no longer open by default. Existing functions retain whatever behaviour their code already implemented; the new `verify_jwt` toggle is on by default, so a fresh function won't accept anonymous calls without an admin explicitly opting it out.
- `PGRST_JWT_SECRET` is now passed to the dashboard container (latent bug — `/auth/v1/signin` and `/realtime` were both reading it via `process.env` but `docker-compose.yml`'s dashboard service was never forwarding it from `.env`).
- `pg_read_all_stats` is a built-in read-only stats privilege; it does not grant access to any data, only to `pg_stat_*` views.
- The audit chain verifier now seeds `expectedPrev` from `audit_chain_anchor` so retention pruning cannot silently truncate undetected — the anchor must match the oldest surviving row's `prev_hash`.

### Breaking

- **Edge functions now require a JWT by default.** All functions created before this release get `verify_jwt = true` from the migration's column default, so existing public endpoints will start returning `401 missing_token`. To restore the previous behaviour for a specific function, untick "Verify JWT" on its Overview tab. Clients that should keep working without changes should switch to sending the anon key (visible at `/admin/api-keys`) in the `apikey:` header.
- The new `pgbouncer` service means `scripts/deploy.sh` is **not** enough on existing servers — it runs `--no-deps`, which won't create new services or recreate `postgrest` / `postgres` with the new connection-string and command-line settings. First upgrade requires a full `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`.
- Recreating `postgres` triggers a few seconds of downtime. The `postgres-data` volume is preserved, so no data loss.
- After upgrade, **schema changes (new tables, columns) require `docker compose restart postgrest`** to refresh PostgREST's schema cache — auto-reload via `LISTEN` is disabled to be compatible with PgBouncer transaction mode.
- Any pre-existing `.env` with a `/` in `AUTHENTICATOR_PASSWORD` (older `openssl rand -base64 24` output) must be rotated. `ALTER ROLE authenticator WITH PASSWORD '<new>';` and update `.env`, then `docker compose up -d --force-recreate pgbouncer postgrest`.

## [1.0.0] - 2026-05-21

Dashboard milestone. Operator console now covers tables, SQL, storage, audit, end-user auth, realtime, edge functions, and cron — bringing the platform to feature parity with the core Supabase Studio surface.

### Added

- **Dashboard layout** — left sidebar, Supabase-style nested sub-sidebars on Tables, Storage, Functions; reusable `Card` panel surface; per-page max-widths and centering where appropriate.
- **Three-role user model** (`admin` / `read_write` / `read_only`) on dashboard operators, with middleware-enforced admin gating for `/admin/*` routes.
- **Tables browser** — schema picker covering every non-system schema, paginated row view with column types, sensitive-column masking for password hashes and refresh tokens.
- **SQL Editor** — CodeMirror with PostgreSQL highlighting, Ctrl/Cmd+Enter to run, role-gated (`read_only` restricted to SELECT/WITH/EXPLAIN/SHOW), snippet sidebar, audit logging of every statement.
- **Storage** — bucket browser sub-sidebar, per-bucket policy (visibility, max upload MB, MIME allowlist) mirrored to MinIO bucket policy, file detail side panel with preview (image/video/audio/PDF/text), Share button with presigned URLs for private buckets / direct URLs for public.
- **Audit log viewer** — paginated table with filters (actor / action / date / result) and a chain verifier that walks the SHA-256 chain and flags tampering.
- **End-user authentication** (`auth` schema) — email/password + Microsoft OAuth 2.0 / OIDC, JWT issuance signed with `PGRST_JWT_SECRET` (PostgREST accepts the same tokens), refresh-token rotation, identity linking across providers.
- **Auth providers page** — toggle providers on/off, configure Microsoft client ID/secret/tenant, view derived redirect URI + authority URL with copy buttons.
- **Email-provider policy** — minimum password length, password requirements (lowercase/uppercase/digits/symbols), HaveIBeenPwned k-anonymity leak check enforced at signup. Toggles persisted for upcoming features (secure email change, OTP) marked as "not enforced".
- **End users page** — list/disable/enable/delete/reset password for `auth.users` accounts; revokes active sessions on disable + password reset.
- **Realtime** — per-table pg_notify trigger toggled from `/admin/realtime`, SSE endpoint at `/realtime?schema=X&table=Y` (JWT-protected) with heartbeats and clean teardown.
- **Edge functions** — `_dashboard.functions` table, in-process JavaScript executor with timeout and audited invocations, function detail page with Overview / Code / Invocations / Logs tabs, CodeMirror JS editor with Ctrl/Cmd+S to save, public HTTP endpoint at `/functions/v1/<name>`. Capabilities: `req` (Web Request), `ctx.env`, `ctx.db.query`, `fetch`.
- **Encrypted environment variables** — global env vars at `/admin/functions/env`, AES-256-GCM stored in `auth.providers`-style ciphertext column, UI shows first-3-chars masked preview, edit modal never displays current value, ciphertext masked in the tables browser.
- **Cron jobs** — node-cron scheduler initialised via `instrumentation.ts`, per-job schedule + function binding, status / last-run / last-error tracked per job. Job invocations carry an `X-Cron-Trigger` header.

### Database

- Migrations 0001 → 0011 (users + audit, bucket policies, auth schema, auth settings, realtime, function env, function env encryption, cron jobs). The migration runner is unchanged; apply each in order on first upgrade.
- `dashboard_admin` granted `USAGE/CREATE` on `public` plus full table/sequence/function access with default privileges; `BYPASSRLS` so the operator console sees every row.

### Security

- Encryption at rest for global function env vars (AES-256-GCM, key from `FUNCTION_ENV_KEY`).
- Sensitive columns (`_dashboard.function_env.value*`, `_dashboard.users.password_hash`, `auth.users.encrypted_password`, `auth.sessions.refresh_token_hash`) are masked in the tables browser.
- Audit log records every state-change action (login, user CRUD, SQL run, storage policy / object change, function invoke / save, cron save, realtime toggle, etc.) with the hash chain extending across new actions.
- `audit_log.actor_id` removed from the hashed body — was unstable due to `ON DELETE SET NULL`; the immutable `actor` (email) is hashed instead.

### Breaking

- `_dashboard.admins` renamed to `_dashboard.users` with a new `role` column; existing rows are mapped during the 0001 migration (`admin` preserved, `guest` mapped to `read_only`). Hard-coded `guest` role removed.
- The dashboard's bundled Caddy is unchanged, but the project supports being fronted by an external reverse proxy (see `docs/DEPLOY.md` → Part 3 Option B) — in that mode the Caddyfile is patched locally to serve plain HTTP only.

## [0.1.0] - 2026-05-19

First milestone. Auth + reverse proxy + sample API working end-to-end. No dashboard features yet.

### Added
- Docker Compose orchestration for Postgres 16, PostgREST, MinIO, Caddy, and the dashboard.
- Postgres init scripts: `pgcrypto`, four roles (`anon`, `authenticated`, `service_role`, `dashboard_admin` + `authenticator` for PostgREST), private `_dashboard` schema, audit log table, sample `todos` table with RLS (anon SELECT, authenticated INSERT).
- Caddy reverse proxy with TLS — `tls internal` for local `*.localhost` dev; ACME / Let's Encrypt in prod.
- Next.js 15 admin dashboard with `/login`, an authenticated landing page, iron-session-encrypted cookies, Argon2id password hashing via `@node-rs/argon2`, and audit logging of login / logout.
- Interactive admin bootstrap CLI: `npm run create-admin` (no plaintext password ever touches `.env`).
- Container `HEALTHCHECK` on the dashboard; `scripts/deploy.sh` uses `up -d --no-deps --wait dashboard` so Postgres / MinIO / Caddy are untouched on deploy.
- GitHub Actions workflow that builds the dashboard image and publishes it to GHCR with `:latest` + `:<short-sha>` on main and `:X.Y.Z` + `:X.Y` on version tags.
- `SECURITY.md` and AGPL-3.0 LICENSE.

### Security
- Hard role separation: `dashboard_admin` is **not** granted to `authenticator`, so the dashboard's broad-privilege DB role is unreachable through PostgREST.
- Session cookies are encrypted with `SESSION_SECRET` (≥32 chars enforced at module load).
- Server actions on `/login` enforce same-origin posts (Next.js built-in).

[Unreleased]: https://github.com/OneCodeApS/Onebase/compare/v2.0.2...HEAD
[2.0.2]: https://github.com/OneCodeApS/Onebase/releases/tag/v2.0.2
[1.3.5]: https://github.com/OneCodeApS/Onebase/releases/tag/v1.3.5
[1.3.2]: https://github.com/OneCodeApS/Onebase/releases/tag/v1.3.2
[1.3.1]: https://github.com/OneCodeApS/Onebase/releases/tag/v1.3.1
[1.3.0]: https://github.com/OneCodeApS/Onebase/releases/tag/v1.3.0
[1.2.0]: https://github.com/OneCodeApS/Onebase/releases/tag/v1.2.0
[1.1.0]: https://github.com/OneCodeApS/Onebase/releases/tag/v1.1.0
[1.0.0]: https://github.com/OneCodeApS/Onebase/releases/tag/v1.0.0
[0.1.0]: https://github.com/OneCodeApS/Onebase/releases/tag/v0.1.0
