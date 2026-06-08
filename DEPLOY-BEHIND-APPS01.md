# Deploying Onecodebase behind APPS01

OneCode's internal pattern: APPS01 in DMZ handles all public TLS via its native Caddy. App servers (this stack included) run in LAN and serve plain HTTP only. The two are bridged by a Miit firewall rule.

This guide replaces the upstream [`DEPLOYMENT.md`](./DEPLOYMENT.md) for any server deployed behind APPS01.

## Architecture

```
Internet → 109.200.76.147 (APPS01 + Caddy, TLS termination + Let's Encrypt)
            ↓ HTTP, internal LAN
        10.1.116.x:80 (this server's bundled Caddy, routes by Host header)
            ↓
        postgrest:3000 / dashboard:3000 / minio:9000 (Docker)
```

- **APPS01** (`10.1.116.34`, DMZ) — public Caddy with Let's Encrypt. One `.caddy` site file per app server's set of subdomains.
- **App server** (this stack, e.g. `OC-TestServer01` at `10.1.116.4`, LAN) — Docker stack with internal Caddy serving plain HTTP. No public exposure.
- **Miit firewall** — must allow APPS01 → app server on TCP 80. Open one rule per new app server.

## Prerequisites

- App server provisioned in LAN with a private IP.
- Docker + Compose v2 installed (`curl -fsSL https://get.docker.com | sh`).
- The deploy user (e.g. `onecode`) in the `docker` group: `sudo usermod -aG docker onecode && newgrp docker`.
- Two subdomains (`api.*`, `dashboard.*`) created at Curanet, both pointing to `109.200.76.147` (APPS01). Storage no longer needs its own subdomain.
- Miit firewall rule confirmed open: APPS01 (`10.1.116.34`) → this server's IP on TCP 80.

## Setup steps

### 1. On the app server: clone and configure

```bash
sudo mkdir -p /opt/onecodebase
sudo chown onecode:onecode /opt/onecodebase
git clone https://github.com/OneCodeApS/Onecodebase.git /opt/onecodebase
cd /opt/onecodebase
git fetch --tags
git checkout v0.1.0
```

### 2. Replace `caddy/Caddyfile` with the HTTP-only version

APPS01 handles TLS, so this server's Caddy only does internal Host-header routing on port 80. Start from the bundled `caddy/Caddyfile`, change each site address from `{$HOST}` to `http://{$HOST}`, and delete the `tls {$CADDY_TLS}` lines — APPS01 terminates TLS, so this Caddy must not.

> **Caddyfile syntax gotcha — keep every block multi-line.** An opening `{` must be the last token on its line, and a closing `}` must sit on its own line. Do **not** collapse a route onto one line like `handle_path /x/* { reverse_proxy y }` — Caddy's adapter rejects it, the container exits 1, and `docker compose ps` shows `caddy` stuck `Restarting`. Write it out exactly as below.

```bash
{
echo "(dashboard_lb) {"
echo "    reverse_proxy {"
echo "        dynamic a {"
echo "            name dashboard"
echo "            port 3000"
echo "            refresh 30s"
echo "            resolvers 127.0.0.11"
echo "        }"
echo "        lb_policy least_conn"
echo "    }"
echo "}"
echo ""
echo "http://{\$API_HOST} {"
echo "    handle_path /rest/v1/* {"
echo "        reverse_proxy postgrest:3000"
echo "    }"
echo "    handle_path /rpc/v1/* {"
echo "        rewrite * /rpc{uri}"
echo "        reverse_proxy postgrest:3000"
echo "    }"
echo "    handle /auth/v1/* {"
echo "        import dashboard_lb"
echo "    }"
echo "    handle /realtime* {"
echo "        import dashboard_lb"
echo "    }"
echo "    handle /functions/v1/* {"
echo "        import dashboard_lb"
echo "    }"
echo "    handle /storage/v1/object/sign-batch {"
echo "        import dashboard_lb"
echo "    }"
echo "    handle /storage/v1/object/sign/* {"
echo "        import dashboard_lb"
echo "    }"
echo "    handle /storage/v1/object/upload/* {"
echo "        import dashboard_lb"
echo "    }"
echo "    handle_path /storage/v1/object/* {"
echo "        reverse_proxy minio:9000 {"
echo "            header_up Host {host}"
echo "        }"
echo "    }"
echo "    handle {"
echo "        respond 404"
echo "    }"
echo "}"
echo ""
echo "http://{\$DASHBOARD_HOST} {"
echo "    import dashboard_lb"
echo "}"
} > caddy/Caddyfile
```

Validate the syntax before relying on it. The `caddy:2.8-alpine` image has **no `caddy` entrypoint**, so the command must start with `caddy`; the dummy env values just satisfy the `{$…}` placeholders:

```bash
docker run --rm \
  -e API_HOST=api.example -e DASHBOARD_HOST=dashboard.example -e CADDY_TLS=internal \
  -v "$(pwd)/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2.8-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

Expect `Valid configuration`. Whenever you edit this file on a running stack, validate the same way and then `docker compose -f docker-compose.yml -f docker-compose.prod.yml restart caddy` to load it.

### 3. Generate `.env` with hex-only passwords

**Critical:** do NOT use `openssl rand -base64` for any password. Base64 contains `/`, `+`, and `=`, which break the URI-embedded password pattern in `docker-compose.yml`. Always use hex.

Fill in the two subdomain values for this server before pasting:

```bash
{
echo "POSTGRES_DB=postgres"
echo "POSTGRES_USER=postgres"
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
echo "AUTHENTICATOR_PASSWORD=$(openssl rand -hex 24)"
echo "DASHBOARD_ADMIN_PASSWORD=$(openssl rand -hex 24)"
echo "PGRST_JWT_SECRET=$(openssl rand -hex 32)"
echo "MINIO_ROOT_USER=onecodebase"
echo "MINIO_ROOT_PASSWORD=$(openssl rand -hex 24)"
echo "SESSION_SECRET=$(openssl rand -hex 32)"
echo "API_HOST=api.<your-subdomain>.madebyonecode.dk"
echo "DASHBOARD_HOST=dashboard.<your-subdomain>.madebyonecode.dk"
echo "API_PUBLIC_URL=https://api.<your-subdomain>.madebyonecode.dk"
echo "DASHBOARD_PUBLIC_URL=https://dashboard.<your-subdomain>.madebyonecode.dk"
echo "CADDY_TLS=internal"
echo "GHCR_OWNER=onecodeaps"
echo "DASHBOARD_IMAGE_TAG=0.1.0"
} > .env
```

The `_PUBLIC_URL` values use `https://` because that's what the public hits APPS01 with — even though this server serves HTTP internally.

### 4. Bring up the stack

Do NOT use `scripts/deploy.sh` for the first deploy — it does `git pull --ff-only` which fails in detached HEAD and conflicts with the local `Caddyfile` mod. Bring up directly:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull dashboard
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --wait
```

All five containers should report healthy in ~30 seconds. Verify:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
```

On this first boot the `postgres/init/*.sql` scripts build the **complete** schema — roles, auth (users/identities/sessions/magic-link/settings/providers), storage bucket policies, edge functions, function env, cron jobs, realtime, and the audit log. A fresh deploy therefore needs **no migration step**; `postgres/migrations/*.sql` only matters when upgrading an existing install (see [`UPDATE-BEHIND-APPS01.md`](./UPDATE-BEHIND-APPS01.md)). The dashboard's cron scheduler and audit-retention sweeper start cleanly against this schema on first launch.

Smoke-test from the server itself (substitute your actual subdomain):

```bash
curl -s -i -H 'Host: api.<your-subdomain>.madebyonecode.dk' http://localhost/todos
```

Expected: `200 OK` with two seeded todos.

### 5. Create the admin user

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm dashboard npm run create-admin
```

Prompts for email + password (12+ chars). Password is Argon2id-hashed in memory; only the hash is stored.

### 6. On APPS01: add the reverse-proxy site file

```bash
sudo bash -c '{
echo "api.<your-subdomain>.madebyonecode.dk {"
echo "    import logging"
echo "    reverse_proxy <app-server-ip>:80 {"
echo "        header_up Host {host}"
echo "        header_up X-Real-IP {remote_host}"
echo "    }"
echo "}"
echo ""
echo "dashboard.<your-subdomain>.madebyonecode.dk {"
echo "    import logging"
echo "    reverse_proxy <app-server-ip>:80 {"
echo "        header_up Host {host}"
echo "        header_up X-Real-IP {remote_host}"
echo "    }"
echo "}"
} > /etc/caddy/sites/<your-subdomain>.caddy'

sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl restart caddy
```

`header_up Host {host}` is the critical line — without it, both subdomains look identical to the app server's Caddy and routing fails.

Watch Caddy acquire the two Let's Encrypt certs:

```bash
sudo journalctl -u caddy -f --since "30 seconds ago"
```

Look for two `certificate obtained successfully` lines, one per subdomain.

### 7. Test end-to-end from your laptop

```cmd
curl -I https://api.<your-subdomain>.madebyonecode.dk/rest/v1/todos
curl -I https://dashboard.<your-subdomain>.madebyonecode.dk
```

Expected: `200` (with two seeded todos), `307` (redirect to /login).

Open the dashboard in a browser and sign in with the admin you created.

## Running multiple dashboard replicas (HA)

The dashboard is stateless apart from two background jobs — the cron scheduler and the audit-log retention sweeper — which are **leader-elected** via a Postgres advisory lock (`dashboard/lib/scheduler.ts`). So you can run any number of replicas: exactly one holds the lock and runs the jobs, and if it dies another takes over within ~15s. Sessions are iron-session cookies (signed, stateless), so **no sticky sessions** are needed; Caddy round-robins freely.

`docker-compose.prod.yml` ships `deploy.replicas: 2`, and the Caddyfile from step 2 already load-balances across them via the `dashboard_lb` snippet (dynamic DNS upstreams — a plain `reverse_proxy dashboard:3000` would **not** spread load across replicas, it pins to one). A normal `up -d --wait` brings up both:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --wait
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps   # 2 dashboard containers, both healthy
```

Change the count with `--scale` (overrides the compose default):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --scale dashboard=3
```

If you only want **one** replica (small server), set `deploy.replicas: 1` in `docker-compose.prod.yml` — everything behaves exactly as the single-process setup did.

### Connection budget

Realtime fans out over a **single shared `LISTEN` connection per replica** (`dashboard/lib/realtime-listener.ts`): a thousand open chat/SSE streams cost **one** Postgres connection, not one each. So each replica's direct-to-Postgres footprint (the connections that must bypass PgBouncer) is tiny and constant:

- 1 realtime fan-out connection, plus
- 1 leader-election connection (on the leader replica only).

That's ~1–2 direct connections per replica, so you can scale `dashboard` well past 2 without approaching Postgres `max_connections` (**150**, in `docker-compose.yml`). PgBouncer-routed traffic (PostgREST + the dashboard's general queries, pooled at 30 each) is separate and multiplexed.

> Earlier versions held one Postgres connection *per* SSE subscriber, which capped concurrent realtime users at ~50/replica and made this the scaling ceiling. The fan-out hub removed that — realtime concurrency is now bounded by memory, not DB connections.

### Verify leadership after scaling

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs dashboard | grep -E '\[scheduler\]|\[leader\]'
```

Expect **exactly one** `[scheduler] acquired leadership` line; the other replicas log `[leader] another replica holds the scheduler lock — standing by`. Cron edits made through any replica reach the leader over `NOTIFY cron_reload`, so they still take effect immediately.

## Known problems

### `docker pull` fails: `unauthorized`

The GHCR image visibility is private. Two-step fix (org owner needed):

1. **https://github.com/organizations/OneCodeApS/settings/packages** — enable "Public" for container packages org-wide.
2. **https://github.com/orgs/OneCodeApS/packages/container/onecodebase-dashboard/settings** — Danger Zone → Change visibility → Public.

After that, anyone (any server) can pull anonymously.

### Build & Release workflow fails with `No '## [X.Y.Z]' section in CHANGELOG.md`

The workflow's version-bump (`patch`/`minor`/`major`) computes the next version from git tags. With no tags present, `patch` produces `0.0.1` — which won't match the existing `## [0.1.0]` section in `CHANGELOG.md`.

Fix: pick `minor` (gives `0.1.0`, matching the changelog entry) for the very first release. After that, use `patch` for subsequent releases as normal.

### Dashboard build fails: `Property 'save' does not exist on type 'Session'`

iron-session typing under Next.js 16 doesn't infer `IronSession<Session>` from `getIronSession<Session>(...)` correctly. Fixed in `dashboard/lib/session.ts` v0.1.0:

```typescript
import { getIronSession, type IronSession, type SessionOptions } from "iron-session";
// ...
export async function getSession(): Promise<IronSession<Session>> {
  return getIronSession<Session>(await cookies(), sessionOptions());
}
```

### PostgREST returns `PGRST002` then `PGRST000` with `could not look up local user ID 1000`

The connection URI got mangled. Cause: a password generated with `openssl rand -base64 24` contains `/`, `+`, or `=`, which break URI parsing. libpq falls back to "current OS user," can't find UID 1000 in the slim image's `/etc/passwd`, and throws.

Fix: regenerate the password with `openssl rand -hex 24` (URL-safe), then wipe the postgres volume so init scripts re-run with the new value:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml down -v
# edit .env, replace the bad password
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --wait
```

The `-v` flag is critical — without it the postgres volume persists and the old broken passwords stay on the roles.

### `scripts/deploy.sh` fails with `You are not currently on a branch`

The script does `git pull --ff-only`, which requires being on a branch. Checking out a release tag (`git checkout v0.1.0`) puts you in detached HEAD, breaking the script.

Fix for first deploy: skip the script, run the underlying steps manually (see step 4 above).

Fix for future deploys: stay on `master`, use `DASHBOARD_IMAGE_TAG` in `.env` to pin the version, and tell git to ignore the local Caddyfile mod so the script's `git pull` doesn't conflict:

```bash
git checkout master
git update-index --skip-worktree caddy/Caddyfile
./scripts/deploy.sh 0.2.0
```

### `systemctl reload caddy` fails with `connection refused` on localhost:2019

The running Caddy on APPS01 was started with `admin off` in the global block, which disables the localhost admin API. `caddy reload` uses that API to hot-swap config.

Fix: use `restart` instead of `reload`. Brief downtime (~1 second), invisible to anything except active WebSockets.

```bash
sudo systemctl restart caddy
```

### Heredoc (`cat > file << EOF`) hangs with terminal auto-indent

Some Windows SSH clients auto-indent pasted content, including the closing `EOF` line. Heredoc requires the terminator at column 0 (or `<<-EOF` with leading tabs only — not spaces).

Symptom: bash sits at the `>` continuation prompt and the file is never written.

Fix: use an `echo` loop with a single redirect at the end. Leading whitespace on each line is just passed to echo as part of the command:

```bash
{
echo "line one"
echo "line two"
} > file
```

### `docker ps` says "permission denied" but doesn't error visibly

If your earlier check was `docker ps -a 2>/dev/null || echo "docker not installed"`, the stderr redirect hides the permission-denied message and the `||` runs, producing a false-negative "docker not installed."

Fix: add the user to the docker group and verify:

```bash
sudo usermod -aG docker onecode
newgrp docker
docker ps
```

### `docker compose down` without `-v` leaves stale Postgres data

Postgres init scripts only run when the data directory is empty. Without `-v`, the volume persists between `down`/`up` cycles, so changes to passwords in `.env` are ignored — the roles still have whatever password was set the first time the volume was created.

Always use `down -v` when you want a true reset.

## When deploying additional servers

For each new app server (e.g. OneVoice01):

1. Open a Miit ticket: "Same APPS01 → OC-X pattern, please allow APPS01 (`10.1.116.34`) → `<new-server-ip>` on TCP 80."
2. Create three DNS A records at Curanet, all pointing to `109.200.76.147`.
3. Repeat steps 1–5 above on the new app server.
4. Repeat step 6 above on APPS01 with a new `<your-subdomain>.caddy` file.
5. Repeat step 7 to verify.
