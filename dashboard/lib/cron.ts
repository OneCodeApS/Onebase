import cron, { type ScheduledTask } from "node-cron";
import { pool } from "./db";
import { auditInvocation, executeFunction, getFunction } from "./functions";

export type CronJob = {
  name: string;
  schedule: string;
  function_name: string;
  enabled: boolean;
  last_run_at: Date | null;
  last_status: "success" | "failed" | "running" | null;
  last_error: string | null;
  last_duration_ms: number | null;
  created_at: Date;
  updated_at: Date;
};

export const CRON_JOB_NAME = /^[a-z][a-z0-9_-]{0,62}$/;

// In-memory map of currently-scheduled tasks. Lives as long as the dashboard
// process. After CRUD operations the admin actions call reloadCron() to
// rebuild this from the DB.
declare global {
  // eslint-disable-next-line no-var
  var __cronTasks: Map<string, ScheduledTask> | undefined;
}

function tasks(): Map<string, ScheduledTask> {
  if (!globalThis.__cronTasks) globalThis.__cronTasks = new Map();
  return globalThis.__cronTasks;
}

export function validateCronExpression(expr: string): boolean {
  return cron.validate(expr);
}

// CRUD

export async function listCronJobs(): Promise<CronJob[]> {
  const { rows } = await pool().query<CronJob>(
    `SELECT name, schedule, function_name, enabled,
            last_run_at, last_status, last_error, last_duration_ms,
            created_at, updated_at
       FROM _dashboard.cron_jobs
       ORDER BY name`,
  );
  return rows;
}

export async function getCronJob(name: string): Promise<CronJob | null> {
  const { rows } = await pool().query<CronJob>(
    `SELECT name, schedule, function_name, enabled,
            last_run_at, last_status, last_error, last_duration_ms,
            created_at, updated_at
       FROM _dashboard.cron_jobs WHERE name = $1`,
    [name],
  );
  return rows[0] ?? null;
}

export async function upsertCronJob(
  input: {
    name: string;
    schedule: string;
    function_name: string;
    enabled: boolean;
  },
  updatedBy: string | null,
): Promise<void> {
  if (!CRON_JOB_NAME.test(input.name)) {
    throw new Error("Invalid name");
  }
  if (!validateCronExpression(input.schedule)) {
    throw new Error("Invalid cron expression");
  }
  await pool().query(
    `INSERT INTO _dashboard.cron_jobs
       (name, schedule, function_name, enabled, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (name) DO UPDATE
       SET schedule      = EXCLUDED.schedule,
           function_name = EXCLUDED.function_name,
           enabled       = EXCLUDED.enabled,
           updated_by    = EXCLUDED.updated_by,
           updated_at    = now()`,
    [input.name, input.schedule, input.function_name, input.enabled, updatedBy],
  );
}

export async function deleteCronJob(name: string): Promise<void> {
  await pool().query(`DELETE FROM _dashboard.cron_jobs WHERE name = $1`, [name]);
}

// Scheduler

async function runJob(name: string): Promise<void> {
  const job = await getCronJob(name);
  if (!job || !job.enabled) return;

  await pool().query(
    `UPDATE _dashboard.cron_jobs SET last_run_at = now(), last_status = 'running' WHERE name = $1`,
    [name],
  );

  const fn = await getFunction(job.function_name);
  if (!fn) {
    await pool().query(
      `UPDATE _dashboard.cron_jobs
          SET last_status = 'failed',
              last_error  = $2,
              last_duration_ms = 0
        WHERE name = $1`,
      [name, `Function "${job.function_name}" not found`],
    );
    return;
  }
  if (!fn.enabled) {
    await pool().query(
      `UPDATE _dashboard.cron_jobs
          SET last_status = 'failed',
              last_error  = $2,
              last_duration_ms = 0
        WHERE name = $1`,
      [name, `Function "${job.function_name}" is disabled`],
    );
    return;
  }

  // Build a synthetic Request the function can introspect. X-Cron-Trigger
  // header lets handlers detect cron-driven calls vs. external HTTP.
  const req = new Request(`http://localhost/functions/v1/${fn.name}`, {
    method: "POST",
    headers: { "X-Cron-Trigger": name },
  });

  const result = await executeFunction(fn, req);

  // Mirror HTTP-route behaviour so cron-driven calls also show up on the
  // function's invocations page. Pass the cron job name as the trigger.
  await auditInvocation(fn, "POST", result, { kind: "cron", job: name }, null);

  if (result.ok) {
    await pool().query(
      `UPDATE _dashboard.cron_jobs
          SET last_status      = 'success',
              last_error       = NULL,
              last_duration_ms = $2
        WHERE name = $1`,
      [name, result.durationMs],
    );
  } else {
    await pool().query(
      `UPDATE _dashboard.cron_jobs
          SET last_status      = 'failed',
              last_error       = $2,
              last_duration_ms = $3
        WHERE name = $1`,
      [name, result.error.split("\n")[0], result.durationMs],
    );
  }
}

// Tear down the in-memory schedule. Called before every rebuild and when this
// replica loses scheduler leadership (lib/scheduler.ts), so a standby can take
// over without the jobs double-firing.
export function stopCron(): void {
  for (const t of tasks().values()) {
    try {
      t.stop();
    } catch {}
  }
  tasks().clear();
}

export async function reloadCron(): Promise<void> {
  stopCron();

  // Schedule every enabled job.
  const jobs = await listCronJobs();
  for (const j of jobs) {
    if (!j.enabled) continue;
    if (!validateCronExpression(j.schedule)) {
      // Don't blow up the whole reload — log and skip the bad one.
      console.error(`cron: invalid schedule "${j.schedule}" on job "${j.name}", skipping`);
      continue;
    }
    const t = cron.schedule(j.schedule, () => {
      runJob(j.name).catch((e) => {
        console.error(`cron job "${j.name}" failed`, e);
      });
    });
    tasks().set(j.name, t);
  }
  console.log(`[cron] scheduled ${tasks().size} job(s)`);
}

// Tell the scheduler leader (possibly a different replica) that the cron table
// changed and it should rebuild. pg_notify is delivered on commit, so the
// pooled/PgBouncer connection is fine here — only the leader's LISTEN needs a
// pinned session, and it holds one. The admin cron actions call this after
// every write.
export async function notifyCronReload(): Promise<void> {
  await pool().query(`NOTIFY cron_reload`);
}
