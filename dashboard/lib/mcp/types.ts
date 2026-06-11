import type { Scope, TokenAuth } from "../access-tokens";

// One MCP tool. The registry (lib/mcp/registry.ts) is the single source of
// truth for what an agent can see and call; scope gating happens in both
// tools/list (visibility) and tools/call (dispatch), so a token never even
// learns the names of tools it can't use.
export type ToolDef = {
  name: string;
  description: string;
  // JSON Schema for the `arguments` object of tools/call.
  inputSchema: Record<string, unknown>;
  // Required scope. null = available to every valid token.
  scope: Scope | null;
  // Surfaced as the MCP readOnlyHint annotation — purely advisory for
  // clients; enforcement is the scope + role ladder.
  readOnly: boolean;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
};

export type ToolContext = {
  auth: TokenAuth;
  ip: string | null;
};

export type ToolResult = {
  text: string;
  isError?: boolean;
};
