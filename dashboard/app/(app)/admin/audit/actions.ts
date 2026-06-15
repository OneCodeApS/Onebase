"use server";

import { headers } from "next/headers";
import { getSession } from "@/lib/session";
import { audit } from "@/lib/audit";
import { verifyAuditChain, type VerifyResult } from "@/lib/audit-verify";

export type { VerifyResult };

async function clientIp(): Promise<string | null> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return h.get("x-real-ip");
}

export async function verifyChain(): Promise<VerifyResult> {
  const session = await getSession();
  if (session.role !== "admin") {
    throw new Error("Not authorised");
  }

  // The walk itself lives in lib/audit-verify.ts, shared with the MCP
  // verify_audit_chain tool.
  const result = await verifyAuditChain();

  // Auditing the verifier run itself — meta but important for traceability.
  await audit({
    actor: session.email!,
    actorId: session.userId,
    role: "admin",
    action: "audit.verify",
    success: result.ok,
    ip: await clientIp(),
    sessionId: session.sessionId ?? null,
    metadata: result.ok
      ? { verified: result.verified, duration_ms: result.durationMs }
      : {
          failed_row_id: result.failedRowId,
          reason: result.reason,
          verified_before: result.verifiedBefore,
        },
  });

  return result;
}
