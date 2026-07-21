import { Client } from "minio";

declare global {
  // eslint-disable-next-line no-var
  var __minioClient: Client | undefined;
  // eslint-disable-next-line no-var
  var __minioPublicClient: Client | undefined;
}

function buildClient(): Client {
  const endPoint = process.env.MINIO_ENDPOINT;
  const accessKey = process.env.MINIO_ACCESS_KEY;
  const secretKey = process.env.MINIO_SECRET_KEY;
  if (!endPoint || !accessKey || !secretKey) {
    throw new Error("MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY must be set");
  }
  return new Client({
    endPoint,
    port: Number(process.env.MINIO_PORT ?? 9000),
    useSSL: process.env.MINIO_USE_SSL === "true",
    accessKey,
    secretKey,
    // Pin the region so minio-js signs locally instead of resolving it on demand
    // via a `GET /<bucket>?location` request. Matches MinIO's default when
    // MINIO_SITE_REGION is unset; set MINIO_REGION here if you run a custom one.
    region: process.env.MINIO_REGION ?? "us-east-1",
  });
}

function resolveInternal(): Client {
  if (!globalThis.__minioClient) {
    globalThis.__minioClient = buildClient();
  }
  return globalThis.__minioClient;
}

// Internal client — used by the dashboard process to perform bucket / object
// operations. In Docker this connects to `minio:9000` over the bridge network.
//
// Wrapped in a Proxy so the underlying Client is constructed on first method
// access, not at module load. Required because `next build` evaluates this
// module while collecting page data — env vars aren't available at that point
// and the old eager construction crashed the build.
export const minio: Client = new Proxy({} as Client, {
  get(_t, prop, receiver) {
    const target = resolveInternal();
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

// Public-signing client — same MinIO credentials, but configured against the
// PUBLIC api hostname so SigV4 is computed for the host the browser will hit.
// Built from API_PUBLIC_URL. The URL the SDK produces is path-style and does
// NOT include /storage/v1/object — callers insert that prefix via
// publicSignedObjectUrl() / publicObjectUrl() below. Caddy strips the prefix
// before forwarding to MinIO, so the signed path matches what MinIO verifies.
function buildPublicClient(): Client | null {
  const publicUrl = process.env.API_PUBLIC_URL;
  const accessKey = process.env.MINIO_ACCESS_KEY;
  const secretKey = process.env.MINIO_SECRET_KEY;
  if (!publicUrl || !accessKey || !secretKey) return null;
  try {
    const u = new URL(publicUrl);
    return new Client({
      endPoint: u.hostname,
      port: u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80,
      useSSL: u.protocol === "https:",
      accessKey,
      secretKey,
      // Pin the region: without it minio-js does a `GET /<bucket>?location`
      // lookup against this endpoint (the PUBLIC api host), where that path
      // isn't routed to MinIO — Caddy 404s it and presigning throws "Not Found".
      region: process.env.MINIO_REGION ?? "us-east-1",
    });
  } catch {
    return null;
  }
}

function resolvePublic(): Client {
  if (!globalThis.__minioPublicClient) {
    globalThis.__minioPublicClient = buildPublicClient() ?? resolveInternal();
  }
  return globalThis.__minioPublicClient;
}

export const minioPublic: Client = new Proxy({} as Client, {
  get(_t, prop, receiver) {
    const target = resolvePublic();
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

// Returns a SigV4-signed URL for `method bucket/key` against the public api
// host, with /storage/v1/object/ inserted into the path. Caddy strips that
// prefix before forwarding to MinIO; what MinIO verifies is the URL the SDK
// originally signed, so the signature matches.
export async function publicSignedObjectUrl(
  method: "GET" | "PUT",
  bucket: string,
  key: string,
  expiresInSeconds: number,
): Promise<string> {
  const raw =
    method === "GET"
      ? await minioPublic.presignedGetObject(bucket, key, expiresInSeconds)
      : await minioPublic.presignedPutObject(bucket, key, expiresInSeconds);
  return injectStoragePrefix(raw);
}

// For public buckets: MinIO's anonymous-read ACL is set on the bucket, so no
// SigV4 is needed. The URL is the same shape minus the query string.
export function publicObjectUrl(bucket: string, key: string): string {
  const base = (process.env.API_PUBLIC_URL ?? "").replace(/\/+$/, "");
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${base}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedKey}`;
}

function injectStoragePrefix(presignedUrl: string): string {
  const u = new URL(presignedUrl);
  u.pathname = `/storage/v1/object${u.pathname}`;
  return u.toString();
}
