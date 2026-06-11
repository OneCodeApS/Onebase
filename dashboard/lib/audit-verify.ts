import { pool } from "./db";
import { chainHash, CHAIN_ANCHOR_KEY, type ChainBody } from "./audit";
import { getSetting } from "./settings";

// Walks the audit hash chain and recomputes every row. Shared by the admin
// audit page's Verify button and the MCP verify_audit_chain tool, so both
// use the exact same canonical form — any divergence would cause false
// positives.

export type VerifyResult =
  | { ok: true; verified: number; durationMs: number }
  | {
      ok: false;
      failedRowId: string;
      reason: string;
      expected: string | null;
      actual: string | null;
      verifiedBefore: number;
    };

type AuditRow = {
  id: string;
  created_at: Date;
  actor: string;
  role: ChainBody["role"];
  action: string;
  target: string | null;
  statement: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  success: boolean;
  session_id: string | null;
  prev_hash: string | null;
  hash: string | null;
};

export async function verifyAuditChain(): Promise<VerifyResult> {
  const started = Date.now();

  // Walk the whole log in ID order. The chain must be verified sequentially,
  // so streaming or pagination doesn't help here. If the log gets very large,
  // batching by id range would be the next optimisation.
  // host(ip) strips the implicit /32 or /128 subnet that Postgres adds to
  // inet values — the audit hash was computed with the bare address that the
  // app passed in, not the CIDR form ip::text would return.
  const { rows } = await pool().query<AuditRow>(
    `SELECT id, created_at, actor, role, action, target, statement,
            metadata, host(ip) AS ip, success, session_id, prev_hash, hash
       FROM _dashboard.audit_log
       ORDER BY id ASC`,
  );

  // If retention has pruned rows, the oldest remaining row's prev_hash
  // points at a deleted row. The anchor stores that hash so the chain
  // is verifiable from the retained window onward.
  const anchor = await getSetting<string>(CHAIN_ANCHOR_KEY);
  let expectedPrev: string | null = anchor ?? null;
  let verified = 0;

  for (const row of rows) {
    if (row.prev_hash !== expectedPrev) {
      return {
        ok: false,
        failedRowId: row.id,
        reason: "prev_hash does not match the previous row's hash",
        expected: expectedPrev,
        actual: row.prev_hash,
        verifiedBefore: verified,
      };
    }

    // actor_id is intentionally excluded — see ChainBody in lib/audit.ts.
    const body: ChainBody = {
      created_at: row.created_at.toISOString(),
      actor: row.actor,
      role: row.role,
      action: row.action,
      target: row.target,
      statement: row.statement,
      metadata: row.metadata ?? {},
      ip: row.ip,
      success: row.success,
      session_id: row.session_id,
    };
    const computed = chainHash(row.prev_hash, body);
    if (computed !== row.hash) {
      return {
        ok: false,
        failedRowId: row.id,
        reason: "stored hash does not match recomputed hash",
        expected: computed,
        actual: row.hash,
        verifiedBefore: verified,
      };
    }

    expectedPrev = row.hash;
    verified++;
  }

  return { ok: true, verified, durationMs: Date.now() - started };
}
