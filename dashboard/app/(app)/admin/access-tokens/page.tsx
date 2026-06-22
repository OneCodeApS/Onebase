import Link from "next/link";
import { listTokens } from "@/lib/access-tokens";
import { Card } from "../../_components/Card";
import { CreateTokenForm } from "./_components/CreateTokenForm";
import { TokensTable } from "./_components/TokensTable";

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
        <p className="mt-1 text-sm text-neutral-500">
          Revoked tokens are hidden. Filter by owner to see who created what.
        </p>
        <TokensTable tokens={tokens} />
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

        <p className="mt-3 text-sm text-neutral-400">
          Claude Desktop (<span className="font-mono">claude_desktop_config.json</span>)
        </p>
        <p className="mt-1 text-xs text-neutral-500">
          Claude Desktop&apos;s config only understands stdio servers — the{" "}
          <span className="font-mono text-neutral-400">type: &quot;http&quot;</span> form
          above is silently skipped. Bridge the HTTP endpoint with{" "}
          <span className="font-mono text-neutral-400">mcp-remote</span> instead (needs
          Node.js installed). On Windows, run it through{" "}
          <span className="font-mono text-neutral-400">cmd /c</span> so the spawned process
          resolves the <span className="font-mono text-neutral-400">npx</span> shim — a bare{" "}
          <span className="font-mono text-neutral-400">&quot;command&quot;: &quot;npx&quot;</span>{" "}
          often fails with ENOENT.
        </p>
        <pre className="mt-1 overflow-x-auto rounded border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-300">{`{
  "mcpServers": {
    "onebase": {
      "command": "cmd",
      "args": [
        "/c", "npx", "-y", "mcp-remote",
        "${mcpUrl}",
        "--header", "Authorization: Bearer <token>"
      ]
    }
  }
}`}</pre>
        <p className="mt-2 text-xs text-neutral-500">
          On macOS / Linux, set{" "}
          <span className="font-mono text-neutral-400">&quot;command&quot;: &quot;npx&quot;</span>{" "}
          and drop the <span className="font-mono text-neutral-400">&quot;/c&quot;</span> entry
          from the args. Restart Claude Desktop fully after editing.
        </p>
      </Card>
    </main>
  );
}
