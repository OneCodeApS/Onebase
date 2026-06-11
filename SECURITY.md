# Security policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security bugs.

Email: **thomas@onecode.dk**

Include:
- A description of the vulnerability and its impact.
- Steps to reproduce, or a proof of concept.
- Your name / handle if you'd like to be credited.

I aim to acknowledge reports within 72 hours and to ship a fix or mitigation as quickly as the severity warrants.

## Scope

In scope:
- The dashboard (Next.js app under `dashboard/`)
- The Postgres init scripts and role grants (`postgres/`)
- The Caddy configuration (`caddy/`)
- The `docker-compose.yml` / `docker-compose.prod.yml` topology

Out of scope:
- Misconfigurations in your own `.env` (e.g., weak `SESSION_SECRET`) — those are deployment issues, not code bugs.
- Vulnerabilities in upstream dependencies (Postgres, PostgREST, MinIO, Caddy, Next.js, `pg`, `iron-session`, `@node-rs/argon2`). Please report those to the respective projects; I'll pick up the patch when it lands.

## The MCP server's threat model

The built-in MCP server (`/mcp/v1` on the API host) gives AI coding agents access to the instance. Its security posture, so reports can be judged against intent:

- **Credentials** are personal access tokens (`ob_pat_…`), stored as SHA-256 hashes in `_dashboard.access_tokens`. They expire, are individually revocable, and are owned by a dashboard user — verification re-reads the owner's current role and disabled state on every request, so disabling a user kills their tokens immediately.
- **Capabilities** are the intersection of: the token's scopes, the owner's current dashboard role, and the token's `read_only` flag (default on). SQL runs through the same Postgres role ladder as the SQL editor — read-only transaction, the restricted `dashboard_sql_rw` role, or the admin path for `db:ddl` tokens.
- **Hard exclusions regardless of scope:** raw MCP SQL cannot touch credentials, secrets, or the audit log (`_dashboard.access_tokens`, `_dashboard.function_env`, `_dashboard.audit_log`, `auth.users/identities/sessions/providers/settings/magic_link_tokens`), and the service-role key is never exposed through any MCP tool. The string-matching guard is defense-in-depth, not the boundary — the boundary is scopes + roles.
- **Destructive statements** (DROP/TRUNCATE/unfiltered DELETE/UPDATE, making a bucket public) require an HMAC confirm-token round-trip so the intent surfaces in the agent's conversation.
- **Every tool call is audited** into the hash-chained `_dashboard.audit_log` (action `mcp.*`, session `mcp:<token-id>`), and the server fails **closed**: if the audit write fails, the result is withheld.
- **Untrusted data wrapping:** rows, logs, and function output are returned inside randomized `<untrusted-data-…>` boundaries with instructions not to follow anything inside — prompt-injection via stored data is an accepted, mitigated risk, and bypasses of the wrapping are in scope for reports.
- **Rate limiting** per token (area `mcp`, Admin → Rate limits), enforced in Postgres across replicas.

In scope for reports: scope-check bypasses, the protected-object guard being side-stepped to reach credentials/secrets, confirm-token forgery, audit evasion, and 401/403 logic errors on the route.

## Secrets and this repository

This repository is public. **No real secrets should ever land here.** `.env` is gitignored; only `.env.example` (placeholders) is committed. GitHub secret scanning + push protection are enabled to refuse pushes that contain recognizable secret patterns.

If you spot a value in the tree that looks like it shouldn't be there, treat it as a security report.
