#!/usr/bin/env node
// Realtime authorized-mode (per-subscriber RLS) integration test.
//
// Proves the confidentiality fix: with a table in "authorized" mode, a change
// is delivered over /realtime ONLY to subscribers whose RLS SELECT policy lets
// them read that row — matching REST. Models the acceptance target
// (msp_chat_messages with `channel_id IN (SELECT current_user_channel_ids())`)
// using a self-contained throwaway schema:
//
//   rls_test_participants(user_id uuid, channel_id int)
//   rls_test_messages(id serial pk, channel_id int, body text)  -- RLS:
//     USING (channel_id IN (SELECT channel_id FROM rls_test_participants
//                            WHERE user_id = auth.uid()))
//
// Two users: A participates in channel 1, B in channel 2. Asserts:
//   1. INSERT into channel 1  → A receives, B does NOT
//   2. UPDATE that row        → A receives, B does NOT
//   3. DELETE that row        → A receives (old.channel_id=1), B does NOT
//   4. Expired token mid-stream → A (a participant!) receives NOTHING after exp
//      and is told token_expired (fail closed).
//
// The DASHBOARD SERVER under test must be running WITH REALTIME_RLS_DATABASE_URL
// set to a non-bypassrls (authenticator) connection — that's what authorized
// mode uses to evaluate RLS.
//
// Required env:
//   PGRST_JWT_SECRET  — same secret the dashboard verifies access tokens with
//   DATABASE_URL      — admin connection (setup / writes / cleanup)
// Optional env:
//   RT_HOST (default 127.0.0.1)  RT_PORT (default 3000)
//
// Example (PowerShell, secrets from .env):
//   $env:PGRST_JWT_SECRET = (Get-Content .env | ? {$_ -match '^PGRST_JWT_SECRET='}) -replace '^PGRST_JWT_SECRET=',''
//   $env:DATABASE_URL     = (Get-Content .env | ? {$_ -match '^DATABASE_URL='})     -replace '^DATABASE_URL=',''
//   node ./scripts/realtime-rls-test.mjs

import http from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { SignJWT } from "jose";

const HOST = process.env.RT_HOST ?? "127.0.0.1";
const PORT = Number(process.env.RT_PORT ?? 3000);
const SECRET = process.env.PGRST_JWT_SECRET;
const DB = process.env.DATABASE_URL;
const SCHEMA = "public";
const MSGS = "rls_test_messages";
const PARTS = "rls_test_participants";

if (!SECRET || !DB) {
  console.error("Set PGRST_JWT_SECRET and DATABASE_URL in the environment.");
  process.exit(2);
}

const secretBytes = new TextEncoder().encode(SECRET);
const userA = randomUUID();
const userB = randomUUID();

function mintToken(sub, ttl = "1h") {
  return new SignJWT({ sub, email: `${sub}@test.dev`, role: "authenticated" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(secretBytes);
}

const admin = new pg.Client({ connectionString: DB, application_name: "rls-test" });
await admin.connect();

async function setup() {
  await admin.query(`DROP TABLE IF EXISTS ${SCHEMA}.${MSGS}`);
  await admin.query(`DROP TABLE IF EXISTS ${SCHEMA}.${PARTS}`);
  await admin.query(
    `CREATE TABLE ${SCHEMA}.${PARTS} (user_id uuid NOT NULL, channel_id int NOT NULL)`,
  );
  await admin.query(
    `CREATE TABLE ${SCHEMA}.${MSGS} (id serial PRIMARY KEY, channel_id int NOT NULL, body text)`,
  );
  // The subquery in the policy runs as `authenticated`, so it needs SELECT here.
  await admin.query(`GRANT SELECT ON ${SCHEMA}.${PARTS} TO authenticated`);
  await admin.query(`GRANT SELECT ON ${SCHEMA}.${MSGS} TO authenticated`);
  await admin.query(`ALTER TABLE ${SCHEMA}.${MSGS} ENABLE ROW LEVEL SECURITY`);
  await admin.query(
    `CREATE POLICY rls_test_sel ON ${SCHEMA}.${MSGS} FOR SELECT TO authenticated
       USING (channel_id IN (SELECT channel_id FROM ${SCHEMA}.${PARTS} WHERE user_id = auth.uid()))`,
  );
  await admin.query(`INSERT INTO ${SCHEMA}.${PARTS} (user_id, channel_id) VALUES ($1, 1)`, [userA]);
  await admin.query(`INSERT INTO ${SCHEMA}.${PARTS} (user_id, channel_id) VALUES ($1, 2)`, [userB]);
  await admin.query(`SELECT _dashboard.enable_realtime($1, $2, 'authorized')`, [SCHEMA, MSGS]);
}

async function cleanup() {
  await admin.query(`SELECT _dashboard.disable_realtime($1, $2)`, [SCHEMA, MSGS]).catch(() => {});
  await admin.query(`DROP TABLE IF EXISTS ${SCHEMA}.${MSGS}`).catch(() => {});
  await admin.query(`DROP TABLE IF EXISTS ${SCHEMA}.${PARTS}`).catch(() => {});
  await admin
    .query(`DELETE FROM _dashboard.realtime_tables WHERE schema=$1 AND "table"=$2`, [SCHEMA, MSGS])
    .catch(() => {});
  await admin.end();
}

// Opens an SSE stream and collects parsed data events + whether token_expired
// fired. Returns a handle with .events (array of {type,...}) and .close().
function openStream(token) {
  const handle = { events: [], expired: false, open: false, status: 0, req: null };
  let buf = "";
  const path = `/realtime?schema=${SCHEMA}&table=${MSGS}&token=${encodeURIComponent(token)}`;
  const req = http.request({ host: HOST, port: PORT, path, method: "GET" }, (res) => {
    handle.status = res.statusCode;
    if (res.statusCode !== 200) {
      res.resume();
      return;
    }
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (frame.includes("event: open")) handle.open = true;
        if (frame.includes("event: token_expired")) handle.expired = true;
        for (const line of frame.split("\n")) {
          if (line.startsWith("data: ")) {
            const raw = line.slice(6);
            try {
              handle.events.push(JSON.parse(raw));
            } catch {
              /* open/heartbeat payloads */
            }
          }
        }
      }
    });
    res.on("error", () => {});
  });
  req.on("error", () => {});
  req.end();
  handle.req = req;
  return handle;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Has the stream seen an event of `type` carrying `body` (in new or old)?
function saw(handle, type, body) {
  return handle.events.some(
    (e) => e.type === type && (e?.new?.body === body || e?.old?.body === body),
  );
}

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"} — ${name}`);
  if (!cond) failures++;
}

try {
  await setup();

  const tokenA = await mintToken(userA);
  const tokenB = await mintToken(userB);
  const a = openStream(tokenA);
  const b = openStream(tokenB);
  await sleep(800); // let both streams open

  // 1. INSERT into channel 1
  const insBody = `ins-${Date.now()}`;
  const { rows: ins } = await admin.query(
    `INSERT INTO ${SCHEMA}.${MSGS} (channel_id, body) VALUES (1, $1) RETURNING id`,
    [insBody],
  );
  const msgId = ins[0].id;
  await sleep(1200);
  check("INSERT delivered to participant A", saw(a, "INSERT", insBody));
  check("INSERT withheld from non-participant B", !saw(b, "INSERT", insBody));

  // 2. UPDATE the row (stays in channel 1)
  const updBody = `upd-${Date.now()}`;
  await admin.query(`UPDATE ${SCHEMA}.${MSGS} SET body=$1 WHERE id=$2`, [updBody, msgId]);
  await sleep(1200);
  check("UPDATE delivered to participant A", saw(a, "UPDATE", updBody));
  check("UPDATE withheld from non-participant B", !saw(b, "UPDATE", updBody));

  // 3. DELETE the row (old.channel_id = 1)
  await admin.query(`DELETE FROM ${SCHEMA}.${MSGS} WHERE id=$1`, [msgId]);
  await sleep(1200);
  check("DELETE delivered to participant A", saw(a, "DELETE", updBody));
  check("DELETE withheld from non-participant B", !saw(b, "DELETE", updBody));

  a.req.destroy();
  b.req.destroy();

  // 4. Expired-token fail-closed. A IS a participant, so the only reason to not
  //    receive is expiry. Token lives ~3s; we insert after it lapses.
  const shortTok = await mintToken(userA, "3s");
  const c = openStream(shortTok);
  await sleep(800);
  check("short-lived stream opened", c.open || c.status === 200);
  await sleep(3500); // let the token expire mid-stream
  const expBody = `exp-${Date.now()}`;
  await admin.query(`INSERT INTO ${SCHEMA}.${MSGS} (channel_id, body) VALUES (1, $1)`, [expBody]);
  await sleep(1500);
  check("expired token fired token_expired", c.expired);
  check("no event delivered after token expiry (fail closed)", !saw(c, "INSERT", expBody));
  c.req.destroy();
} finally {
  await cleanup();
}

console.log(failures === 0 ? "\nRESULT: PASS" : `\nRESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
