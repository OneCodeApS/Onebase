import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  // node-cron (CommonJS) loads its background daemon via a server-relative
  // import that Turbopack can't resolve when it bundles/externalizes the
  // package — the instrumentation hook then throws on every server compile,
  // which spins up postcss worker subprocesses that are never reaped (they
  // pile into multiple GB of orphaned node.exe). Keeping node-cron as a true
  // runtime external (required by Node, not bundled) sidesteps the resolution
  // bug. See vercel/next.js#68101. `pg` is listed too so its optional `fs`
  // require (for SSL cert files) resolves natively in the Node server build
  // instead of webpack trying to bundle a Node built-in.
  serverExternalPackages: ["node-cron", "pg"],
  // instrumentation.ts boots the cron scheduler + audit-retention sweeper.
  // Their subtree (lib/cron → node-cron; lib/audit-retention → lib/db → pg,
  // lib/audit → node:crypto, lib/settings, …) is node-only. Because
  // middleware.ts exists, Next also compiles instrumentation for the edge
  // runtime, which can't resolve Node built-ins ("Can't resolve 'fs'",
  // "node:crypto Unhandled scheme"). serverExternalPackages only covers the
  // Node server build. register() guards all of this on
  // NEXT_RUNTIME === "nodejs", so it's dead code in every other runtime —
  // instrumentation imports exactly these two modules, so ignoring them at the
  // root drops the whole node-only graph from the non-Node compilations.
  // webpack-only, which is what we run (next dev/build --webpack).
  webpack: (cfg, { nextRuntime, webpack }) => {
    if (nextRuntime !== "nodejs") {
      cfg.plugins.push(
        new webpack.IgnorePlugin({
          resourceRegExp: /^\.\/lib\/(cron|audit-retention)$/,
        }),
      );
    }
    return cfg;
  },
  experimental: {
    // Server actions are first-party in Next 15; we only call them same-origin
    // via Caddy, so the host header will match.
    serverActions: {
      // Hard ceiling on form submissions; the storage upload action enforces
      // its own per-bucket cap on top of this. Numbers like "100mb" use Next's
      // bytes-style parser. Bump if you need larger uploads.
      bodySizeLimit: "100mb",
    },
  },
};

export default config;
