import { pool } from "../db";
import { getAnonKey } from "../auth-jwt";
import { verifyAuditChain } from "../audit-verify";
import { runAdvisors } from "./advisors";
import { DOC_TOPICS } from "./docs-content";
import { apiBaseUrl, generateSnippet, isSnippetSurface, SNIPPET_SURFACES } from "./snippets";
import { wrapUntrusted } from "./untrusted";
import type { ToolDef } from "./types";

const MAX_LOG_ROWS = 200;

export const metaTools: ToolDef[] = [
  {
    name: "get_api_url",
    description: "Get this instance's public API base URL and the map of API surfaces.",
    scope: null,
    readOnly: true,
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const api = apiBaseUrl();
      return {
        text: JSON.stringify(
          {
            api_url: api,
            surfaces: {
              rest: `${api}/rest/v1/<table>`,
              rpc: `${api}/rpc/v1/<function>`,
              auth: `${api}/auth/v1/<signin|signup|refresh|signout|magiclink>`,
              storage: `${api}/storage/v1/object/<sign|sign-batch|upload>/…`,
              realtime: `${api}/realtime?schema=<s>&table=<t>`,
              functions: `${api}/functions/v1/<name>`,
              mcp: `${api}/mcp/v1`,
            },
          },
          null,
          1,
        ),
      };
    },
  },

  {
    name: "get_anon_key",
    description:
      "Get the public anon key (safe to embed in client apps). The service_role key is deliberately NOT available through MCP — operators copy it from the dashboard when a backend needs it.",
    scope: null,
    readOnly: true,
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const key = await getAnonKey();
      return {
        text: `Anon key (role "anon", safe for client-side code):\n${key}\nSend as "Authorization: Bearer <key>" or "apikey: <key>".`,
      };
    },
  },

  {
    name: "get_logs",
    description:
      "Query the audit log: dashboard actions, auth events, SQL runs, edge-function invocations (including failures), and MCP tool calls. Filter by action prefix (e.g. function.invoke, auth., mcp., sql.run), target, failures-only, and time window.",
    scope: "logs:read",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        action_prefix: { type: "string", description: "e.g. \"function.invoke\", \"auth.\", \"mcp.\"" },
        target: { type: "string", description: "Exact target match (e.g. a function or table name)." },
        failures_only: { type: "boolean" },
        since_minutes: { type: "number", description: "Look-back window. Default 60." },
        limit: { type: "number", description: "Max rows, ≤200. Default 50." },
      },
    },
    handler: async (args) => {
      const since = Number.isFinite(Number(args.since_minutes))
        ? Math.min(Math.max(Number(args.since_minutes), 1), 60 * 24 * 30)
        : 60;
      const limit = Number.isFinite(Number(args.limit))
        ? Math.min(Math.max(Number(args.limit), 1), MAX_LOG_ROWS)
        : 50;

      const where: string[] = [`created_at > now() - make_interval(mins => $1)`];
      const params: unknown[] = [since];
      if (typeof args.action_prefix === "string" && args.action_prefix) {
        params.push(args.action_prefix.replace(/[%_]/g, "\\$&") + "%");
        where.push(`action LIKE $${params.length}`);
      }
      if (typeof args.target === "string" && args.target) {
        params.push(args.target);
        where.push(`target = $${params.length}`);
      }
      if (args.failures_only === true) {
        where.push(`success = false`);
      }
      params.push(limit);

      const { rows } = await pool().query(
        `SELECT id, created_at, actor, role, action, target, statement,
                metadata, host(ip) AS ip, success
           FROM _dashboard.audit_log
          WHERE ${where.join(" AND ")}
          ORDER BY id DESC
          LIMIT $${params.length}`,
        params,
      );
      return { text: wrapUntrusted(`Audit log (${rows.length} rows, last ${since} min):`, rows) };
    },
  },

  {
    name: "get_advisors",
    description:
      "Run the Onebase security/configuration advisors: missing RLS, anon write grants, ungated edge functions, public buckets, disabled rate limits, CORS posture, realtime-without-RLS, active write tokens. Run this after schema changes and before going to production.",
    scope: "db:read",
    readOnly: true,
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const advisories = await runAdvisors();
      const warns = advisories.filter((a) => a.level === "warn").length;
      return {
        text: wrapUntrusted(
          `Advisor report — ${warns} warning(s), ${advisories.length - warns} info:`,
          advisories,
        ),
      };
    },
  },

  {
    name: "verify_audit_chain",
    description:
      "Recompute the audit log's SHA-256 hash chain and report whether any row has been tampered with since it was written.",
    scope: "logs:read",
    readOnly: true,
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const result = await verifyAuditChain();
      if (result.ok) {
        return { text: `Chain intact: ${result.verified} rows verified in ${result.durationMs}ms.` };
      }
      return {
        text: `CHAIN BROKEN at row ${result.failedRowId}: ${result.reason} (${result.verifiedBefore} rows verified before the break). This means the audit log was modified outside the normal append path — treat as a security incident.`,
        isError: true,
      };
    },
  },

  {
    name: "search_docs",
    description:
      "Search the built-in Onebase documentation (auth model, REST API, storage, realtime, edge functions, operations, security model). Prefer this over guessing from Supabase conventions — Onebase differs in places.",
    scope: null,
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    handler: async (args) => {
      const terms = String(args.query ?? "")
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((t) => t.length > 2);
      if (terms.length === 0) return { text: "Provide a search query", isError: true };

      const scored = DOC_TOPICS.map((t) => {
        const haystack = `${t.title} ${t.keywords.join(" ")}`.toLowerCase();
        const body = t.body.toLowerCase();
        let score = 0;
        for (const term of terms) {
          if (haystack.includes(term)) score += 3;
          if (body.includes(term)) score += 1;
        }
        return { topic: t, score };
      })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

      if (scored.length === 0) {
        return {
          text: `No matches. Available topics: ${DOC_TOPICS.map((t) => t.slug).join(", ")}`,
        };
      }
      return {
        text: scored
          .map(({ topic }) => `## ${topic.title}\n\n${topic.body.replace("${API_PUBLIC_URL}", apiBaseUrl())}`)
          .join("\n\n---\n\n"),
      };
    },
  },

  {
    name: "generate_client_snippet",
    description:
      "Generate a correct fetch/EventSource snippet for this instance (real URLs filled in). Surfaces: " +
      SNIPPET_SURFACES.join(", ") +
      ". Onebase has no client SDK — apps use these patterns directly.",
    scope: null,
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { surface: { type: "string", enum: [...SNIPPET_SURFACES] } },
      required: ["surface"],
    },
    handler: async (args) => {
      const surface = String(args.surface ?? "");
      if (!isSnippetSurface(surface)) {
        return { text: `Unknown surface. One of: ${SNIPPET_SURFACES.join(", ")}`, isError: true };
      }
      return { text: generateSnippet(surface) };
    },
  },
];
