// Single source of truth for the scope checkbox list, shared by the create
// form and the inline scope editor. Order mirrors lib/access-tokens.ts SCOPES;
// labels explain the blast radius. `write` marks scopes that can mutate state
// (inert while a token's read_only flag is on).
export type ScopeOption = {
  scope: string;
  label: string;
  write: boolean;
};

export const SCOPE_OPTIONS: ScopeOption[] = [
  { scope: "db:read", label: "Database — read (SELECT, introspection, types, advisors)", write: false },
  { scope: "db:write", label: "Database — write (DML via restricted role, no DDL)", write: true },
  { scope: "db:ddl", label: "Database — DDL (apply_migration, schema changes)", write: true },
  { scope: "functions:read", label: "Edge functions — read (config + code)", write: false },
  { scope: "functions:write", label: "Edge functions — deploy (code runs with full DB access)", write: true },
  { scope: "functions:invoke", label: "Edge functions — invoke (test calls)", write: true },
  { scope: "storage:read", label: "Storage — read (buckets + policies)", write: false },
  { scope: "storage:write", label: "Storage — write (bucket policies)", write: true },
  { scope: "cron:read", label: "Cron — read", write: false },
  { scope: "cron:write", label: "Cron — create/update jobs", write: true },
  { scope: "logs:read", label: "Logs — audit log + chain verification", write: false },
];
