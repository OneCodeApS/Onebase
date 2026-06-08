#!/usr/bin/env node
// Realtime fan-out load test.
//
// Opens LOAD_N concurrent SSE subscribers against a running dashboard's
// /realtime endpoint and proves the fan-out architecture (lib/realtime-listener.ts):
//   1. all N streams share ONE Postgres LISTEN connection — not one each, and
//   2. a single row INSERT is delivered to every one of the N streams.
//
// It creates a throwaway table (public.realtime_loadtest), enables realtime on
// it, runs the test, and cleans everything up afterwards.
//
// Required env:
//   PGRST_JWT_SECRET  — the same secret the dashboard verifies access tokens with
//   DATABASE_URL      — admin connection, used to set up / measure / clean up
// Optional env:
//   LOAD_N      (default 500)         concurrent streams to open
//   LOAD_HOST   (default 127.0.0.1)   dashboard host
//   LOAD_PORT   (default 3000)        dashboard port
//   LOAD_BATCH  (default 100)         streams opened per batch (limits the open burst)
//
// Example (PowerShell — pull secrets from .env.local):
//   $env:PGRST_JWT_SECRET = (Get-Content .env.local | ? {$_ -match '^PGRST_JWT_SECRET='}) -replace '^PGRST_JWT_SECRET=',''
//   $env:DATABASE_URL     = (Get-Content .env.local | ? {$_ -match '^DATABASE_URL='})     -replace '^DATABASE_URL=',''
//   $env:LOAD_N = 2000; npm run loadtest:realtime

import http from "node:http";
import pg from "pg";
import { SignJWT } from "jose";

const N = Number(process.env.LOAD_N ?? 500);
const HOST = process.env.LOAD_HOST ?? "127.0.0.1";
const PORT = Number(process.env.LOAD_PORT ?? 3000);
const BATCH = Number(process.env.LOAD_BATCH ?? 100);
const SECRET = process.env.PGRST_JWT_SECRET;
const DB = process.env.DATABASE_URL;
const schema = "public";
const TBL = "realtime_loadtest";

if (!SECRET || !DB) {
  console.error("Set PGRST_JWT_SECRET and DATABASE_URL in the environment.");
  process.exit(2);
}

const token = await new SignJWT({ sub: "loadtest", email: "load@test.dev", role: "authenticated" })
  .setProtectedHeader({ alg: "HS256", typ: "JWT" })
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(SECRET));

// application_name lets us exclude this measurement connection from the counts.
const admin = new pg.Client({ connectionString: DB, application_name: "realtime-loadtest" });
await admin.connect();
await admin.query(
  `CREATE TABLE IF NOT EXISTS ${schema}.${TBL} (id serial PRIMARY KEY, body text, at timestamptz DEFAULT now())`,
);
await admin.query(`SELECT _dashboard.enable_realtime('${schema}', '${TBL}')`);

async function conns() {
  const { rows } = await admin.query(
    `SELECT count(*) FILTER (WHERE usename='dashboard_admin' AND application_name <> 'realtime-loadtest')::int AS dashboard,
            count(*) FILTER (WHERE usename='dashboard_admin' AND query ILIKE 'LISTEN%')::int AS listening
       FROM pg_stat_activity`,
  );
  return rows[0];
}

console.log(`realtime load test → N=${N}, target=${HOST}:${PORT}`);
const c0 = await conns();
console.log(`pg conns before:  dashboard=${c0.dashboard} listening=${c0.listening}`);

const agent = new http.Agent({ maxSockets: N + 200, keepAlive: false });
const path = `/realtime?schema=${schema}&table=${TBL}&token=${encodeURIComponent(token)}`;
const streams = [];
const MARK = `loadtest-${Date.now()}`; // unique per run so broadcast detection is unambiguous

function openOne() {
  return new Promise((resolve) => {
    const st = { open: false, msg: false, status: 0, req: null, tMsg: 0 };
    const req = http.request({ host: HOST, port: PORT, path, agent, method: "GET" }, (res) => {
      st.status = res.statusCode;
      if (res.statusCode !== 200) {
        res.resume();
        resolve(st);
        return;
      }
      res.setEncoding("utf8");
      res.on("data", (c) => {
        if (!st.open && c.includes("event: open")) {
          st.open = true;
          resolve(st);
        }
        if (!st.msg && c.includes(MARK)) {
          st.msg = true;
          st.tMsg = Date.now();
        }
      });
      res.on("error", () => {});
    });
    st.req = req;
    req.on("error", () => resolve(st));
    req.end();
    streams.push(st);
  });
}

const t0 = Date.now();
for (let i = 0; i < N; i += BATCH) {
  await Promise.all(Array.from({ length: Math.min(BATCH, N - i) }, openOne));
}
await new Promise((r) => setTimeout(r, 2000));
const openMs = Date.now() - t0;
const opened = streams.filter((s) => s.open).length;
const non200 = streams.filter((s) => s.status && s.status !== 200).length;
console.log(`opened ${opened}/${N} streams in ${openMs}ms (non-200: ${non200})`);
const c1 = await conns();
console.log(`pg conns during:  dashboard=${c1.dashboard} listening=${c1.listening}   <-- one LISTEN for all ${opened} streams`);

const tb = Date.now();
await admin.query(`INSERT INTO ${schema}.${TBL} (body) VALUES ('${MARK}')`);
await new Promise((r) => setTimeout(r, 3000));
const got = streams.filter((s) => s.msg).length;
const lat = streams.filter((s) => s.tMsg).map((s) => s.tMsg - tb);
const maxLat = lat.length ? Math.max(...lat) : -1;
console.log(`broadcast delivered to ${got}/${opened} streams (slowest ${maxLat}ms after insert)`);

// cleanup
for (const s of streams) {
  try {
    s.req?.destroy();
  } catch {}
}
await admin.query(`SELECT _dashboard.disable_realtime('${schema}', '${TBL}')`).catch(() => {});
await admin.query(`DROP TABLE IF EXISTS ${schema}.${TBL}`).catch(() => {});
await admin
  .query(`DELETE FROM _dashboard.realtime_tables WHERE schema='${schema}' AND "table"='${TBL}'`)
  .catch(() => {});
await admin.end();

const pass = opened === N && got === opened && c1.listening === 1;
console.log(
  `RESULT: ${pass ? "PASS" : "CHECK"} — ${opened}/${N} opened, ${got} received broadcast, ${c1.listening} realtime connection(s)`,
);
process.exit(pass ? 0 : 1);
