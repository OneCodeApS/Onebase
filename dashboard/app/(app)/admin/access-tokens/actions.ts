"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/session";
import { audit } from "@/lib/audit";
import {
  isScope,
  isWriteScope,
  mintToken,
  revokeToken,
  updateTokenScopes,
  TOKEN_NAME,
  type Scope,
} from "@/lib/access-tokens";

async function clientIp(): Promise<string | null> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return h.get("x-real-ip");
}

export type CreateTokenResult =
  | { ok: true; token: string; name: string; mcpUrl: string; scopes: Scope[]; readOnly: boolean }
  | { ok: false; error: string }
  | null;

export async function createAccessToken(
  _prev: CreateTokenResult,
  formData: FormData,
): Promise<CreateTokenResult> {
  const session = await getSession();
  if (session.role !== "admin") {
    return { ok: false, error: "Admin only" };
  }

  const name = String(formData.get("name") ?? "").trim();
  const expiresInDays = Number(formData.get("expires_in_days"));
  const readOnly = formData.get("read_only") === "on";
  const scopes = formData
    .getAll("scopes")
    .map(String)
    .filter(isScope) as Scope[];

  if (!TOKEN_NAME.test(name)) {
    return { ok: false, error: "Name must be 1-64 printable characters" };
  }
  if (scopes.length === 0) {
    return { ok: false, error: "Select at least one scope" };
  }
  // A read-only token holding write scopes is legal (the flag wins at use
  // time) but confusing — reject it so what the list page shows is what the
  // token can actually do.
  if (readOnly && scopes.some(isWriteScope)) {
    return {
      ok: false,
      error: "Read-only tokens cannot carry write scopes — untick read-only or drop the write scopes",
    };
  }

  let result: { plaintext: string; id: string };
  try {
    result = await mintToken({
      name,
      userId: session.userId!,
      scopes,
      readOnly,
      expiresInDays,
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role: "admin",
    action: "access_token.create",
    target: name,
    ip: await clientIp(),
    sessionId: session.sessionId ?? null,
    metadata: {
      token_id: result.id,
      scopes,
      read_only: readOnly,
      expires_in_days: expiresInDays,
    },
  });

  // Build the ready-to-paste connect command for the success view. Same URL
  // derivation as the page's "Connect an agent" card.
  const apiUrl = (process.env.API_PUBLIC_URL ?? "https://api.example.com").replace(/\/+$/, "");
  const mcpUrl = `${apiUrl}/mcp/v1`;

  revalidatePath("/admin/access-tokens");
  return { ok: true, token: result.plaintext, name, mcpUrl, scopes, readOnly };
}

export type UpdateTokenResult =
  | { ok: true }
  | { ok: false; error: string }
  | null;

// Edits the rights of an existing token in place. Every scope and the
// read-only flag are set independently — no cross-disabling — because the
// stored set is still gated by scopeAllowed (owner role + read_only) when the
// token is actually used. The token string never changes, so clients keep
// working without re-pasting their .mcp.json. Logged as access_token.update
// with the before→after diff.
export async function updateAccessToken(
  _prev: UpdateTokenResult,
  formData: FormData,
): Promise<UpdateTokenResult> {
  const session = await getSession();
  if (session.role !== "admin") {
    return { ok: false, error: "Admin only" };
  }

  const id = String(formData.get("id") ?? "");
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    return { ok: false, error: "Invalid token id" };
  }

  const readOnly = formData.get("read_only") === "on";
  const scopes = formData
    .getAll("scopes")
    .map(String)
    .filter(isScope) as Scope[];

  if (scopes.length === 0) {
    return { ok: false, error: "Select at least one scope" };
  }

  let res: Awaited<ReturnType<typeof updateTokenScopes>>;
  try {
    res = await updateTokenScopes({ id, scopes, readOnly });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (!res) {
    return { ok: false, error: "Token not found or already revoked" };
  }

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role: "admin",
    action: "access_token.update",
    target: res.name,
    ip: await clientIp(),
    sessionId: session.sessionId ?? null,
    metadata: {
      token_id: id,
      scopes,
      read_only: readOnly,
      previous_scopes: res.previousScopes,
      previous_read_only: res.previousReadOnly,
    },
  });

  revalidatePath("/admin/access-tokens");
  return { ok: true };
}

export async function revokeAccessToken(formData: FormData): Promise<void> {
  const session = await getSession();
  if (session.role !== "admin") {
    throw new Error("Admin only");
  }
  const id = String(formData.get("id") ?? "");
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    throw new Error("Invalid token id");
  }

  const name = await revokeToken(id);

  await audit({
    actor: session.email!,
    actorId: session.userId,
    role: "admin",
    action: "access_token.revoke",
    target: name ?? id,
    success: name !== null,
    ip: await clientIp(),
    sessionId: session.sessionId ?? null,
    metadata: { token_id: id },
  });

  revalidatePath("/admin/access-tokens");
}
