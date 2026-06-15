// Ready-to-paste client snippets against this instance's real API URL.
// Onebase has no client SDK yet — clients talk plain fetch/EventSource — so
// correct snippets are the fastest way for an agent to wire up a customer app.

export const SNIPPET_SURFACES = [
  "auth-signin",
  "auth-signup",
  "auth-refresh",
  "rest-select",
  "rest-insert",
  "rest-update",
  "storage-upload",
  "storage-download",
  "realtime-subscribe",
  "function-invoke",
] as const;

export type SnippetSurface = (typeof SNIPPET_SURFACES)[number];

export function isSnippetSurface(s: string): s is SnippetSurface {
  return (SNIPPET_SURFACES as readonly string[]).includes(s);
}

export function apiBaseUrl(): string {
  return (process.env.API_PUBLIC_URL ?? "https://api.example.com").replace(/\/+$/, "");
}

export function generateSnippet(surface: SnippetSurface): string {
  const api = apiBaseUrl();
  switch (surface) {
    case "auth-signin":
      return `// Sign an end user in. Returns a 1-hour access JWT + 30-day refresh token.
const res = await fetch("${api}/auth/v1/signin", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
if (!res.ok) throw new Error(\`signin failed: \${res.status}\`);
const { access_token, refresh_token, user } = await res.json();`;

    case "auth-signup":
      return `// Create an end-user account (if signups are enabled in Auth providers).
const res = await fetch("${api}/auth/v1/signup", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password, metadata: { display_name: "…" } }),
});
const { access_token, refresh_token, user } = await res.json();`;

    case "auth-refresh":
      return `// Exchange a refresh token for a fresh access + refresh pair.
// Do this when a request comes back 401 with an expired JWT.
const res = await fetch("${api}/auth/v1/refresh", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ refresh_token }),
});
const { access_token, refresh_token: next_refresh } = await res.json();`;

    case "rest-select":
      return `// Read rows via PostgREST. Filtering, ordering, and pagination use
// PostgREST query syntax. RLS applies based on the JWT's role/claims.
const res = await fetch(
  "${api}/rest/v1/todos?select=*&order=created_at.desc&limit=20",
  { headers: { Authorization: \`Bearer \${access_token}\` } },
);
const rows = await res.json();`;

    case "rest-insert":
      return `// Insert a row. Prefer: return=representation echoes the created row back.
const res = await fetch("${api}/rest/v1/todos", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${access_token}\`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  },
  body: JSON.stringify({ title: "Buy milk" }),
});
const [created] = await res.json();`;

    case "rest-update":
      return `// Update rows matching a filter. ALWAYS filter — an unfiltered PATCH
// updates every row RLS lets the caller see.
const res = await fetch("${api}/rest/v1/todos?id=eq.\${id}", {
  method: "PATCH",
  headers: {
    Authorization: \`Bearer \${access_token}\`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  },
  body: JSON.stringify({ done: true }),
});`;

    case "storage-upload":
      return `// Two-step upload: ask the API for a short-lived signed PUT URL, then PUT
// the bytes straight to storage (the byte stream never passes through Node).
const sign = await fetch("${api}/storage/v1/object/upload/my-bucket/path/file.png", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${access_token}\`, // service_role for private buckets
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ content_type: file.type }),
});
const { url } = await sign.json();
await fetch(url, { method: "PUT", body: file, headers: { "Content-Type": file.type } });`;

    case "storage-download":
      return `// Public buckets: plain GET, no auth.
const publicUrl = "${api}/storage/v1/object/my-public-bucket/path/file.png";

// Private buckets: request a signed GET URL first.
const sign = await fetch("${api}/storage/v1/object/sign/my-bucket/path/file.png", {
  method: "POST",
  headers: { Authorization: \`Bearer \${access_token}\` },
});
const { url } = await sign.json();
const blob = await (await fetch(url)).blob();`;

    case "realtime-subscribe":
      return `// Server-Sent Events stream of INSERT/UPDATE/DELETE on a table.
// The table must be enabled under Admin → Schema → Realtime.
const es = new EventSource(
  "${api}/realtime?schema=public&table=todos&token=" + access_token,
);
es.addEventListener("message", (e) => {
  const change = JSON.parse(e.data); // { type, schema, table, old, new, ts }
});
es.addEventListener("error", () => {
  // EventSource auto-reconnects; refresh the token if the stream 401s.
});`;

    case "function-invoke":
      return `// Invoke an edge function. Which token you need depends on the function's
// min_role: anon key, a signed-in user's JWT, or service_role.
const res = await fetch("${api}/functions/v1/my-function", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${access_token}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ hello: "world" }),
});
const data = await res.json();`;
  }
}
