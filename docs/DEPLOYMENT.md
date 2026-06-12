# Deployment Guide

Step-by-step instructions for installing Onebase on a Linux server and keeping it up to date.

## Contents

- [First-time install](#first-time-install)
- [Updating to a new version](#updating-to-a-new-version)
- [Backing up the database](#backing-up-the-database)
- [Upgrading PostgreSQL (major version)](#upgrading-postgresql-major-version)
- [Rolling back to a previous version](#rolling-back-to-a-previous-version)
- [Troubleshooting](#troubleshooting)

---

## First-time install

### Before you begin

You'll need:

- A Linux server (Debian or Ubuntu shown below; any distro with Docker works) with a **public IP**.
- Ports **80** and **443** open to the internet on that server.
- A domain you control, with the ability to create A records.
- At least **1 GB RAM** (2 GB recommended).
- The first published image — i.e. you (or someone) has run the **Build & Release** workflow at least once on GitHub so an image exists at `ghcr.io/onecodeaps/onebase-dashboard`.

The example below uses `example.com` and IP `203.0.113.10`. Replace these with your real values everywhere they appear.

---

### Step 1 — Point DNS at the server

In your DNS provider, create two A records pointing at the server's public IP. Do this **first** because DNS propagation can take anywhere from a minute to an hour, and Caddy needs working DNS in step 9 to obtain TLS certs.

| Record | Type | Value |
| --- | --- | --- |
| `api.example.com` | A | `203.0.113.10` |
| `dashboard.example.com` | A | `203.0.113.10` |

Storage no longer needs its own subdomain — MinIO is internal, served via Caddy on `api.example.com/storage/v1`.

Verify resolution before continuing:

```bash
dig +short api.example.com
dig +short dashboard.example.com
```

Each should return `203.0.113.10`. If they don't, wait and re-check.

---

### Step 2 — SSH into the server as root

```bash
ssh root@203.0.113.10
```

All subsequent commands in steps 3 and 4 run as root.

---

### Step 3 — Install Docker

```bash
curl -fsSL https://get.docker.com | sh
```

Verify:

```bash
docker --version
docker compose version
```

Both should print version strings.

---

### Step 4 — Create a non-root deploy user

Running services as root is bad practice. Create a dedicated `deploy` user with Docker permissions.

```bash
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
```

---

### Step 5 — Clone the repository into `/opt/onebase`

```bash
mkdir -p /opt/onebase
chown deploy:deploy /opt/onebase
sudo -u deploy git clone https://github.com/OneCodeApS/Onebase.git /opt/onebase
```

---

### Step 6 — Switch to the deploy user

All remaining commands run as `deploy` from `/opt/onebase`.

```bash
sudo -iu deploy
cd /opt/onebase
```

---

### Step 7 — Pin to a released version

Check the [Releases page](https://github.com/OneCodeApS/Onebase/releases) for the latest version number, then:

```bash
git fetch --tags
git checkout v0.1.0
```

Replace `v0.1.0` with the actual version you want.

---

### Step 8 — Configure `.env`

```bash
cp .env.example .env
```

Generate strong secrets:

```bash
# Use this for SESSION_SECRET and PGRST_JWT_SECRET.
openssl rand -hex 32

# Use this for each *_PASSWORD value. Run once per password.
openssl rand -base64 24
```

Open `.env` in an editor:

```bash
nano .env
```

Fill in every blank. The required fields:

```
# Postgres
POSTGRES_PASSWORD=<openssl rand -base64 24>
AUTHENTICATOR_PASSWORD=<openssl rand -base64 24>
DASHBOARD_ADMIN_PASSWORD=<openssl rand -base64 24>

# PostgREST
PGRST_JWT_SECRET=<openssl rand -hex 32>

# MinIO
MINIO_ROOT_USER=onecodebase
MINIO_ROOT_PASSWORD=<openssl rand -base64 24>

# Dashboard
SESSION_SECRET=<openssl rand -hex 32>

# Hostnames
API_HOST=api.example.com
DASHBOARD_HOST=dashboard.example.com
API_PUBLIC_URL=https://api.example.com
DASHBOARD_PUBLIC_URL=https://dashboard.example.com

# Caddy / TLS — use your real email here
CADDY_TLS=you@example.com

# GHCR — must be lowercase
GHCR_OWNER=onecodeaps
DASHBOARD_IMAGE_TAG=0.1.0
```

> **Important:** `GHCR_OWNER` must be **lowercase**. Container registries reject mixed-case paths. Setting `DASHBOARD_IMAGE_TAG` to the version you checked out in step 7 keeps `.env` and the running image consistent.

Save and exit (`Ctrl+O`, `Enter`, `Ctrl+X` in nano).

The image at `ghcr.io/onecodeaps/onebase-dashboard` is **public**, so no `docker login` is needed.

---

### Step 9 — Run the first deploy

```bash
./scripts/deploy.sh 0.1.0
```

This:

- Pulls the dashboard image from GHCR.
- Starts all five containers: Postgres, PostgREST, MinIO, Caddy, dashboard.
- Postgres runs its init scripts (extensions, roles, audit log, sample table) on this first boot.
- Caddy requests Let's Encrypt certs for each subdomain.
- The script blocks until the dashboard reports healthy.

First boot takes 30–60 seconds.

When the script returns, your stack is running.

---

### Step 10 — Create your admin user

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  run --rm dashboard npm run create-admin
```

You'll be prompted for:

- Email
- Password (≥ 12 characters)
- Confirm password

The password is hashed with Argon2id in memory — only the hash is stored. Plaintext never touches disk.

---

### Step 11 — Sign in and verify

Open `https://dashboard.example.com` in your browser. Sign in with the credentials from step 10. You should land on a page reading "Signed in as `<email>`".

Run these sanity checks on the server:

```bash
# All five containers should show status "running" and the dashboard "healthy".
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps

# Sample API returns the seeded rows.
curl https://api.example.com/todos
```

Install complete.

---

## Updating to a new version

Postgres, MinIO, and Caddy keep running during an update — only the dashboard container is replaced. Your data is untouched.

### Before you begin

- A successful first install (see above).
- You're upgrading between released versions (e.g. `0.1.0` → `0.2.0`).
- Don't skip multiple major versions without reading the CHANGELOG for each.

---

### Step 1 — Find the new version

Open the [Releases page](https://github.com/OneCodeApS/Onebase/releases) and note the version you want, e.g. `0.2.0`.

---

### Step 2 — Read the release notes

On the same release page (or `CHANGELOG.md` in the repo), look for anything labeled **BREAKING** under that version. Follow any migration steps before continuing.

---

### Step 3 — SSH to the server

```bash
ssh deploy@203.0.113.10
cd /opt/onebase
```

---

### Step 4 — Run the deploy script with the new version

```bash
./scripts/deploy.sh 0.2.0
```

The script:

1. Pulls the latest config files: `git pull --ff-only`.
2. Rewrites `DASHBOARD_IMAGE_TAG=0.2.0` in `.env`.
3. Pulls the `:0.2.0` image from GHCR.
4. Recreates **only** the dashboard container (`--no-deps`) and waits until it's healthy (`--wait`).
5. Prunes dangling images.

If the new image fails to become healthy, the script exits non-zero and the previous container keeps serving traffic.

---

### Step 5 — Verify

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
```

The dashboard line should read `Up X seconds (healthy)`.

Open the dashboard in your browser and sign in. Your existing admin credentials still work; the data volume is preserved.

---

## Backing up the database

Take a full backup before any risky operation — especially a Postgres major upgrade. `scripts/pg-backup.sh` dumps the **entire cluster** (every database plus all roles and their passwords) to a gzipped file:

```bash
cd /opt/onebase
./scripts/pg-backup.sh
# → ./backups/onecodebase-pg18-20260527-141230.sql.gz
```

- Dumps land in `./backups/` (git-ignored). Pass a directory to write elsewhere: `./scripts/pg-backup.sh /mnt/backups`.
- The filename records the Postgres major (`pg18`) so it's obvious what a dump can restore into.
- The `postgres` service must be running. Copy the dump off the server (laptop, S3, …) for anything you can't afford to lose.

**Restoring** a dump into a running cluster:

```bash
gunzip -c backups/onecodebase-pg18-*.sql.gz \
  | docker compose -f docker-compose.yml exec -T postgres psql -U postgres -d postgres
```

> Restoring into a cluster that already has the schema will produce "already exists" errors. Restore into a **fresh** cluster (the upgrade script below does exactly that), or restore a single table with a targeted `pg_dump` instead.

---

## Upgrading PostgreSQL (major version)

Postgres major upgrades (e.g. **18 → 19**) are deliberately a separate, manual step — they never happen during a normal `deploy.sh` run:

- `deploy.sh` only recreates the **dashboard** container (`up -d --no-deps dashboard`); it never touches Postgres.
- The official `postgres` image **refuses to start** on a data directory created by a different major (it logs `database files are incompatible with server` and exits). This protects your data — nothing is corrupted, the service just won't come up until you migrate.

**Minor / patch upgrades** (e.g. `18.1 → 18.4`, same major) need none of this — the on-disk format is compatible. Just bump the tag and recreate the one service:

```bash
# edit docker-compose.yml → image: postgres:18.4-alpine
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d postgres
```

**Major upgrades** use `scripts/pg-major-upgrade.sh`, which does a safe dump & restore with the stock image (no extra tooling). It backs up first, recreates the data volume on the new major, and restores into it.

### Step 1 — Read the release notes

Skim the [PostgreSQL release notes](https://www.postgresql.org/docs/release/) for the target major. Don't jump several majors at once without checking each.

### Step 2 — Bump the image tag

Edit `docker-compose.yml`:

```yaml
  postgres:
    image: postgres:19-alpine    # was postgres:18-alpine
```

> Leave the `PGDATA: /var/lib/postgresql/data` line in place — it pins the data directory to the mount path across majors, which is what keeps the upgrade tooling version-independent. (Postgres 18+ otherwise defaults `PGDATA` to a version-specific path.)

### Step 3 — Run the upgrade script

```bash
cd /opt/onebase
./scripts/pg-major-upgrade.sh
```

It will:

1. Take a full backup (`pg-backup.sh`) into `./backups/`.
2. Show the current vs target major and **wait for you to type `yes`** before anything destructive.
3. Stop the stack, drop the old data volume, initialise a fresh cluster on the new major, and restore the backup into it (in a throwaway container, so the bundled `postgres/init/*` scripts don't double-seed). A few "already exists" notices for the bootstrap superuser are expected.
4. Bring the whole stack back up with `--wait`.

The stack is **down for the duration** (typically seconds to a few minutes depending on data size).

### Step 4 — Verify

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec postgres psql -U postgres -c 'SELECT version();'
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
```

The version should report the new major and all services should be `Up` / `(healthy)`.

> **If something goes wrong:** revert the tag in `docker-compose.yml` to the old major and restore the backup the script left in `./backups/` (see [Backing up the database](#backing-up-the-database)). The old image reads the old-major dump cleanly.

---

## Rolling back to a previous version

Every released version is an immutable image tag. To revert:

```bash
ssh deploy@203.0.113.10
cd /opt/onebase
./scripts/deploy.sh 0.1.0
```

The dashboard container is replaced with the older image. The database, MinIO storage, and Caddy certs are untouched.

> If the version you're rolling back from changed the database schema, rolling back the container alone may leave the running dashboard incompatible with the schema. Check the CHANGELOG for "BREAKING" notes — if a release introduced an irreversible schema change, you'll need to restore from a database backup as well.

---

## Troubleshooting

### `docker pull` fails: "unauthorized"

The image is supposed to be public. Check on github.com → your profile → Packages → `onebase-dashboard` → Package settings → Visibility = Public.

If it's still private, either flip it public or `docker login ghcr.io` on the server with a PAT that has `read:packages` scope.

### Caddy says "tls: no certificates available" or browser shows "not secure"

Caddy is still trying to acquire a Let's Encrypt cert and the ACME challenge is failing. Common causes:

- DNS isn't resolving yet. Wait, then `docker compose logs caddy` to confirm.
- Port 80 isn't reachable from the public internet (firewall, cloud security group). The HTTP-01 challenge requires inbound port 80.
- A typo in `API_HOST` / `DASHBOARD_HOST` in `.env`. Check the values match your DNS records exactly.

### "GHCR_OWNER must be set" or "repository name must be lowercase"

Open `.env`. `GHCR_OWNER` must be present and entirely lowercase. For OneCodeApS, the correct value is `onecodeaps`.

### `./scripts/deploy.sh: Permission denied`

The executable bit didn't survive the clone (common on Windows-authored repos). Either:

```bash
chmod +x scripts/deploy.sh
```

Or just invoke it via bash:

```bash
bash scripts/deploy.sh 0.1.0
```

### Dashboard container won't become healthy

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs dashboard --tail 100
```

Common causes:

- `SESSION_SECRET` is missing or shorter than 32 chars → fails at module load.
- `DATABASE_URL` resolution fails → check `DASHBOARD_ADMIN_PASSWORD` in `.env` matches what Postgres was initialized with (which is set on first boot and not changeable without re-initializing the data volume).
- Postgres isn't healthy yet → check `docker compose ps`.

### "No `## [0.1.0]` section in CHANGELOG.md" when releasing

This is a release-time error, not a deploy-time one. Edit `CHANGELOG.md`, add the `## [0.1.0]` section with at least one bullet, commit, push, then re-run the workflow.

### I forgot the admin password

You can create a new admin (the old one stays unless you delete it from the DB):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  run --rm dashboard npm run create-admin
```

If you want to remove the old admin:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec postgres \
  psql -U postgres -c "DELETE FROM _dashboard.admins WHERE email = 'old@example.com';"
```
