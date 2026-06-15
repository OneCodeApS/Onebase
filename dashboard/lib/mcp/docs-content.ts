// Embedded documentation for the search_docs tool. The repo's markdown docs
// (README, DEPLOY*) live outside the dashboard image's build context, so the
// MCP ships its own agent-oriented summaries. Keep these short, factual, and
// in sync with behaviour — they are what an agent believes about Onebase.

export type DocTopic = {
  slug: string;
  title: string;
  keywords: string[];
  body: string;
};

export const DOC_TOPICS: DocTopic[] = [
  {
    slug: "overview",
    title: "What Onebase is",
    keywords: ["overview", "architecture", "stack", "supabase", "intro", "about"],
    body: `Onebase (Onecodebase) is a self-hosted backend platform: Postgres 18 + PostgREST + MinIO behind Caddy, with a Next.js dashboard that doubles as the API gateway. Single-tenant: one deployment = one isolated instance.

Public API surface (all on the api.* host):
- /rest/v1/<table>  — PostgREST CRUD over the public schema (RLS applies)
- /rpc/v1/<fn>      — PostgREST RPC for SQL functions
- /auth/v1/*        — end-user auth (signin, signup, refresh, magiclink, Microsoft OAuth)
- /storage/v1/*     — signed-URL object storage backed by MinIO
- /realtime         — Server-Sent Events stream of table changes
- /functions/v1/<n> — edge functions (JS, stored in the DB, run in-process)
- /mcp/v1           — this MCP server

The dashboard.* host is the operator console only.`,
  },
  {
    slug: "auth",
    title: "Authentication model",
    keywords: ["auth", "jwt", "token", "signin", "signup", "anon", "service_role", "magic link", "oauth", "microsoft"],
    body: `Two user populations:
1. Dashboard operators (_dashboard.users): admin / read_write / read_only roles, cookie sessions. Not relevant to client apps.
2. End users (auth.users): your app's users. Sign in via /auth/v1/* and receive a 1-hour HS256 access JWT (role "authenticated") plus a 30-day opaque refresh token.

Three JWT roles, all signed with the same PGRST_JWT_SECRET that PostgREST validates:
- anon: long-lived public key, embed in client code; means "known client, no user".
- authenticated: per-user token from /auth/v1/signin or /refresh.
- service_role: server-side admin key, bypasses RLS. Never ship to clients; never exposed via MCP.

Send tokens as "Authorization: Bearer <jwt>" (or "apikey: <jwt>" for the anon key). Browser apps must have their origin allowlisted in AUTH_ALLOWED_ORIGINS.`,
  },
  {
    slug: "rest",
    title: "REST data API (PostgREST)",
    keywords: ["rest", "postgrest", "crud", "select", "insert", "filter", "query", "table", "api"],
    body: `Tables in the public schema are exposed at /rest/v1/<table> with PostgREST semantics:
- Filters: ?id=eq.5, ?title=ilike.*milk*, ?created_at=gte.2026-01-01
- Shaping: ?select=id,title,author:users(name)   Ordering: ?order=created_at.desc
- Pagination: ?limit=20&offset=40 or Range headers
- Writes: POST (insert), PATCH (update — always filter!), DELETE (always filter!)
- Prefer: return=representation to get affected rows back

Authorization is the JWT's role + Postgres RLS policies. After schema changes (new tables/columns), PostgREST's schema cache must be reloaded — use the reload_postgrest_schema MCP tool, or restart the postgrest container if the NOTIFY channel is disabled.`,
  },
  {
    slug: "storage",
    title: "Object storage",
    keywords: ["storage", "bucket", "upload", "download", "file", "minio", "s3", "signed url"],
    body: `Buckets live in MinIO; the dashboard issues short-lived SigV4-signed URLs and the bytes flow directly between client and storage (Node never touches them).

- POST /storage/v1/object/sign/<bucket>/<key>    → signed GET URL
- POST /storage/v1/object/upload/<bucket>/<key>  → signed PUT URL
- POST /storage/v1/object/sign-batch             → many at once
- GET  /storage/v1/object/<bucket>/<key>         → direct fetch (public buckets only)

Bucket policy (visibility public/private, max upload MB, MIME allowlist) is set per bucket. service_role may sign for any bucket; authenticated users only for public buckets — private buckets are signed by your backend after its own authorization check.`,
  },
  {
    slug: "realtime",
    title: "Realtime change streams",
    keywords: ["realtime", "sse", "eventsource", "subscribe", "live", "changes", "notify"],
    body: `GET /realtime?schema=public&table=todos&token=<access_jwt> returns a Server-Sent Events stream. Events carry { type: INSERT|UPDATE|DELETE, schema, table, old, new, ts }. Rows larger than ~8 KB are announced without payload.

Realtime must be enabled per table (Admin → Schema → Realtime; it installs a pg_notify trigger). Only per-user access JWTs are accepted — not the anon or service_role keys. Heartbeats every 25s keep proxies from killing idle streams; EventSource reconnects automatically.

Caution: the stream is table-level, not row-level — RLS does NOT filter events. Don't enable realtime on tables whose rows individual users shouldn't all see.`,
  },
  {
    slug: "functions",
    title: "Edge functions",
    keywords: ["functions", "edge", "serverless", "deploy", "invoke", "cron", "ctx", "env"],
    body: `Edge functions are JavaScript bodies stored in the database and executed in the dashboard process (async function with web-standard fetch/Response/crypto). Available in scope:
- req: the incoming Request
- ctx.env: env vars (global encrypted vars merged with per-function overrides)
- ctx.user: verified JWT claims { id, email, role } or null
- ctx.db.query(sql, params): Postgres as dashboard_admin — full DB access

Config per function: enabled, timeout_ms (5s–60s), verify_jwt (require a valid JWT), min_role (anon | authenticated | service_role floor). Invoke at POST /functions/v1/<name>. Cron jobs (Admin → Cron) invoke functions on a schedule.

Because function code runs with full database access, deploying code is an admin-level operation.`,
  },
  {
    slug: "mcp",
    title: "This MCP server",
    keywords: ["mcp", "agent", "access token", "scopes", "read only", "claude", "cursor"],
    body: `The MCP endpoint is POST ${"$"}{API_PUBLIC_URL}/mcp/v1 (Streamable HTTP, stateless). Auth: "Authorization: Bearer ob_pat_…" using a personal access token created under Admin → Access tokens.

Token capabilities = scopes ∩ owner's current dashboard role ∩ read_only flag. SQL runs through the same Postgres role ladder as the dashboard's SQL editor: read → READ ONLY transaction, write → restricted dashboard_sql_rw role (no DDL), ddl → admin path. Credentials, secrets, and the audit log are not reachable through raw SQL regardless of scope.

Destructive statements (DROP, TRUNCATE, unfiltered DELETE/UPDATE) require a two-step confirm_token. Every tool call is rate-limited and written to the tamper-evident audit log.`,
  },
  {
    slug: "operations",
    title: "Operations: deploy, update, migrations",
    keywords: ["deploy", "update", "migration", "docker", "compose", "backup", "version", "install"],
    body: `Deployment is docker compose (postgres, pgbouncer, postgrest, minio, dashboard, caddy). Production installs pull a prebuilt dashboard image from GHCR and update with ./scripts/deploy.sh <version> — only the dashboard container is replaced; data volumes persist.

Schema lifecycle:
- postgres/init/*.sql runs once on first DB boot (complete snapshot).
- Release migrations (postgres/migrations/NNNN_*.sql) are applied manually per release notes.
- Agent-applied DDL goes through the MCP apply_migration tool, which records every change in the _dashboard.migrations ledger (name, SQL, who, when) and reloads PostgREST's schema cache.

After any DDL, PostgREST needs a schema-cache reload (reload_postgrest_schema tool) before new tables/columns appear under /rest/v1.`,
  },
  {
    slug: "security",
    title: "Security model",
    keywords: ["security", "rls", "roles", "audit", "rate limit", "cors", "secrets", "policy"],
    body: `Layers:
- Postgres roles: anon (unauthenticated PostgREST), authenticated (RLS applies), service_role (BYPASSRLS, server-side only), dashboard_admin (dashboard's own connection), dashboard_sql_rw (restricted DML role for non-admin SQL).
- RLS policies on public-schema tables are the per-row authorization mechanism for client apps.
- Audit: every meaningful action (dashboard and MCP) lands in _dashboard.audit_log, a SHA-256 hash chain — silent edits/deletes are detectable (verify_audit_chain tool). A JSONL copy is written to disk.
- Rate limits: DB-backed, per-area (signin/signup/magiclink/mcp), hold across replicas.
- Secrets: function env vars are AES-256-GCM encrypted at rest; access tokens are stored as SHA-256 hashes.

Run the get_advisors tool for an instance-specific posture report.`,
  },
];
