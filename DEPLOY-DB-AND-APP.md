# Deploying Onebase — two-server production (DB server + App server)

This is the production pattern: **two isolated servers**, each with exactly one job.

- **DB SERVER** — runs **only** the Onebase backend (the whole Docker stack: Postgres, PgBouncer,
  PostgREST, MinIO, dashboard, internal Caddy). **All data lives here** (the Postgres database and the
  MinIO buckets). It serves plain HTTP on port 80 and is **never exposed to the internet** — only the
  App server may reach it.
- **APP SERVER** — runs the public-facing front: a native Caddy that terminates public TLS
  (Let's Encrypt) and reverse-proxies the Onebase hostnames to the DB server. It is the **single public
  entry point** and the DB server's only ingress ("the DB server is closed behind the App server for
  protection"). Project apps are commonly hosted here too (dropped in by CI/CD), but they're just
  **clients of the Onebase endpoint** — see the note under Placeholders.

> **The two servers are isolated. Do not run the Onebase stack on the App server, and do not host the
> application on the DB server.** One job each.

```
                 Internet
                    │  (DNS → App server's public IP)
                    ▼
        ┌─────────────────────────────┐
        │  APP SERVER                 │   public TLS (Caddy + Let's Encrypt)
        │  <APP_LAN_IP> / <APP_PUB_IP>│   + hosted apps (clients of Onebase)
        └─────────────┬───────────────┘
                      │  HTTP, LAN only, Host header preserved
                      ▼
        ┌─────────────────────────────┐
        │  DB SERVER                  │   full Onebase stack in Docker
        │  <DB_LAN_IP>  (no public IP)│   internal Caddy :80 routes by Host
        │                             │   ALL DATA: Postgres + MinIO volumes
        └─────────────────────────────┘
```

## Placeholders used in this guide

Replace these everywhere they appear:

| Placeholder | Meaning | Example |
| --- | --- | --- |
| `<PLATFORM>` | the shared Onebase's hostname slug | `msp` |
| `<DOMAIN>` | your base domain | `madebyonecode.dk` |
| `<DB_LAN_IP>` | DB server's private LAN IP | `10.1.116.83` |
| `<APP_LAN_IP>` | App server's private LAN IP | `10.1.116.98` |
| `<APP_PUB_IP>` | public IP that reaches the App server | `203.0.113.10` |
| `<DEPLOY_USER>` | non-root deploy user (in `docker` group) | `onecode` |
| `<VERSION>` | release tag to deploy | `v2.0.0` |
| `<APP_HOST>` | a hosted app's own public hostname (optional) | `app1.madebyonecode.dk` |
| `<APP_PORT>` | local port a hosted app listens on (optional) | `8080` |

Public hostnames (two of them):
`api.<PLATFORM>.<DOMAIN>` and `dashboard.<PLATFORM>.<DOMAIN>`.

> **Apps are clients of the Onebase endpoint.** Anything you build talks to Onebase through the stable
> public URL `https://api.<PLATFORM>.<DOMAIN>` (plus its keys) — it behaves identically no matter where
> it runs, so deploying an app (e.g. via CI/CD onto the App server) does **not** change the Onebase
> setup below. One shared Onebase on the DB server serves all of them. The only time an app touches this
> guide is if it needs its **own** public hostname (e.g. `app1.<DOMAIN>`): add a Caddy site block for it
> on the App server (it's the box with the public IP) — see "Adding an app's own hostname" at the end.

---

## 0. Networking prerequisites (get these right first)

The single most common failure is the public traffic not actually reaching the App server. Lock these
down **before** touching Let's Encrypt:

1. **DNS** — two A records, both → the App server's public IP:
   - `api.<PLATFORM>.<DOMAIN>` → `<APP_PUB_IP>`
   - `dashboard.<PLATFORM>.<DOMAIN>` → `<APP_PUB_IP>`
2. **Inbound 80 + 443** from the internet must forward to the **App server** (`<APP_LAN_IP>`). If the
   App server is behind NAT, that's a port-forward on the gateway/firewall.
   > ⚠️ **Each public-facing server needs its OWN public IP for ports 80/443.** A given public port can
   > only forward to one host. If two DMZ servers are NAT'd behind the same public IP, inbound 80/443
   > land on whichever one the gateway points at — and Let's Encrypt validation fails on the other with
   > `remote error: tls: internal error`. Confirm with your network team that this project's public IP
   > forwards 80/443 to **this** App server.
3. **App server → DB server on TCP 80** must be allowed (they are typically in different subnets).
4. **DB server must NOT be reachable from the internet.** Ideally the firewall only allows the App
   server to reach it.

---

## 1. Check storage on BOTH servers FIRST

Docker stores **all** images, containers, and volumes under its data-root (default `/var/lib/docker`).
On these servers the database and MinIO buckets grow without bound, so the data-root **must** sit on the
largest disk — never on a small `/` or `/var`.

```bash
df -h
```

Read the output and decide where Docker data goes **before installing anything**:

```
Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1       5.2G  1.3G  3.6G  27% /          ← OS + repo source only
/dev/sda5       2.1G  1.8G  168M  92% /var       ← TOO SMALL — Docker must NOT live here
/dev/sdb1       196G  2.1M  186G   1% /data      ← the big disk → Docker data-root goes here
```

Rules:
- The **DB server** needs a large data disk (Postgres + MinIO). Point Docker's data-root at it (step 2).
- If `/var` is a small dedicated partition, free a little headroom so the Docker package install fits:
  `sudo apt-get clean` and, if needed, `sudo journalctl --vacuum-size=100M`.
- The **App server** is stateless (just Caddy + your app), but still relocate its data-root to its data
  disk for consistency and to keep `/` lean.

---

## 2. DB SERVER — install Docker and relocate data-root

All commands run as `<DEPLOY_USER>` unless prefixed with `sudo`.

```bash
# Install Docker + Compose v2
sudo apt-get clean
curl -fsSL https://get.docker.com | sh        # if curl is missing: sudo apt-get install -y curl

# Let the deploy user talk to Docker
sudo usermod -aG docker <DEPLOY_USER>
newgrp docker
docker ps                                      # must succeed, no "permission denied"

# Relocate the data-root to the big disk BEFORE pulling any image
sudo mkdir -p /data/docker
sudo systemctl stop docker
{
echo '{'
echo '  "data-root": "/data/docker"'
echo '}'
} | sudo tee /etc/docker/daemon.json
sudo systemctl start docker
docker info | grep "Docker Root Dir"           # MUST print: /data/docker
```

Do not proceed until `Docker Root Dir: /data/docker`.

---

## 3. DB SERVER — clone the repo and pin a release

```bash
sudo apt-get install -y git                    # if missing
sudo mkdir -p /opt/onebase
sudo chown <DEPLOY_USER>:<DEPLOY_USER> /opt/onebase
git clone https://github.com/OneCodeApS/Onebase.git /opt/onebase
cd /opt/onebase
git fetch --tags
git tag                                         # list releases
git checkout <VERSION>                          # detached HEAD is expected
```

> The repo is **`OneCodeApS/Onebase`** (not "Onecodebase"). The local directory name is arbitrary.

---

## 4. DB SERVER — HTTP-only internal Caddyfile

The DB server's Caddy only does internal Host-header routing on port 80 — the App server terminates
public TLS, so this Caddy must serve **plain HTTP** and never request its own certificate.

> Keep every `{ }` block multi-line. Collapsing a route onto one line makes Caddy exit 1 and loop on
> "Restarting". On Windows SSH clients, use `echo` loops (heredocs auto-indent and hang); single-quote
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

Expect `Valid configuration`. The warnings "input is not formatted" and "listening only on the HTTP
port, so no automatic HTTPS" are expected and correct.

---

## 5. DB SERVER — generate `.env`

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
echo "MINIO_ROOT_USER=onecodebase"
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
sudo chown 1001:1001 /data/audit-logs          # dashboard container runs as UID 1001 (nextjs)
```

Notes:
- `FUNCTION_ENV_KEY` is **required** by `docker-compose.yml` but is missing from `.env.example` and the
  older deploy docs — include it or the stack won't start.
- `AUDIT_HOST_PATH` points at the big disk so audit logs don't fill `/`. Chown it to `1001:1001`.
- `_PUBLIC_URL`s use `https://` (what the public hits the App server with) even though the DB server
  serves HTTP internally.
- `GHCR_OWNER` must be lowercase. `DASHBOARD_IMAGE_TAG` is the version **without** the leading `v`
  (e.g. `2.0.0`).

---

## 6. DB SERVER — bring up the full stack

Do **not** use `scripts/deploy.sh` for the first deploy (it runs `git pull --ff-only`, which fails in
detached HEAD and conflicts with the local Caddyfile edit). Bring it up directly:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull dashboard
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --wait
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
```

On first boot the `postgres/init/*.sql` scripts build the **complete** schema — no migration step on a
fresh install. All containers should be healthy in ~30s (PostgREST and Caddy show plain `Up` because
they define no healthcheck — that's fine).

Smoke-test the internal routing from the DB server itself:

```bash
curl -s -i -H 'Host: api.<PLATFORM>.<DOMAIN>' http://localhost/rest/v1/todos
```

Expect `200 OK` and two seeded todos. (The REST API is under `/rest/v1/*`.)

Create the admin user:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm dashboard npm run create-admin
```

Prompts for email + password (≥ 12 chars); only the Argon2id hash is stored.

The DB server is now complete. It listens on `:80` for the App server and is not publicly exposed.

---

## 7. APP SERVER — install Docker (for the hosted app) and native Caddy (the front)

Repeat the Docker + data-root steps from section 2 on the App server (its app may need Docker; the
data-root still belongs on its data disk). Then install **native Caddy** for the public front:

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy
```

---

## 8. APP SERVER — Caddyfile (public TLS front → DB server)

This Caddy terminates public TLS via Let's Encrypt and forwards both hostnames to the DB server on
port 80, **preserving the Host header** so the DB server's Caddy can route `api.*` vs `dashboard.*`.

```bash
{
echo '{'
echo '	email you@<DOMAIN>'
echo '}'
echo ''
echo 'api.<PLATFORM>.<DOMAIN> {'
echo '	reverse_proxy <DB_LAN_IP>:80 {'
echo '		header_up Host {host}'
echo '		header_up X-Real-IP {remote_host}'
echo '	}'
echo '}'
echo ''
echo 'dashboard.<PLATFORM>.<DOMAIN> {'
echo '	reverse_proxy <DB_LAN_IP>:80 {'
echo '		header_up Host {host}'
echo '		header_up X-Real-IP {remote_host}'
echo '	}'
echo '}'
} | sudo tee /etc/caddy/Caddyfile

sudo caddy validate --config /etc/caddy/Caddyfile
```

`header_up Host {host}` is the critical line — without it both subdomains look identical to the DB
server's Caddy and routing fails.

**Confirm the App server can reach the DB server before starting** (different subnets often need a
firewall rule):

```bash
curl -s -i -H 'Host: api.<PLATFORM>.<DOMAIN>' http://<DB_LAN_IP>/rest/v1/todos
```

Expect `200` + todos. If it hangs/refuses, open `App server → DB server TCP 80`.

---

## 9. APP SERVER — start Caddy and get certificates

**Only start Caddy once section 0's networking is actually live** (DNS resolves to `<APP_PUB_IP>`, and
80/443 forward to this server). Otherwise Let's Encrypt fails repeatedly and burns the rate limit
(5 failed validations per hostname per hour).

```bash
# Verify DNS first
getent hosts api.<PLATFORM>.<DOMAIN>            # → <APP_PUB_IP>
getent hosts dashboard.<PLATFORM>.<DOMAIN>      # → <APP_PUB_IP>

sudo systemctl restart caddy
sudo journalctl -u caddy -f --since "30 seconds ago"
```

Watch for **two** `certificate obtained successfully` lines. `Ctrl+C` to stop following.

---

## 10. End-to-end test (from a machine outside the network)

```bash
curl -I https://api.<PLATFORM>.<DOMAIN>/rest/v1/todos      # → 200
curl -I https://dashboard.<PLATFORM>.<DOMAIN>              # → 307 (redirect to /login)
```

Open `https://dashboard.<PLATFORM>.<DOMAIN>` and sign in with the admin from section 6. Done.

---

## Adding an app's own hostname

Most apps need nothing here — they just call `https://api.<PLATFORM>.<DOMAIN>` and work from wherever
they run. You only touch this when an app needs its **own** public URL (e.g. `app1.<DOMAIN>`), because
the App server is the box holding the public IP and Caddy.

1. Point DNS for `<APP_HOST>` (e.g. `app1.<DOMAIN>`) at `<APP_PUB_IP>`.
2. Append a site block on the **App server** proxying to the locally-running app (on `<APP_PORT>`), and reload:

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

Caddy obtains a Let's Encrypt cert for `<APP_HOST>` automatically. The app itself reaches Onebase via the
shared endpoint `https://api.<PLATFORM>.<DOMAIN>`; create any new bucket / schema / keys it needs from
the Onebase dashboard. **The DB server is untouched — one Onebase, many apps.**

---

## Updating later

Once you're past the first deploy, on the **DB server** switch to `master` and pin via the image tag so
`scripts/deploy.sh` works (it only recreates the dashboard container; Postgres/MinIO/Caddy keep running):

```bash
cd /opt/onebase
git checkout master
git update-index --skip-worktree caddy/Caddyfile     # keep your local HTTP-only Caddyfile
./scripts/deploy.sh <new-version>
```

The App server's Caddy is unaffected by Onebase upgrades.

---

## Troubleshooting

- **`tls: internal error` during Let's Encrypt, with the error citing a public IP** → the inbound 80/443
  for that IP are reaching the **wrong server** (not this App server). This is a NAT/port-forward
  problem (see section 0), not a Caddy problem. Prove it: stop Caddy on the App server and curl the
  public hostname on port 80 from outside — if something still answers, you're routed to another box.
- **Caddy validate fails on `import logging`** → that snippet must be defined in the main Caddyfile;
  remove the `import logging` lines if you're not using it.
- **`reload` fails on `localhost:2019`** → the front Caddy may run with `admin off`; use
  `sudo systemctl restart caddy` instead.
- **`PGRST000` / `could not look up local user`** → a password was generated with base64. Regenerate
  with `openssl rand -hex`, then `docker compose ... down -v` (the `-v` is required to wipe the
  postgres volume so init re-runs) and bring it back up.
- **`docker pull` unauthorized** → the GHCR image visibility must be Public, or `docker login ghcr.io`
  with a PAT that has `read:packages`.
- **Image name** → `v2.0.0` publishes `ghcr.io/onecodeaps/onecodebase-dashboard`; releases after the
  "name change" commit publish `onebase-dashboard`. The compose file for the tag you check out already
  references the right name.
