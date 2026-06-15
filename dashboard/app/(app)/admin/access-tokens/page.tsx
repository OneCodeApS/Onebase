import Link from "next/link";
import { listTokens } from "@/lib/access-tokens";
import { Card } from "../../_components/Card";
import { CreateTokenForm } from "./_components/CreateTokenForm";
import { TokenRow } from "./_components/TokenRow";

function fmt(d: Date | null): string {
  if (!d) return "—";
  return new Date(d).toISOString().slice(0, 16).replace("T", " ");
}

export default async function AccessTokensPage() {
  const tokens = await listTokens();
  const apiUrl = (process.env.API_PUBLIC_URL ?? "https://api.example.com").replace(/\/+$/, "");
  const mcpUrl = `${apiUrl}/mcp/v1`;

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <Link href="/" className="text-sm text-neutral-400 hover:text-neutral-100">
        ← Back
      </Link>
      <h1 className="mt-4 text-2xl font-semibold">Access tokens (MCP)</h1>
      <p className="mt-2 text-sm text-neutral-400">
        Personal access tokens let AI coding agents (Claude Code, Cursor, VS
        Code) connect to this instance&apos;s built-in MCP server. Tokens are hashed
        at rest, expire, and can be revoked individually — unlike the anon /
        service-role JWTs. Every MCP call is rate-limited and lands in the
        audit log.
      </p>

      <Card padded className="mt-6">
        <h2 className="text-lg font-medium">Create token</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Start read-only with <span className="font-mono text-neutral-300">db:read</span>;
          add write scopes only when the agent needs them. A token&apos;s power is
          additionally capped by your dashboard role at use time.
        </p>
        <div className="mt-4">
          <CreateTokenForm />
        </div>
      </Card>

      <Card padded className="mt-4">
        <h2 className="text-lg font-medium">Tokens</h2>
        {tokens.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">No tokens yet.</p>
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
              {tokens.map((t) => {
                const dead = t.revoked_at !== null || new Date(t.expires_at) < new Date();
                return (
                  <TokenRow
                    key={t.id}
                    id={t.id}
                    name={t.name}
                    ownerEmail={t.owner_email}
                    scopes={t.scopes}
                    readOnly={t.read_only}
                    expires={fmt(t.expires_at)}
                    lastUsed={fmt(t.last_used_at)}
                    dead={dead}
                    revoked={t.revoked_at !== null}
                  />
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <Card padded className="mt-4">
        <h2 className="text-lg font-medium">Connect an agent</h2>
        <p className="mt-1 text-sm text-neutral-500">
          The MCP endpoint lives on the API host. Replace{" "}
          <span className="font-mono text-neutral-300">&lt;token&gt;</span> with a
          token from above.
        </p>

        <p className="mt-3 text-sm text-neutral-400">Claude Code</p>
        <pre className="mt-1 overflow-x-auto rounded border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-300">{`claude mcp add onebase --scope project --transport http ${mcpUrl} \\
  --header "Authorization: Bearer <token>"`}</pre>

        <p className="mt-3 text-sm text-neutral-400">
          Cursor / VS Code (<span className="font-mono">mcp.json</span>)
        </p>
        <pre className="mt-1 overflow-x-auto rounded border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-300">{`{
  "mcpServers": {
    "onebase": {
      "type": "http",
      "url": "${mcpUrl}",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}`}</pre>
      </Card>
    </main>
  );
}
