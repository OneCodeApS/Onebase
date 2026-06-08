import { pool } from "./db";
import { getEnvForFunction } from "./function-env";
import { audit } from "./audit";

export type EdgeFunction = {
  name: string;
  description: string | null;
  enabled: boolean;
  code: string;
  env: Record<string, string>;
  timeout_ms: number;
  verify_jwt: boolean;
  min_role: "anon" | "authenticated" | "service_role";
  created_at: Date;
  updated_at: Date;
};

// Caller identity passed into ctx.user. Null when the function ran with
// verify_jwt=false (truly public) or via cron. When verify_jwt=true the
// caller is whatever the JWT claims describe; for anon and service_role
// tokens, id/email are typically absent.
export type FunctionCaller = {
  id: string | null;
  email: string | null;
  role: string | null;
};

export const FUNCTION_NAME = /^[a-z][a-z0-9_-]{0,62}$/;

export async function listFunctions(): Promise<EdgeFunction[]> {
  const { rows } = await pool().query<EdgeFunction>(
    `SELECT name, description, enabled, code, env, timeout_ms, verify_jwt,
            min_role, created_at, updated_at
       FROM _dashboard.functions
       ORDER BY name`,
  );
  return rows;
}

export async function getFunction(name: string): Promise<EdgeFunction | null> {
  const { rows } = await pool().query<EdgeFunction>(
    `SELECT name, description, enabled, code, env, timeout_ms, verify_jwt,
            min_role, created_at, updated_at
       FROM _dashboard.functions WHERE name = $1`,
    [name],
  );
  return rows[0] ?? null;
}

export async function createFunction(input: {
  name: string;
  description?: string | null;
  code?: string;
  updatedBy?: string | null;
}): Promise<void> {
  if (!FUNCTION_NAME.test(input.name)) {
    throw new Error("Invalid function name");
  }
  await pool().query(
    `INSERT INTO _dashboard.functions (name, description, code, updated_by)
     VALUES ($1, $2, $3, $4)`,
    [
      input.name,
      input.description ?? null,
      input.code ?? defaultStarterCode(input.name),
      input.updatedBy ?? null,
    ],
  );
}

export async function updateFunction(
  name: string,
  patch: {
    description?: string | null;
    enabled?: boolean;
    code?: string;
    env?: Record<string, string>;
    timeout_ms?: number;
    verify_jwt?: boolean;
    min_role?: "anon" | "authenticated" | "service_role";
  },
  updatedBy: string | null,
): Promise<void> {
  await pool().query(
    `UPDATE _dashboard.functions
        SET description = COALESCE($2, description),
            enabled     = COALESCE($3, enabled),
            code        = COALESCE($4, code),
            env         = COALESCE($5::jsonb, env),
            timeout_ms  = COALESCE($6, timeout_ms),
            verify_jwt  = COALESCE($7, verify_jwt),
            min_role    = COALESCE($8, min_role),
            updated_by  = $9,
            updated_at  = now()
      WHERE name = $1`,
    [
      name,
      patch.description ?? null,
      patch.enabled ?? null,
      patch.code ?? null,
      patch.env ? JSON.stringify(patch.env) : null,
      patch.timeout_ms ?? null,
      patch.verify_jwt ?? null,
      patch.min_role ?? null,
      updatedBy,
    ],
  );
}

export async function deleteFunction(name: string): Promise<void> {
  await pool().query(`DELETE FROM _dashboard.functions WHERE name = $1`, [name]);
}

function defaultStarterCode(name: string): string {
  return `// ${name} — edge function
// Available in scope:
//   req           — Web Request (await req.json(), req.headers, …)
//   ctx.env       — environment variables. Manage them under
//                   Edge functions → Environment variables.
//                   Use in code as ctx.env.MY_KEY.
//   ctx.user      — the caller's JWT claims when verify_jwt is on:
//                   { id, email, role }. Each field may be null.
//                   role is "anon" | "authenticated" | "service_role" | ...
//                   null when verify_jwt is off or cron-triggered.
//   ctx.db.query  — Postgres query, runs as dashboard_admin.
//                   Example: await ctx.db.query("SELECT 1")
//   fetch, Response, URL, Headers, crypto — Web standards.
// Return a Response or any JSON-serializable value.

const body = req.method === "POST" ? await req.json().catch(() => null) : null;

// Example: read an env var (replace TEST with whatever you defined).
const test = ctx.env.TEST ?? null;

return Response.json({
  ok: true,
  method: req.method,
  body,
  test,
  now: new Date().toISOString(),
});
`;
}

// Compile-checks user code with the same AsyncFunction step the executor
// uses, without running it. Returns null if valid, or a one-line message
// describing the SyntaxError.
const AsyncFunctionCtor = Object.getPrototypeOf(async function () {})
  .constructor as new (...args: string[]) => unknown;

export function validateFunctionCode(code: string): string | null {
  try {
    new AsyncFunctionCtor("req", "ctx", code);
    return null;
  } catch (e) {
    return ((e as Error).message || "Invalid code").split("\n")[0];
  }
}

// Compiling user code with `new AsyncFunction(...)` is CPU work that doesn't
// need to repeat per invocation. Cache the compiled body keyed by name +
// updated_at, so an edit busts the cache (updateFunction sets updated_at =
// now()) but repeat calls hit instantly. Bounded memory: we drop other
// entries for the same name on miss, so at most N entries (one per function).
type CompiledFn = (req: Request, ctx: unknown) => Promise<unknown>;

declare global {
  // eslint-disable-next-line no-var
  var __fnCompileCache: Map<string, CompiledFn> | undefined;
}

function getCompiled(fn: EdgeFunction): CompiledFn {
  if (!globalThis.__fnCompileCache) {
    globalThis.__fnCompileCache = new Map();
  }
  const cache = globalThis.__fnCompileCache;
  const updatedAtMs =
    fn.updated_at instanceof Date
      ? fn.updated_at.getTime()
      : new Date(fn.updated_at).getTime();
  const key = `${fn.name}:${updatedAtMs}`;

  const hit = cache.get(key);
  if (hit) return hit;

  // Drop any stale entries for this name (older versions).
  for (const k of cache.keys()) {
    if (k !== key && k.startsWith(`${fn.name}:`)) cache.delete(k);
  }

  const compiled = new (AsyncFunctionCtor as new (...args: string[]) => CompiledFn)(
    "req",
    "ctx",
    fn.code,
  );
  cache.set(key, compiled);
  return compiled;
}

// Writes one audit row per invocation. Shared by the HTTP route and the cron
// runner so cron-driven invocations also show up on the invocations page.
//
// trigger.kind is the only required discriminator; cron carries the job name
// as `trigger.job` so the invocations page can show "cron: <job>".
export type InvocationTrigger =
  | { kind: "http" }
  | { kind: "cron"; job: string };

export async function auditInvocation(
  fn: EdgeFunction,
  method: string,
  result: ExecResult,
  trigger: InvocationTrigger,
  ip: string | null,
): Promise<void> {
  await audit({
    actor: trigger.kind === "cron" ? `<cron:${trigger.job}>` : "<edge-function-caller>",
    actorId: null,
    role: null,
    action: "function.invoke",
    target: fn.name,
    success: result.ok,
    ip,
    metadata: {
      method,
      trigger: trigger.kind,
      ...(trigger.kind === "cron" ? { cron_job: trigger.job } : {}),
      duration_ms: result.durationMs,
      ...(result.ok
        ? { status: result.response.status }
        : { error: result.error.split("\n")[0] }),
    },
  });
}

// Executes the function. NOT a security boundary — admins are trusted.
// Returns whatever the function returns (Response or anything JSON-able).
export type ExecResult =
  | { ok: true; response: Response; durationMs: number }
  | { ok: false; error: string; durationMs: number };

export async function executeFunction(
  fn: EdgeFunction,
  req: Request,
  caller: FunctionCaller | null = null,
): Promise<ExecResult> {
  const started = Date.now();
  try {
    // Compiled function bodies are cached by name + updated_at (see
    // getCompiled). Repeat invocations reuse the same AsyncFunction; edits
    // bust the cache automatically. Full-Node trust either way — admin-only
    // constraint on create/edit is what keeps this safe.
    const compiled = getCompiled(fn);

    // Merge global function_env vars with per-function overrides. Globals
    // come from _dashboard.function_env, per-function lives on the function
    // row, per-function wins on key collision.
    const env = await getEnvForFunction(fn.env ?? {});

    const ctx = {
      env,
      user: caller,
      db: {
        query: (sql: string, params?: unknown[]) =>
          pool().query(sql, params as unknown[] | undefined),
      },
    };

    const raceResult = await Promise.race([
      compiled(req, ctx),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Function timed out after ${fn.timeout_ms}ms`)),
          fn.timeout_ms,
        ),
      ),
    ]);

    const response =
      raceResult instanceof Response
        ? raceResult
        : Response.json(raceResult ?? null);
    return { ok: true, response, durationMs: Date.now() - started };
  } catch (e) {
    return {
      ok: false,
      error: (e as Error).stack ?? (e as Error).message ?? "Unknown error",
      durationMs: Date.now() - started,
    };
  }
}
