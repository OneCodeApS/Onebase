"use client";

import { useState } from "react";
import type { AccessTokenRow } from "@/lib/access-tokens";
import { TokenRow } from "./TokenRow";

function fmt(d: Date | null): string {
  if (!d) return "—";
  return new Date(d).toISOString().slice(0, 16).replace("T", " ");
}

// Client-side owner filter over the (already revoked-free) token list. The
// dropdown is built from the owners actually present, so it only offers values
// that match something. Filtering happens in the browser — the full list is
// small and already on the page, so there's nothing to refetch.
export function TokensTable({ tokens }: { tokens: AccessTokenRow[] }) {
  const owners = [...new Set(tokens.map((t) => t.owner_email))].sort();
  const [owner, setOwner] = useState("");

  const shown = owner ? tokens.filter((t) => t.owner_email === owner) : tokens;

  return (
    <>
      {owners.length > 1 && (
        <label className="mt-2 flex items-center gap-2 text-xs text-neutral-400">
          Owner
          <select
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm text-neutral-100"
          >
            <option value="">All owners ({tokens.length})</option>
            {owners.map((o) => (
              <option key={o} value={o}>
                {o} ({tokens.filter((t) => t.owner_email === o).length})
              </option>
            ))}
          </select>
        </label>
      )}

      {shown.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500">
          {owner ? "No tokens for this owner." : "No tokens yet."}
        </p>
      ) : (
        <table className="mt-3 w-full text-left text-xs">
          <thead className="text-neutral-500">
            <tr>
              <th className="py-1 pr-3 font-normal">Name</th>
              <th className="py-1 pr-3 font-normal">Owner</th>
              <th className="py-1 pr-3 font-normal">Scopes</th>
              <th className="py-1 pr-3 font-normal">Mode</th>
              <th className="py-1 pr-3 font-normal">Expires</th>
              <th className="py-1 pr-3 font-normal">Last used</th>
              <th className="py-1 font-normal"></th>
            </tr>
          </thead>
          <tbody className="text-neutral-300">
            {shown.map((t) => (
              <TokenRow
                key={t.id}
                id={t.id}
                name={t.name}
                ownerEmail={t.owner_email}
                scopes={t.scopes}
                readOnly={t.read_only}
                expires={fmt(t.expires_at)}
                lastUsed={fmt(t.last_used_at)}
                dead={new Date(t.expires_at) < new Date()}
                revoked={false}
              />
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
