# Onecodebase

Self-hosted backend platform: Postgres + PostgREST + MinIO behind Caddy, with a custom Next.js admin dashboard.

Designed to be installed on your own Linux server. One command spins up the database, the REST API, S3-compatible storage, and an admin UI; another command creates your admin user. Everything runs in Docker.

> **Status:** v0.1.0 — auth + reverse proxy + sample API working end-to-end. No dashboard features yet (SQL editor, table browser, etc.) — those land in subsequent milestones. See [CHANGELOG.md](./CHANGELOG.md).

## What's here (Milestone 1)

- **Postgres 16** with three logical roles (`anon`, `service_role`, `dashboard_admin`) plus an `authenticator` for PostgREST.
- **PostgREST** exposes the `public` schema as a REST API.
- **MinIO** for S3-compatible object storage.
- **Caddy** terminates TLS and routes three subdomains.
- **Dashboard** — Next.js 15 / App Router / TypeScript. Login + an authenticated landing page. Admin user lives in `_dashboard.admins`, bootstrapped via a CLI script. Every login/logout writes to `_dashboard.admin_audit_log`.

Out of scope for now: edge functions, end-user auth, realtime, multi-admin RBAC, mobile-responsive polish.

## A note on secrets

This repository is **public**. Security comes from your `.env` secrets and Postgres role isolation, not from the source being hidden. `.env` is gitignored; `.env.example` ships placeholders only. GitHub secret scanning and push protection are enabled — pushes that contain recognizable secret patterns will be refused before they land. If you find a security issue, see [SECURITY.md](./SECURITY.md).

## Local dev

You'll need: Docker (Docker Desktop on Windows/Mac, or Docker Engine with Compose v2 on Linux), `openssl` for generating secrets, and a browser.

On Windows, the easiest setup is Docker Desktop plus Git for Windows (which ships an `openssl.exe` already on PATH). Make sure Docker Desktop is running — the whale icon in the system tray should say "Docker Desktop is running" — before any `docker compose` command.

All commands below show the Linux/macOS form first, then the Windows PowerShell equivalent where it differs.

### 1. Configure

```bash
cp .env.example .env                  # Linux / macOS
```

```powershell
Copy-Item .env.example .env           # Windows PowerShell
```

Open `.env` in an editor and fill in every blank. Generate values with:

```bash
openssl rand -hex 32       # SESSION_SECRET, PGRST_JWT_SECRET
openssl rand -hex 24       # each *_PASSWORD and MINIO_ROOT_PASSWORD
openssl rand -hex 8        # MINIO_ROOT_USER
```

Use hex (not base64) for passwords that end up in Postgres connection strings — `/` and `+` from base64 can break URL parsing of the connection string.

These commands work identically in PowerShell once Git for Windows is installed. Leave the `*_HOST`, `*_PUBLIC_URL`, and `CADDY_TLS=internal` lines at their defaults — they're already set up for `*.localhost`. Leave `GHCR_OWNER` blank; it's only used by the production overlay.

No separate `.env` is needed inside `dashboard/`. The dashboard container reads its config from the `environment:` block in `docker-compose.yml`, which pulls values from the root `.env`.

### 2. Bring the stack up

```bash
docker compose up -d --build
```

First boot runs the SQL init scripts (extensions, roles, audit table, sample `todos` table with RLS) and takes 30–60 seconds. Subsequent boots reuse the volume. Check progress with `docker compose ps` — all five services should report healthy.

> Don't pass `-f docker-compose.prod.yml` for local dev. That overlay is server-only: it expects `GHCR_OWNER` and pulls a prebuilt image instead of building locally.

### 3. Create the admin user

```bash
docker compose run --rm dashboard npm run create-admin
```

Prompts for email + password. The password is hashed with Argon2id in memory and only the hash is persisted.

### 4. Trust Caddy's local CA (one-time)

So your browser stops warning about the self-signed cert on `*.localhost`:

```bash
docker compose exec caddy caddy trust
```

If that doesn't work on your OS, copy out the root cert and import it manually:

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
# Linux / macOS: trust caddy-root.crt in your OS keychain
# Windows: double-click the .crt and install into "Trusted Root Certification Authorities",
#          or run `certmgr.msc` → Trusted Root → Import.
```

### 5. Use it

- **Dashboard:** <https://dashboard.localhost> → sign in with the credentials from step 3.
- **API:** <https://api.localhost/rest/v1/todos> → returns the seeded rows as JSON. Try `curl https://api.localhost/rest/v1/todos`. The API host also exposes `/rpc/v1/<fn>` (PostgREST RPC), `/auth/v1/*` (end-user auth), `/realtime` (SSE), and `/functions/v1/<name>` (edge functions).
- **Storage:** <https://api.localhost/storage/v1> → POST to `/storage/v1/object/sign/<bucket>/<key>` (or `/upload/<bucket>/<key>`) to get a short-lived SigV4-signed URL, then GET/PUT directly. Caddy strips the `/storage/v1/object` prefix and forwards to internal MinIO; the dashboard never touches the byte stream. MinIO is no longer exposed under its own hostname.

Direct DB access from the host (for psql, dbeaver, etc):

```bash
psql "postgres://postgres:$POSTGRES_PASSWORD@127.0.0.1:5432/postgres"           # Linux / macOS
```

```powershell
psql "postgres://postgres:$env:POSTGRES_PASSWORD@127.0.0.1:5432/postgres"       # Windows PowerShell
```

### Running the dashboard outside Docker (hot reload)

Editing dashboard code and rebuilding the container on every save is slow. For tighter feedback, run Postgres / MinIO / PostgREST / Caddy in Docker and run the Next.js dev server directly on your host.

**1. Make sure the Docker stack is up** (step 2 above). Postgres is exposed on `127.0.0.1:5432` and MinIO on `127.0.0.1:9000` — see the `ports:` blocks in `docker-compose.yml`. That loopback exposure is what makes this mode work.

**2. Create `dashboard/.env.local`.** Next.js doesn't read the root `.env`; it reads `dashboard/.env.local`. Mirror the secrets from the root `.env` but point hostnames at `127.0.0.1`:

```bash
# dashboard/.env.local — local dev only, do not commit (.env.* is gitignored)

# Note: URL-encode reserved chars in the password (e.g. `+` → `%2B`).
DATABASE_URL=postgres://dashboard_admin:<DASHBOARD_ADMIN_PASSWORD>@127.0.0.1:5432/postgres

SESSION_SECRET=<same as root .env>
PGRST_JWT_SECRET=<same as root .env>

MINIO_ENDPOINT=127.0.0.1
MINIO_PORT=9000
MINIO_USE_SSL=false
MINIO_ACCESS_KEY=<MINIO_ROOT_USER from root .env>
MINIO_SECRET_KEY=<MINIO_ROOT_PASSWORD from root .env>

# Where storage URLs are signed against — must match what clients hit.
API_PUBLIC_URL=https://api.localhost

DASHBOARD_PUBLIC_URL=http://localhost:3000
AUDIT_LOG_DIR=./audit-logs
```

`instrumentation.ts` boots the cron runner at startup, which opens a DB pool immediately — so the dev server will fail to start unless `DATABASE_URL` resolves and Postgres is reachable.

**3. Run the dev server:**

```bash
cd dashboard
npm install
npm run dev
```

Open <http://localhost:3000> and sign in with the admin user you created in step 3 of the main setup. Code changes hot-reload; database, storage, and the REST API still come from the Docker stack.

> The dashboard container in Docker doesn't publish port 3000 on the host, so there's no conflict with the dev server. You can leave the dockerized dashboard running — it's just unused while you develop against the dev server on port 3000.

### Stop, restart, reset

```bash
docker compose ps              # show service status
docker compose logs -f         # tail logs (Ctrl+C to stop tailing)
docker compose stop            # stop containers, keep data
docker compose start           # start them again
docker compose down            # stop and remove containers, keep volumes
docker compose down -v         # stop, remove containers AND wipe postgres + minio data
```

Use `down -v` to start over from a clean slate — you'll re-run the init scripts and need to recreate the admin user on next boot.

## Install on a Linux server

The dashboard image is pre-built by CI and published to GHCR. Your server only pulls it — no Node, no build tools needed on the server. Installs are bit-identical across machines because every server pulls the exact same image tag.

**Before you begin**

- A Linux server (Debian/Ubuntu shown; any distro with Docker works) with a public IP.
- Ports **80** and **443** open to the internet on that server.
- A domain you control, with the ability to create three subdomain A records.
- At least 1 GB RAM (2 GB recommended).

### Steps

**1. Point DNS at the server.** Do this first — DNS propagation can take minutes to hours, and Caddy needs working DNS to obtain TLS certs in step 8.

In your DNS provider, create two A records pointing at the server's public IP:

| Record | Value |
| --- | --- |
| `api.example.com` | `<server-ip>` |
| `dashboard.example.com` | `<server-ip>` |

Verify resolution before continuing: `dig +short api.example.com` should return your server's IP. (Storage no longer needs its own subdomain — MinIO is now internal, served via Caddy on `api.example.com/storage/v1`.)

**2. Install Docker on the server.**

```bash
ssh root@<server-ip>
curl -fsSL https://get.docker.com | sh
```

**3. Create a non-root deploy user with Docker access.**

```bash
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG docker deploy
```

**4. Clone the repo into `/opt/onecodebase`.**

```bash
sudo mkdir -p /opt/onecodebase
sudo chown deploy:deploy /opt/onecodebase
sudo -u deploy git clone https://github.com/OneCodeApS/Onecodebase.git /opt/onecodebase
```

**5. Switch to the deploy user.** All remaining commands run as `deploy` from this directory.

```bash
sudo -iu deploy
cd /opt/onecodebase
```

**6. Pin to a released version.** Check the [Releases page](https://github.com/OneCodeApS/Onecodebase/releases) for the latest version number, then:

```bash
git fetch --tags
git checkout v0.1.0
```

**7. Configure `.env`.**

```bash
cp .env.example .env
```

Generate strong secrets:

```bash
openssl rand -hex 32       # use this for SESSION_SECRET and PGRST_JWT_SECRET
openssl rand -hex 24       # use this for each *_PASSWORD value (run once per password)
```

(Hex, not base64 — `/` and `+` from base64 break the URL form of Postgres connection strings.)

Open `.env` in an editor (`nano .env`) and fill in every blank. Set these to your real values:

```
GHCR_OWNER=onecodeaps
DASHBOARD_IMAGE_TAG=0.1.0

API_HOST=api.example.com
DASHBOARD_HOST=dashboard.example.com
API_PUBLIC_URL=https://api.example.com
DASHBOARD_PUBLIC_URL=https://dashboard.example.com

CADDY_TLS=you@your-domain.com
```

The image at `ghcr.io/onecodeaps/onebase-dashboard` is **public**, so no `docker login` is needed.

**8. Run the first deploy.**

```bash
./scripts/deploy.sh 0.1.0
```

This pulls the dashboard image and starts all five containers (Postgres, PostgREST, MinIO, Caddy, dashboard). First boot takes 30–60 seconds — Postgres runs its init scripts, Caddy requests Let's Encrypt certs for each subdomain, the dashboard reports healthy.

When the script returns, your stack is running.

**9. Create your admin user.**

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  run --rm dashboard npm run create-admin
```

Prompts for email + password. The password is hashed with Argon2id and only the hash is stored — plaintext never touches disk.

**10. Sign in and verify.**

Open `https://dashboard.example.com` in your browser and sign in with the credentials from step 9. You should land on a page saying "Signed in as <email>".

Quick sanity checks:

```bash
# All five containers running; dashboard is healthy.
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps

# Sample API returns the seeded rows.
curl https://api.example.com/rest/v1/todos
```

Install complete.

## Update to a new version

Postgres, MinIO, and Caddy keep running during an update — only the dashboard container is replaced. Your data is untouched.

**Before you begin**

- A successful previous install (see above).
- You're going to upgrade from one released version to another (e.g., `0.1.0` → `0.2.0`). Don't skip major versions without reading the CHANGELOG.

### Steps

**1. Find the new version.** Open the [Releases page](https://github.com/OneCodeApS/Onecodebase/releases) and note the version you want (e.g., `0.2.0`).

**2. Read the release notes.** On the same release page (or `CHANGELOG.md`), look for anything marked **BREAKING** and follow any migration steps before continuing.

**3. SSH to the server.**

```bash
ssh deploy@<server-ip>
cd /opt/onecodebase
```

**4. Run the deploy script with the new version.**

```bash
./scripts/deploy.sh 0.2.0
```

The script:
- Pulls the latest config files via `git pull --ff-only` (in case `docker-compose.yml`, the Caddyfile, or init scripts changed).
- Rewrites `DASHBOARD_IMAGE_TAG=0.2.0` in `.env` so subsequent restarts use this exact version.
- Pulls the `:0.2.0` image from GHCR.
- Recreates only the dashboard container (`--no-deps`) and waits until it's healthy (`--wait`).
- Prunes dangling images.

If the new image fails to become healthy, the script exits non-zero and the previous container keeps running.

**5. Verify.**

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
```

Dashboard status should read `Up X seconds (healthy)`. Open the dashboard in your browser, sign in — your existing admin credentials still work; the data volume is preserved.

### Roll back

Every released version is an immutable image tag. To revert:

```bash
./scripts/deploy.sh 0.1.0
```

The dashboard container is replaced with the older image; the database is untouched.

### Things to know

- `postgres/init/*.sql` runs **once**, on first DB boot. Editing those files later does nothing. Post-install schema changes ship as migrations bundled with releases (documented per-version in `CHANGELOG.md`).
- Caddy fetches Let's Encrypt certs on first request to each subdomain. If the initial ACME challenge fails (DNS not yet resolving), Caddy retries automatically — give it a minute or two.
- If `scripts/deploy.sh` lands without the executable bit (common on Windows-cloned repos), either `chmod +x scripts/deploy.sh` once, or run it as `bash scripts/deploy.sh <version>`.
- Updates are the same procedure regardless of how many servers you run — repeat steps 3 and 4 on each.

## Maintainer notes

If you're working on Onecodebase itself (not just self-hosting it):

The workflow at `.github/workflows/build.yml` is **manual-only**. Pushing to `master` does not trigger anything — you decide when to build by clicking **Run workflow** in the Actions tab.

**Day-to-day**

1. Commit and push as usual (GitHub Desktop works fine). Nothing builds.
2. When you want a new image on GHCR, go to repo → **Actions** → **Build & Release** → **Run workflow**.
3. Pick a **Release type** from the dropdown:
   - **rebuild** — just rebuild the image. Publishes `:latest` + `:<short-sha>` to GHCR. No tag, no release.
   - **release** — also cut a release. The workflow reads the version from `dashboard/package.json`, validates the matching `CHANGELOG.md` entry exists, builds `:X.Y.Z` + `:X.Y`, creates the git tag, and publishes a GitHub Release page.

**Cutting a release**

1. Bump the version in `dashboard/package.json` (e.g., `1.3.5` → `1.3.6`). Move the `[Unreleased]` entries in `CHANGELOG.md` into a new `[<version>]` section matching it. Commit, push.
2. Actions → Build & Release → Run workflow → pick `release` → Run.

The workflow fails fast if `dashboard/package.json`'s version isn't a valid `x.y.z`, the matching git tag already exists, or the changelog entry for the version is missing — a forgotten bump or missing notes won't ship a half-baked release.

**Production deploy** — the production server lives behind a VPN, so CI never SSHes anywhere. After the release publishes, connect VPN, SSH to the server, and run `./scripts/deploy.sh 0.2.0` (the Actions run summary prints the exact command).

## Where things live

```
.
├── docker-compose.yml
├── .env.example
├── caddy/Caddyfile
├── postgres/
│   ├── init/                  # runs once, on first DB boot
│   │   ├── 01_extensions.sql
│   │   ├── 02_roles.sql
│   │   ├── 03_audit_log.sql   # _dashboard schema (private)
│   │   └── 04_sample_schema.sql
│   └── postgrest.conf         # reference; real config is env vars
└── dashboard/
    ├── app/                   # Next.js App Router
    ├── lib/                   # db, auth, audit, minio
    ├── scripts/create-admin.mjs
    └── Dockerfile
```

## Security notes

- The `dashboard_admin` Postgres role is **not** reachable through PostgREST. PostgREST connects as `authenticator`, which has no grant to `dashboard_admin`.
- Sessions are encrypted with `SESSION_SECRET` (iron-session). Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` in production.
- Next.js server actions enforce same-origin posts by default, which covers CSRF for form submissions. Future non-form mutations will use an explicit double-submit token (the `csrf` field is already stored on the session).
- `_dashboard` schema is `REVOKE ALL FROM PUBLIC`; only `dashboard_admin` has `USAGE`.
- `.env` is gitignored.

## Next milestone

After you've verified login + the sample API end-to-end, the next milestone adds dashboard features starting with the SQL editor. See [CHANGELOG.md](./CHANGELOG.md) for what's shipped.

## License

Copyright © 2026 Onecode.

Licensed under the [GNU Affero General Public License v3.0](./LICENSE). You may self-host this software on your own infrastructure. If you modify it and offer it as a network service to others, the AGPL requires you to make the modified source available to those users.

For commercial licensing terms different from the AGPL, contact thomas@onecode.dk.
