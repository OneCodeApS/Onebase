import { scopeAllowed, type TokenAuth } from "../access-tokens";
import { databaseTools } from "./tools-database";
import { platformTools } from "./tools-platform";
import { metaTools } from "./tools-meta";
import type { ToolDef } from "./types";

export const REGISTRY: ToolDef[] = [
  ...databaseTools,
  ...platformTools,
  ...metaTools,
];

// Tools the given token may call. Used by both tools/list and tools/call so
// an under-scoped token never even sees the names of tools it can't use.
export function visibleTools(auth: TokenAuth): ToolDef[] {
  return REGISTRY.filter((t) => t.scope === null || scopeAllowed(auth, t.scope));
}

export function findTool(auth: TokenAuth, name: string): ToolDef | null {
  return visibleTools(auth).find((t) => t.name === name) ?? null;
}
