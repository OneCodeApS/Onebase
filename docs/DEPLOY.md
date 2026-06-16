# Deploying Onebase

The canonical way OneCode deploys Onebase. The method is **always the same**:

1. **Deploy the Onebase backend** — identical every time (Part 2).
2. **Expose it through a Caddy front** — pick the front that fits (Part 3).

> **This guide covers standing the stack up (install + topology).** Day-2 operations —
> updating, backups & restore, Postgres major upgrades, rollback, HA, and troubleshooting —
> live in [`OPERATIONS.md`](./OPERATIONS.md).

## The model

- **BACKEND BOX** — runs the **entire Onebase stack** in Docker (Postgres, PgBouncer, PostgREST,
  MinIO, dashboard, and an internal Caddy). It serves **plain HTTP on port 80** and is **never exposed
  to the internet**. **All data lives here** (Postgres + MinIO volumes).
  > Despite often being called the "DB server," this box runs the *whole* stack — not just Postgres.
  > We do **not** split Postgres onto its own machine.
- **PUBLIC FRONT** — a Caddy that terminates public TLS (Let's Encrypt) and reverse-proxies the Onebase
  hostnames to the backend's `:80`, preserving the `Host` header. Two flavours:
  - **Dedicated front (default, Part 3 Option A)** — a per-backend front box, which also hosts that
    project's apps. Isolated and self-contained.
  - **Shared front (Part 3 Option B)** — one central Caddy box fronting several backends. Cheaper, but
    everything funnels through one box and one public IP.

**The backend is byte-for-byte the same in both.** The only thing that differs is the front.

```
            Internet
               │  (Onebase hostnames' DNS → the FRONT's public IP)
               ▼
   ┌──────────────────────────────┐
   │ PUBLIC FRONT  (Caddy + TLS)   │   dedicated (App server) OR shared (central box)
   │ <FRONT_IP> / <FRONT_PUB_IP>   │   + hosts apps, if dedicated
   └───────────────┬──────────────┘
                   │ HTTP, LAN only, Host header preserved
                   ▼
   ┌──────────────────────────────┐
   │ BACKEND BOX  <BACKEND_IP>     │   full Onebase stack in Docker, internal Caddy :80
   │ (no public IP)                │   ALL DATA: Postgres + MinIO volumes
   └──────────────────────────────┘
```

> **Apps are clients of the Onebase endpoint.** Anything you build talks to Onebase through the stable
> public URL `https://api.<PLATFORM>.<DOMAIN>` (plus its keys) and behaves identically wherever it runs.
> Deploying an app (e.g. via CI/CD onto a dedicated front box) does **not** change the Onebase setup.
> One backend serves many apps. The only time an app touches this guide is if it needs its **own**
> public hostname — see "Adding an app's own hostname" near the end.

## Placeholders used in this guide

Replace these everywhere they appear:

| Placeholder | Meaning | Example |
| --- | --- | --- |
| `<PLATFORM>` | the Onebase hostname slug | `milton` |
| `<DOMAIN>` | your base domain | `madebyonecode.dk` |
| `<BACKEND_IP>` | LAN IP of the box running the Onebase stack | `10.1.116.83` |
| `<FRONT_IP>` | LAN IP of the public front box | `10.1.116.98` |
| `<FRONT_PUB_IP>` | public IP that reaches the front | `203.0.113.10` |
| `<DEPLOY_USER>` | non-root deploy user (in `docker` group) | `onecode` |
| `<VERSION>` | release tag to deploy | `v2.0.0` |
| `<APP_HOST>` | a hosted app's own public hostname (optional) | `vw.madebyonecode.dk` |
| `<APP_PORT>` | local port a hosted app listens on (optional) | `8080` |

Onebase public hostnames (two): `api.<PLATFORM>.<DOMAIN>` and `dashboard.<PLATFORM>.<DOMAIN>`.

---

## Part 1 — Networking prerequisites (get these right first)

The most common failure is public traffic not reaching the front. Lock these down **before** touching
Let's Encrypt:

1. **DNS** — both Onebase hostnames → the **front's** public IP:
   - `api.<PLATFORM>.<DOMAIN>` → `<FRONT_PUB_IP>`
   - `dashboard.<PLATFORM>.<DOMAIN>` → `<FRONT_PUB_IP>`
2. **Inbound 80 + 443** from the internet must forward to the **front** (`<FRONT_IP>`).
   > ⚠️ **Each public-facing front needs its OWN public IP for ports 80/443.** A public port can only
   > forward to one host. If two DMZ servers are NAT'd behind the same public IP, inbound 80/443 land on
   > whichever one the gateway points at, and Let's Encrypt fails on the other with
   > `remote error: tls: internal error`. Confirm with your network team that this front's public IP
   > forwards 80/443 to **this** front box.
3. **Front → backend on TCP 80** must be allowed (they're often in different subnets).
4. **The backend must NOT be reachable from the internet** — ideally the firewall only lets the front
   reach it.

---

## Part 2 — Deploy the Onebase backend (always the same)

All commands run as `<DEPLOY_USER>` on the **backend box** unless prefixed with `sudo`.

### 2.1 Check storage FIRST

Docker stores **all** images, containers, and volumes under its data-root (default `/var/lib/docker`).
The Postgres database and MinIO buckets grow without bound, so the data-root **must** sit on the largest
disk — never on a small `/` or `/var`.

```bash
df -h
```

```
Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1       5.2G  1.3G  3.6G  27% /          ← OS + repo source only
/dev/sda5       2.1G  1.8G  168M  92% /var       ← TOO SMALL — Docker must NOT live here
/dev/sdb1       196G  2.1M  186G   1% /data      ← the big disk → Docker data-root goes here
```

If `/var` is a small dedicated partition, free headroom for the Docker package install:
`sudo apt-get clean` and, if needed, `sudo journalctl --vacuum-size=100M`.

### 2.2 Install Docker and relocate the data-root

```bash
sudo apt-get clean
curl -fsSL https://get.docker.com | sh           # if curl is missing: sudo apt-get install -y curl

sudo usermod -aG docker <DEPLOY_USER>
newgrp docker
docker ps                                         # must succeed, no "permission denied"

# Relocate the data-root to the big disk BEFORE pulling any image.
# `data-root` alone is NOT enough on recent Docker: when the containerd image
# store is active (the default), image layers live under /var/lib/containerd,
# which `data-root` does not move — they end up on /var and fill it. Disabling
# the containerd snapshotter keeps the classic overlay2 store under data-root,
# so images land on the big disk too.
sudo mkdir -p /data/docker
sudo systemctl stop docker
{
echo '{'
echo '  "data-root": "/data/docker",'
echo '  "features": { "containerd-snapshotter": false }'
echo '}'
} | sudo tee /etc/docker/daemon.json
sudo systemctl start docker
docker info | grep "Docker Root Dir"              # MUST print: /data/docker
docker info | grep -i "storage driver"            # MUST print: overlay2 (not a containerd snapshotter)
```

Do not proceed until `Docker Root Dir: /data/docker` **and** `Storage Driver: overlay2`. If a
server was already brought up with the containerd image store on a too-small `/var`, don't
re-pull — relocate the existing store instead (see [`OPERATIONS.md`](./OPERATIONS.md) →
"Image pull fails with no space left on device").

### 2.3 Clone the repo and pin a release

```bash
sudo apt-get install -y git                        # if missing
sudo mkdir -p /opt/onebase
sudo chown <DEPLOY_USER>:<DEPLOY_USER> /opt/onebase
git clone https://github.com/OneCodeApS/Onebase.git /opt/onebase
cd /opt/onebase
git fetch --tags
git tag                                            # list releases
git checkout <VERSION>                             # detached HEAD is expected
```

> The repo is **`OneCodeApS/Onebase`** (not "Onecodebase"). The local directory name is arbitrary.

### 2.4 HTTP-only internal Caddyfile

The backend's Caddy only does internal Host-header routing on port 80 — the front terminates public
TLS, so this Caddy serves **plain HTTP** and must never request a certificate.

> Keep every `{ }` block multi-line — collapsing a route onto one line makes Caddy exit 1 and loop on
> "Restarting". On Windows SSH clients use `echo` loops (heredocs auto-indent and hang), and single-quote
> each line so `!` and `$` aren't interpreted by the shell.

```bash
{
echo '(dashboard_lb) {'
echo '    reverse_proxy {'
echo '        dynamic a {'
echo '            name dashboard'
echo '            port 3000'
echo '            refresh 30s'
echo '            resolvers 127.0.0.11'
echo '        }'
echo '        lb_policy least_conn'
echo '    }'
echo '}'
echo ''
echo 'http://{$API_HOST} {'
echo '    handle_path /rest/v1/* {'
echo '        reverse_proxy postgrest:3000'
echo '    }'
echo '    handle_path /rpc/v1/* {'
echo '        rewrite * /rpc{uri}'
echo '        reverse_proxy postgrest:3000'
echo '    }'
echo '    handle /auth/v1/* {'
echo '        import dashboard_lb'
echo '    }'
echo '    handle /realtime* {'
echo '        import dashboard_lb'
echo '    }'
echo '    handle /functions/v1/* {'
echo '        import dashboard_lb'
echo '    }'
echo '    handle /storage/v1/object/sign-batch {'
echo '        import dashboard_lb'
echo '    }'
echo '    handle /storage/v1/object/sign/* {'
echo '        import dashboard_lb'
echo '    }'
echo '    handle /storage/v1/object/upload/* {'
echo '        import dashboard_lb'
echo '    }'
echo '    handle_path /storage/v1/object/* {'
echo '        reverse_proxy minio:9000 {'
echo '            header_up Host {host}'
echo '        }'
echo '    }'
echo '    handle {'
echo '        respond 404'
echo '    }'
echo '}'
echo ''
echo 'http://{$DASHBOARD_HOST} {'
echo '    import dashboard_lb'
echo '}'
} > caddy/Caddyfile
```

Validate (the `caddy:2.8-alpine` image has no default entrypoint, so the command must start with `caddy`):

```bash
docker run --rm \
  -e API_HOST=api.example -e DASHBOARD_HOST=dashboard.example -e CADDY_TLS=internal \
  -v "$(pwd)/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2.8-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

Expect `Valid configuration`. The "input is not formatted" and "listening only on the HTTP port" warnings
are expected and correct.

### 2.5 Generate `.env`

**Use hex for every secret/password** — `openssl rand -hex`. Never `-base64`: its `/ + =` characters
break the URI-embedded passwords (you get `PGRST000` / `could not look up local user`).

```bash
{
echo "POSTGRES_DB=postgres"
echo "POSTGRES_USER=postgres"
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
echo "AUTHENTICATOR_PASSWORD=$(openssl rand -hex 24)"
echo "DASHBOARD_ADMIN_PASSWORD=$(openssl rand -hex 24)"
echo "PGRST_JWT_SECRET=$(openssl rand -hex 32)"
echo "FUNCTION_ENV_KEY=$(openssl rand -hex 32)"
echo "MINIO_ROOT_USER=onebase"
echo "MINIO_ROOT_PASSWORD=$(openssl rand -hex 24)"
echo "SESSION_SECRET=$(openssl rand -hex 32)"
echo "API_HOST=api.<PLATFORM>.<DOMAIN>"
echo "DASHBOARD_HOST=dashboard.<PLATFORM>.<DOMAIN>"
echo "API_PUBLIC_URL=https://api.<PLATFORM>.<DOMAIN>"
echo "DASHBOARD_PUBLIC_URL=https://dashboard.<PLATFORM>.<DOMAIN>"
echo "CADDY_TLS=internal"
echo "AUDIT_HOST_PATH=/data/audit-logs"
echo "GHCR_OWNER=onecodeaps"
echo "DASHBOARD_IMAGE_TAG=<VERSION-WITHOUT-v>"
} > .env

sudo mkdir -p /data/audit-logs
sudo chown 1001:1001 /data/audit-logs              # dashboard container runs as UID 1001 (nextjs)
```

- `FUNCTION_ENV_KEY` is **required** by `docker-compose.yml` but missing from `.env.example` — include it
  or the stack won't start.
- `AUDIT_HOST_PATH` is on the big disk so audit logs don't fill `/`; chown it to `1001:1001`.
- `_PUBLIC_URL`s use `https://` (what the public hits the front with) even though the backend serves HTTP.
- `GHCR_OWNER` lowercase. `DASHBOARD_IMAGE_TAG` is the version **without** the leading `v` (e.g. `2.0.0`).

### 2.6 Bring up the stack

Do **not** use `scripts/deploy.sh` for the first deploy (its `git pull --ff-only` fails in detached HEAD
and conflicts with the local Caddyfile edit). Bring it up directly:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull dashboard
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --wait
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
```

First boot runs `postgres/init/*.sql` and builds the **complete** schema — no migration step on a fresh
install. All containers healthy in ~30s (PostgREST and Caddy show plain `Up` — they define no
healthcheck, which is fine). The prod compose runs **2 dashboard replicas** for HA; the cron scheduler
and audit sweeper are leader-elected via a Postgres advisory lock, so exactly one replica runs them with
automatic failover. Scale with `--scale dashboard=N`, or set `deploy.replicas: 1` for a single instance.

Smoke-test the internal routing from the backend itself:

```bash
curl -s -i -H 'Host: api.<PLATFORM>.<DOMAIN>' http://localhost/rest/v1/todos
```

Expect `200 OK` and two seeded todos. (The REST API is under `/rest/v1/*`.)

### 2.7 Create the admin user

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm dashboard npm run create-admin
```

Prompts for email + password (≥ 12 chars); only the Argon2id hash is stored. The backend is now complete:
it listens on `:80` for the front and is not publicly exposed.

---

## Part 3 — Expose it: pick a front

Do exactly **one** of the following.

### Option A — Dedicated front (default)

A per-backend front box that also hosts this project's apps. Install **native Caddy** on it:

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy
```

> If this front box also runs Dockerised apps, install Docker + relocate its data-root too (2.2).

Write `/etc/caddy/Caddyfile` (TLS front → backend, Host header preserved):

```bash
{
echo '{'
echo '	email you@<DOMAIN>'
echo '}'
echo ''
echo 'api.<PLATFORM>.<DOMAIN> {'
echo '	reverse_proxy <BACKEND_IP>:80 {'
echo '		header_up Host {host}'
echo '		header_up X-Real-IP {remote_host}'
echo '	}'
echo '}'
echo ''
echo 'dashboard.<PLATFORM>.<DOMAIN> {'
echo '	reverse_proxy <BACKEND_IP>:80 {'
echo '		header_up Host {host}'
echo '		header_up X-Real-IP {remote_host}'
echo '	}'
echo '}'
} | sudo tee /etc/caddy/Caddyfile

sudo caddy validate --config /etc/caddy/Caddyfile
```

### Option B — Shared front (existing central Caddy box)

A central Caddy already fronts several backends and has an `/etc/caddy/sites/` directory. This is
OneCode's internal pattern, where a DMZ box (**APPS01**) handles all public TLS and each LAN backend
serves plain HTTP only, bridged by a firewall rule:

```
Internet → <FRONT_PUB_IP> (APPS01 + Caddy, TLS termination + Let's Encrypt)
            ↓ HTTP, internal LAN
        <BACKEND_IP>:80 (this backend's bundled Caddy, routes by Host header)
            ↓
        postgrest:3000 / dashboard:3000 / minio:9000 (Docker)
```

- **Shared front (e.g. APPS01, in DMZ)** — public Caddy with Let's Encrypt. One `.caddy` site file per
  backend's set of subdomains.
- **Backend** (this stack, LAN) — Docker stack with internal Caddy serving plain HTTP. No public
  exposure.
- **Firewall** — must allow the front → backend on TCP 80. Open one rule per new backend.

The backend is set up exactly as in Part 2 — the HTTP-only `caddy/Caddyfile` from 2.4 is what makes it
front-agnostic. Tell git to ignore your local Caddyfile edit so later upgrades don't conflict
(`git update-index --skip-worktree caddy/Caddyfile`) — see
[`OPERATIONS.md`](./OPERATIONS.md#the-caddyfile-skip-worktree-workflow).

Add one site file for this backend (do **not** reconfigure anything else on that box):

```bash
sudo bash -c '{
echo "api.<PLATFORM>.<DOMAIN> {"
echo "    import logging"
echo "    reverse_proxy <BACKEND_IP>:80 {"
echo "        header_up Host {host}"
echo "        header_up X-Real-IP {remote_host}"
echo "    }"
echo "}"
echo ""
echo "dashboard.<PLATFORM>.<DOMAIN> {"
echo "    import logging"
echo "    reverse_proxy <BACKEND_IP>:80 {"
echo "        header_up Host {host}"
echo "        header_up X-Real-IP {remote_host}"
echo "    }"
echo "}"
} > /etc/caddy/sites/<PLATFORM>.caddy'

sudo caddy validate --config /etc/caddy/Caddyfile
```

> `import logging` must match the snippet the shared box already defines; drop those lines if it doesn't.

> **Adding a backend to a shared front (per-backend checklist):** open a firewall rule
> (front → new backend on TCP 80), create the two DNS A records pointing at `<FRONT_PUB_IP>`, deploy the
> backend (Part 2) on the new box, add its `<PLATFORM>.caddy` site file here, then verify end-to-end
> (Part 4).

### Both options — verify reachability, then start Caddy

`header_up Host {host}` is the critical line — without it both subdomains look identical to the backend's
Caddy and routing fails.

Confirm the front can reach the backend (different subnets often need a firewall rule):

```bash
curl -s -i -H 'Host: api.<PLATFORM>.<DOMAIN>' http://<BACKEND_IP>/rest/v1/todos
```

Expect `200` + todos. If it hangs/refuses, open `front → backend TCP 80`.

**Only start Caddy once Part 1's networking is live** (DNS → `<FRONT_PUB_IP>`, 80/443 forward to the
front) — otherwise Let's Encrypt fails repeatedly and burns the rate limit (5 failures/hostname/hour).

```bash
getent hosts api.<PLATFORM>.<DOMAIN>               # → <FRONT_PUB_IP>
getent hosts dashboard.<PLATFORM>.<DOMAIN>         # → <FRONT_PUB_IP>

sudo systemctl restart caddy                       # restart, NOT reload — a front with admin off rejects reload
sudo journalctl -u caddy -f --since "30 seconds ago"
```

Watch for **two** `certificate obtained successfully` lines. `Ctrl+C` to stop.

---

## Part 4 — End-to-end test (from outside the network)

```bash
curl -I https://api.<PLATFORM>.<DOMAIN>/rest/v1/todos      # → 200
curl -I https://dashboard.<PLATFORM>.<DOMAIN>              # → 307 (redirect to /login)
```

Open `https://dashboard.<PLATFORM>.<DOMAIN>` and sign in with the admin from 2.7. Done.

---

## Adding an app's own hostname

Most apps need nothing here — they just call `https://api.<PLATFORM>.<DOMAIN>` and work from wherever
they run. You only touch this when an app needs its **own** public URL (e.g. `<APP_HOST>`), and only on a
**dedicated** front (the box with the public IP and Caddy).

1. Point DNS for `<APP_HOST>` at `<FRONT_PUB_IP>`.
2. Append a site block on the front, proxying to the locally-running app, and reload:

```bash
{
echo ''
echo '<APP_HOST> {'
echo '	reverse_proxy localhost:<APP_PORT>'
echo '}'
} | sudo tee -a /etc/caddy/Caddyfile

sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl restart caddy
```

Caddy gets a Let's Encrypt cert for `<APP_HOST>` automatically. The app reaches Onebase via the shared
endpoint `https://api.<PLATFORM>.<DOMAIN>`; create any new bucket / schema / keys it needs from the
Onebase dashboard. **The backend is untouched — one Onebase, many apps.**

---

## Day-2 operations

Updating, database backups & restore, Postgres major-version upgrades, rollback, HA, and the full
troubleshooting reference all live in [`OPERATIONS.md`](./OPERATIONS.md). They're topology-agnostic — the
backend is byte-for-byte the same under either front, so the same ops apply.

> **Picking a `<VERSION>` to install — historical image name:** `v2.0.0` publishes
> `ghcr.io/onecodeaps/onecodebase-dashboard`; releases after the "name change" commit publish
> `onebase-dashboard`. The compose file for the tag you check out already references the right name, so
> this only matters if you're pinning an old tag by hand.
