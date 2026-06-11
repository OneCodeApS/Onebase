import crypto from "node:crypto";

// Two-step confirmation for destructive operations. When a statement looks
// destructive, the tool returns a one-time confirmation token instead of
// executing; the agent must echo it back in a second call. That puts the
// destructive intent into the conversation where the human can see it.
//
// Tokens are stateless HMACs over (expiry, sha256(statement)) keyed by
// SESSION_SECRET — they verify on any dashboard replica, expire after 10
// minutes, and are bound to the exact statement they were issued for.

const TTL_MS = 10 * 60 * 1000;

function secret(): Buffer {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error("SESSION_SECRET must be set and at least 32 characters");
  }
  return Buffer.from(s);
}

function mac(payload: string): string {
  return crypto
    .createHmac("sha256", secret())
    .update("mcp-confirm:" + payload)
    .digest("base64url");
}

function statementHash(statement: string): string {
  return crypto.createHash("sha256").update(statement).digest("base64url");
}

export function makeConfirmToken(statement: string): string {
  const payload = `${Date.now() + TTL_MS}.${statementHash(statement)}`;
  return `${payload}.${mac(payload)}`;
}

export function verifyConfirmToken(statement: string, token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [expStr, hash, sig] = parts;
  const expected = mac(`${expStr}.${hash}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  return hash === statementHash(statement);
}

// Heuristic, not a parser — same spirit as the SQL editor's read-only regex.
// False positives cost one extra round-trip; false negatives are still caught
// by the role ladder (a read token can't write at all).
export function looksDestructive(sql: string): string | null {
  if (/\b(DROP|TRUNCATE)\b/i.test(sql)) return "contains DROP or TRUNCATE";
  if (/\bDELETE\s+FROM\b/i.test(sql) && !/\bWHERE\b/i.test(sql)) {
    return "DELETE without a WHERE clause";
  }
  if (/\bUPDATE\b/i.test(sql) && /\bSET\b/i.test(sql) && !/\bWHERE\b/i.test(sql)) {
    return "UPDATE without a WHERE clause";
  }
  return null;
}

// Standard reply when confirmation is needed. The agent is instructed to
// surface the reason to the human before retrying with the token.
export function confirmationRequest(reason: string, statement: string): string {
  return [
    `CONFIRMATION REQUIRED — not executed. Reason: ${reason}.`,
    "If this is genuinely intended, tell the user what is about to happen, then call the same tool again with the same statement plus this confirm_token (valid 10 minutes):",
    makeConfirmToken(statement),
  ].join("\n");
}
