#!/usr/bin/env node
// Storage read_check / write_check integration test (migration 0033).
//
// Proves that a private bucket with a check function authorizes per object
// through the app's own RLS, and that every failure mode denies:
//
//   storage_check_rows(id uuid pk, owner uuid)       -- RLS: owner = auth.uid()
//   storage_check_can(p_bucket, p_keys)              -- SECURITY INVOKER:
//     returns the keys whose first path segment is a row the caller can SELECT
//   storage_check_definer(p_bucket, p_keys)          -- same body, SECURITY DEFINER
//
// Two users, each owning one row. Asserts:
//   1. A signs a key under A's row               → 200
//   2. B signs that same key                     → 403 (B's RLS hides A's row)
//   3. A uploads under A's row (write_check)     → 200; under B's row → 403
//   4. sign-batch, mixed keys                    → only A's key signed
//   5. a key with ".." / "//"                    → refused before the check runs
//   6. bucket whose check is SECURITY DEFINER    → 403 even for the owner
//   7. bucket whose check does not exist         → 403
//   8. private bucket with no check              → 403 (unchanged behaviour)
//   9. service_role                              → 200 on anything
//
// The DASHBOARD SERVER and POSTGREST under test must be running against the
// same database, and PostgREST must be able to see the new functions — the
// script sends NOTIFY pgrst; behind PgBouncer (PGRST_DB_CHANNEL_ENABLED=false)
// restart postgrest after setup instead.
//
// Required env:
//   PGRST_JWT_SECRET  — same secret the dashboard verifies access tokens with
//   DATABASE_URL      — admin connection (setup / cleanup)
// Optional env:
//   ST_HOST (default 127.0.0.1)  ST_PORT (default 3000)

import { randomUUID } from "node:crypto";
import pg from "pg";
import { SignJWT } from "jose";

const BASE = `http://${process.env.ST_HOST ?? "127.0.0.1"}:${Number(process.env.ST_PORT ?? 3000)}`;
const SECRET = process.env.PGRST_JWT_SECRET;
const DB = process.env.DATABASE_URL;
if (!SECRET || !DB) {
  console.error("Set PGRST_JWT_SECRET and DATABASE_URL in the environment.");
  process.exit(2);
}

const ROWS = "storage_check_rows";
const CAN = "storage_check_can";
const DEFINER = "storage_check_definer";
const MISSING = "storage_check_does_not_exist";
const BUCKETS = {
  checked: "storage-check-test",
  definer: "storage-check-definer",
  missing: "storage-check-missing",
  none: "storage-check-none",
};

const secretBytes = new TextEncoder().encode(SECRET);
const userA = randomUUID();
const userB = randomUUID();
const rowA = randomUUID();
const rowB = randomUUID();

const mint = (sub, role = "authenticated") =>
  new SignJWT({ sub, email: `${sub}@test.dev`, role })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secretBytes);

const admin = new pg.Client({ connectionString: DB, application_name: "storage-check-test" });
await admin.connect();

const fnBody = `
  select k from unnest(p_keys) as k
  where exists (select 1 from public.${ROWS} r where r.id::text = split_part(k, '/', 1))`;

async function setup() {
  await cleanupDb();
  await admin.query(`CREATE TABLE public.${ROWS} (id uuid PRIMARY KEY, owner uuid NOT NULL)`);
  await admin.query(`GRANT SELECT ON public.${ROWS} TO authenticated`);
  await admin.query(`ALTER TABLE public.${ROWS} ENABLE ROW LEVEL SECURITY`);
  await admin.query(
    `CREATE POLICY storage_check_sel ON public.${ROWS} FOR SELECT TO authenticated USING (owner = auth.uid())`,
  );
  await admin.query(`INSERT INTO public.${ROWS} VALUES ($1, $2), ($3, $4)`, [rowA, userA, rowB, userB]);
  await admin.query(
    `CREATE FUNCTION public.${CAN}(p_bucket text, p_keys text[]) RETURNS setof text
       LANGUAGE sql STABLE SECURITY INVOKER AS $$${fnBody}$$`,
  );
  await admin.query(
    `CREATE FUNCTION public.${DEFINER}(p_bucket text, p_keys text[]) RETURNS setof text
       LANGUAGE sql STABLE SECURITY DEFINER AS $$${fnBody}$$`,
  );
  await admin.query(`GRANT EXECUTE ON FUNCTION public.${CAN}(text, text[]) TO authenticated`);
  await admin.query(`GRANT EXECUTE ON FUNCTION public.${DEFINER}(text, text[]) TO authenticated`);
  const policies = [
    [BUCKETS.checked, CAN, CAN],
    [BUCKETS.definer, DEFINER, DEFINER],
    [BUCKETS.missing, MISSING, MISSING],
    [BUCKETS.none, null, null],
  ];
  for (const [bucket, read, write] of policies) {
    await admin.query(
      `INSERT INTO _dashboard.bucket_policies (bucket, visibility, read_check, write_check)
       VALUES ($1, 'private', $2, $3)`,
      [bucket, read, write],
    );
  }
  await admin.query(`NOTIFY pgrst, 'reload schema'`);
  await new Promise((r) => setTimeout(r, 1500));
}

async function cleanupDb() {
  await admin
    .query(`DELETE FROM _dashboard.bucket_policies WHERE bucket = ANY($1)`, [Object.values(BUCKETS)])
    .catch(() => {});
  await admin.query(`DROP FUNCTION IF EXISTS public.${CAN}(text, text[])`).catch(() => {});
  await admin.query(`DROP FUNCTION IF EXISTS public.${DEFINER}(text, text[])`).catch(() => {});
  await admin.query(`DROP TABLE IF EXISTS public.${ROWS}`).catch(() => {});
}

async function post(path, token, body = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, json };
}

const sign = (bucket, key, token) => post(`/storage/v1/object/sign/${bucket}/${key}`, token);
const upload = (bucket, key, token) =>
  post(`/storage/v1/object/upload/${bucket}/${key}`, token, { size: 10, content_type: "image/jpeg" });

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"} — ${name}`);
  if (!cond) failures++;
}

try {
  await setup();
  const tA = await mint(userA);
  const tB = await mint(userB);
  const tService = await mint(randomUUID(), "service_role");
  const keyA = `${rowA}/photo.jpg`;
  const keyB = `${rowB}/photo.jpg`;

  check("A may sign under A's row", (await sign(BUCKETS.checked, keyA, tA)).status === 200);
  check("B may NOT sign under A's row", (await sign(BUCKETS.checked, keyA, tB)).status === 403);
  check("A may upload under A's row", (await upload(BUCKETS.checked, keyA, tA)).status === 200);
  check("A may NOT upload under B's row", (await upload(BUCKETS.checked, keyB, tA)).status === 403);

  const batch = await post("/storage/v1/object/sign-batch", tA, {
    items: [
      { bucket: BUCKETS.checked, key: keyA },
      { bucket: BUCKETS.checked, key: keyB },
      { bucket: BUCKETS.checked, key: `${rowA}/../${rowB}/photo.jpg` },
      { bucket: BUCKETS.checked, key: `${rowA}//photo.jpg` },
    ],
  });
  const items = batch.json?.items ?? [];
  check("sign-batch answered", batch.status === 200 && items.length === 4);
  check("sign-batch signs A's key", Boolean(items[0]?.url));
  check("sign-batch refuses B's key", items[1]?.error === "forbidden_object");
  check("sign-batch refuses a '..' key", items[2]?.error === "forbidden_object");
  check("sign-batch refuses a '//' key", items[3]?.error === "forbidden_object");

  check("SECURITY DEFINER check denies even the owner", (await sign(BUCKETS.definer, keyA, tA)).status === 403);
  check("missing check function denies", (await sign(BUCKETS.missing, keyA, tA)).status === 403);
  check("private bucket without a check denies", (await sign(BUCKETS.none, keyA, tA)).status === 403);
  check("service_role signs anything", (await sign(BUCKETS.none, keyB, tService)).status === 200);
} finally {
  await cleanupDb();
  await admin.end();
}

console.log(failures === 0 ? "\nRESULT: PASS" : `\nRESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
