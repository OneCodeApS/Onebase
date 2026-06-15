import {
  createFunction,
  executeFunction,
  auditInvocation,
  FUNCTION_NAME,
  getFunction,
  listFunctions,
  updateFunction,
  validateFunctionCode,
} from "../functions";
import { listCronJobs, notifyCronReload, upsertCronJob, validateCronExpression } from "../cron";
import { getBucketPolicy, publicReadPolicy, setBucketPolicy, type Visibility } from "../storage";
import { minio } from "../minio";
import { confirmationRequest, verifyConfirmToken } from "./confirm";
import { wrapUntrusted } from "./untrusted";
import type { ToolDef } from "./types";

const MIN_ROLES = ["anon", "authenticated", "service_role"] as const;
type MinRole = (typeof MIN_ROLES)[number];

// Same rule the storage UI enforces (app/(app)/storage/actions.ts).
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

// Cap on function response bytes echoed into the agent's context.
const MAX_RESPONSE_CHARS = 8_000;

export const platformTools: ToolDef[] = [
  // ─── Edge functions ────────────────────────────────────────────────────────
  {
    name: "list_functions",
    description: "List edge functions with their config (no code — use get_function for that).",
    scope: "functions:read",
    readOnly: true,
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const fns = (await listFunctions()).map((f) => ({
        name: f.name,
        description: f.description,
        enabled: f.enabled,
        verify_jwt: f.verify_jwt,
        min_role: f.min_role,
        timeout_ms: f.timeout_ms,
        updated_at: f.updated_at,
      }));
      return { text: JSON.stringify(fns, null, 1) };
    },
  },

  {
    name: "get_function",
    description:
      "Get one edge function including its code. Env var VALUES are never returned — only the key names.",
    scope: "functions:read",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    handler: async (args) => {
      const fn = await getFunction(String(args.name ?? ""));
      if (!fn) return { text: "Function not found", isError: true };
      const safe = {
        name: fn.name,
        description: fn.description,
        enabled: fn.enabled,
        verify_jwt: fn.verify_jwt,
        min_role: fn.min_role,
        timeout_ms: fn.timeout_ms,
        env_keys: Object.keys(fn.env ?? {}),
        updated_at: fn.updated_at,
        code: fn.code,
      };
      return { text: wrapUntrusted(`Edge function "${fn.name}":`, safe) };
    },
  },

  {
    name: "deploy_function",
    description:
      "Create or update an edge function. The code is a JavaScript async-function body with req, ctx.env, ctx.user, and ctx.db.query in scope — it runs with FULL database access, which is why this needs an admin-owned token. Code is syntax-checked before saving. New functions default to verify_jwt=true, min_role=authenticated.",
    scope: "functions:write",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Lowercase, [a-z0-9_-], ≤63 chars." },
        code: { type: "string", description: "The function body." },
        description: { type: "string" },
        enabled: { type: "boolean" },
        verify_jwt: { type: "boolean" },
        min_role: { type: "string", enum: [...MIN_ROLES] },
        timeout_ms: { type: "number", description: "5000–60000." },
      },
      required: ["name", "code"],
    },
    handler: async (args, ctx) => {
      const name = String(args.name ?? "").trim();
      const code = String(args.code ?? "");
      if (!FUNCTION_NAME.test(name)) {
        return { text: "Invalid function name (lowercase, [a-z0-9_-], ≤63 chars)", isError: true };
      }
      const syntaxError = validateFunctionCode(code);
      if (syntaxError) {
        return { text: `Code does not compile: ${syntaxError}`, isError: true };
      }
      const minRole = args.min_role !== undefined ? String(args.min_role) : undefined;
      if (minRole !== undefined && !(MIN_ROLES as readonly string[]).includes(minRole)) {
        return { text: "min_role must be anon | authenticated | service_role", isError: true };
      }
      const timeout = args.timeout_ms !== undefined ? Number(args.timeout_ms) : undefined;
      if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 5000 || timeout > 60000)) {
        return { text: "timeout_ms must be an integer between 5000 and 60000", isError: true };
      }

      const existing = await getFunction(name);
      if (!existing) {
        await createFunction({
          name,
          description: typeof args.description === "string" ? args.description : null,
          code,
          updatedBy: ctx.auth.userId,
        });
      }
      await updateFunction(
        name,
        {
          code,
          description: typeof args.description === "string" ? args.description : undefined,
          enabled: typeof args.enabled === "boolean" ? args.enabled : undefined,
          verify_jwt: typeof args.verify_jwt === "boolean" ? args.verify_jwt : undefined,
          min_role: minRole as MinRole | undefined,
          timeout_ms: timeout,
        },
        ctx.auth.userId,
      );
      return {
        text: `Function "${name}" ${existing ? "updated" : "created"}. Invoke it at POST /functions/v1/${name}.`,
      };
    },
  },

  {
    name: "invoke_function",
    description:
      "Invoke an edge function with a test request (the call is made server-side as a trusted operator — ctx.user.role will be service_role). Useful for verifying a function after deploying it.",
    scope: "functions:invoke",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"], description: "Default POST." },
        body: { type: "string", description: "Request body (e.g. a JSON string)." },
        content_type: { type: "string", description: "Default application/json." },
      },
      required: ["name"],
    },
    handler: async (args, ctx) => {
      const name = String(args.name ?? "").trim();
      const fn = await getFunction(name);
      if (!fn) return { text: "Function not found", isError: true };
      if (!fn.enabled) return { text: `Function "${name}" is disabled`, isError: true };

      const method = typeof args.method === "string" ? args.method.toUpperCase() : "POST";
      const body = typeof args.body === "string" && method !== "GET" ? args.body : undefined;
      const req = new Request(`http://localhost/functions/v1/${name}`, {
        method,
        headers: {
          "Content-Type": typeof args.content_type === "string" ? args.content_type : "application/json",
          "X-MCP-Trigger": ctx.auth.tokenName,
        },
        body,
      });

      const result = await executeFunction(fn, req, {
        id: null,
        email: ctx.auth.email,
        role: "service_role",
      });
      // Shows up on the function's invocations page like any other call.
      await auditInvocation(fn, method, result, { kind: "http" }, ctx.ip);

      if (!result.ok) {
        return {
          text: wrapUntrusted(
            `Function "${name}" threw (${result.durationMs}ms):`,
            result.error.split("\n").slice(0, 12).join("\n"),
          ),
          isError: true,
        };
      }
      let text = await result.response.text();
      const truncated = text.length > MAX_RESPONSE_CHARS;
      if (truncated) text = text.slice(0, MAX_RESPONSE_CHARS);
      return {
        text: wrapUntrusted(
          `Function "${name}" → HTTP ${result.response.status} in ${result.durationMs}ms${truncated ? " (response truncated)" : ""}:`,
          text,
        ),
      };
    },
  },

  // ─── Storage ───────────────────────────────────────────────────────────────
  {
    name: "list_buckets",
    description: "List storage buckets with their policies (visibility, upload limit, MIME allowlist).",
    scope: "storage:read",
    readOnly: true,
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const buckets = await minio.listBuckets();
      const out = [];
      for (const b of buckets) {
        const policy = await getBucketPolicy(b.name);
        out.push({
          bucket: b.name,
          created: b.creationDate,
          visibility: policy.visibility,
          max_upload_mb: policy.max_upload_mb,
          allowed_mime: policy.allowed_mime,
        });
      }
      return { text: JSON.stringify(out, null, 1) };
    },
  },

  {
    name: "set_bucket_policy",
    description:
      "Update a bucket's policy: visibility (public buckets allow anonymous reads of EVERY object — requires a confirm_token round-trip), max upload size, MIME allowlist. Omitted fields keep their current value.",
    scope: "storage:write",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        bucket: { type: "string" },
        visibility: { type: "string", enum: ["public", "private"] },
        max_upload_mb: { type: "number" },
        allowed_mime: {
          type: "array",
          items: { type: "string" },
          description: "MIME allowlist, supports wildcards like image/*. Empty array = allow all.",
        },
        confirm_token: { type: "string" },
      },
      required: ["bucket"],
    },
    handler: async (args, ctx) => {
      const bucket = String(args.bucket ?? "").trim();
      if (!BUCKET_NAME.test(bucket)) return { text: "Invalid bucket name", isError: true };
      if (!(await minio.bucketExists(bucket))) {
        return { text: `Bucket "${bucket}" does not exist`, isError: true };
      }

      const current = await getBucketPolicy(bucket);
      const visibility =
        args.visibility === "public" || args.visibility === "private"
          ? (args.visibility as Visibility)
          : current.visibility;
      const maxMb = args.max_upload_mb !== undefined ? Number(args.max_upload_mb) : current.max_upload_mb;
      if (!Number.isInteger(maxMb) || maxMb < 1 || maxMb > 5000) {
        return { text: "max_upload_mb must be an integer between 1 and 5000", isError: true };
      }
      const allowedMime = Array.isArray(args.allowed_mime)
        ? args.allowed_mime.map(String).filter(Boolean)
        : current.allowed_mime;

      // Flipping a bucket to public exposes every object anonymously — make
      // the agent surface that to the human first.
      if (visibility === "public" && current.visibility !== "public") {
        const statement = `make-bucket-public:${bucket}`;
        const token = typeof args.confirm_token === "string" ? args.confirm_token : "";
        if (!token || !verifyConfirmToken(statement, token)) {
          return {
            text: confirmationRequest(
              `making bucket "${bucket}" public allows anonymous reads of every object in it`,
              statement,
            ),
          };
        }
      }

      await setBucketPolicy(
        {
          bucket,
          visibility,
          max_upload_mb: maxMb,
          allowed_mime: allowedMime && allowedMime.length > 0 ? allowedMime : null,
        },
        ctx.auth.userId,
      );
      // Mirror visibility to MinIO, exactly as the storage UI does.
      if (visibility === "public") {
        await minio.setBucketPolicy(bucket, publicReadPolicy(bucket));
      } else {
        await minio.setBucketPolicy(bucket, "");
      }
      return { text: `Bucket "${bucket}" policy updated (${visibility}, ${maxMb} MB max).` };
    },
  },

  // ─── Cron ──────────────────────────────────────────────────────────────────
  {
    name: "list_cron_jobs",
    description: "List scheduled cron jobs with their last run status.",
    scope: "cron:read",
    readOnly: true,
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const jobs = await listCronJobs();
      return { text: wrapUntrusted("Cron jobs:", jobs) };
    },
  },

  {
    name: "save_cron_job",
    description:
      "Create or update a cron job that invokes an edge function on a schedule (standard 5-field cron expression). Set enabled=false to pause a job.",
    scope: "cron:write",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Lowercase, [a-z0-9_-], ≤63 chars." },
        schedule: { type: "string", description: "Cron expression, e.g. */5 * * * *" },
        function_name: { type: "string", description: "Edge function to invoke." },
        enabled: { type: "boolean", description: "Default true." },
      },
      required: ["name", "schedule", "function_name"],
    },
    handler: async (args, ctx) => {
      const functionName = String(args.function_name ?? "").trim();
      if (!(await getFunction(functionName))) {
        return { text: `Edge function "${functionName}" does not exist — deploy it first`, isError: true };
      }
      const schedule = String(args.schedule ?? "").trim();
      if (!validateCronExpression(schedule)) {
        return { text: `Invalid cron expression: ${schedule}`, isError: true };
      }
      await upsertCronJob(
        {
          name: String(args.name ?? "").trim(),
          schedule,
          function_name: functionName,
          enabled: args.enabled !== false,
        },
        ctx.auth.userId,
      );
      await notifyCronReload();
      return { text: `Cron job "${args.name}" saved (${schedule} → ${functionName}).` };
    },
  },
];
