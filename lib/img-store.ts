// Where a cache hit redirects to, and whether S3 is on. Lives outside /api/
// for the usual 12-function-cap reason. Holds the pure-decision parts of the
// S3 migration, separated from the parts that talk to S3, so the hot read
// path stays testable without a network, bucket, or signing implementation.
//
// The read path gets FASTER with S3, the opposite of the usual direction:
// object_key is written only after a successful PUT and objects are
// immutable, so nothing ever deletes an object out from under a recorded
// key -- the Blob head() check becomes unnecessary and the hit path is just
// "read a row we were already reading, then 302". Revisit if deletion is
// ever reintroduced.

// Duplicated from lib/img-object-key.ts rather than imported: this module's
// job is to REJECT a base URL that already ends in this prefix, and a guard
// that imports its expectation from the thing it guards isn't much of one.
const OBJECT_PREFIX = "img-cache";

// The double-prefix guard is the point: object keys already begin with
// "img-cache/", so a base URL ending in the same segment would 404 silently
// (presenting as "images fall back to origin", not an error) -- caught here
// loudly instead, at URL-build time.
function cdnUrlFor(baseUrl: any, objectKey: any): string {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) {
    throw new Error(
      `IMG_CDN_BASE_URL must be absolute (https://...), got: ${baseUrl}`,
    );
  }
  if (new RegExp(`/${OBJECT_PREFIX}$`).test(base)) {
    throw new Error(
      `IMG_CDN_BASE_URL already ends in /${OBJECT_PREFIX} -- object keys ` +
        `start with that prefix, so this would produce ${OBJECT_PREFIX}/${
          OBJECT_PREFIX
        }/... and 404. Use the bare distribution URL.`,
    );
  }
  return `${base}/${String(objectKey).replace(/^\/+/, "")}`;
}

// Returns { from: "cdn", url } or { from: "blob" } -- the caller keeps its
// existing Blob logic for the latter, so every row written before the
// migration (object_key NULL) behaves exactly as it did before.
function resolveHit(entry: any, config: any): any {
  const key = entry?.object_key;
  const base = config?.cdnBaseUrl;
  if (!key || !base) return { from: "blob" };
  return { from: "cdn", url: cdnUrlFor(base, key) };
}

// Read the environment once, and refuse to be half-on: credentials without a
// CDN writes objects nothing can serve, a CDN without credentials redirects
// to objects never written -- both worse than staying off, since the Blob
// path underneath already works.
//
// The secret is deliberately not stored on the returned object (config
// objects end up in logs and Sentry breadcrumbs); `secret()` hands it over
// only to a caller that explicitly asks.
function configFromEnv(env?: any): any {
  const e = env || process.env;
  const bucket = e.S3_BUCKET || "";
  const region = e.S3_REGION || "";
  const keyId = e.S3_ACCESS_KEY_ID || "";
  const secretValue = e.S3_SECRET_ACCESS_KEY || "";
  const sessionTokenValue = e.S3_SESSION_TOKEN || "";
  const cdnBaseUrl = String(e.IMG_CDN_BASE_URL || "").replace(/\/+$/, "");

  const enabled = !!(bucket && region && keyId && secretValue && cdnBaseUrl);

  const config: any = {
    bucket: bucket,
    region: region,
    accessKeyId: keyId,
    cdnBaseUrl: cdnBaseUrl,
    enabled: enabled,
  };
  // Non-enumerable, so JSON.stringify() and console.log() cannot reach it.
  Object.defineProperty(config, "secret", {
    enumerable: false,
    value: () => secretValue,
  });
  Object.defineProperty(config, "sessionToken", {
    enumerable: false,
    value: () => sessionTokenValue,
  });
  return config;
}

// Resolves the object key and stamps recency in ONE statement -- one round
// trip instead of two, and critically zero Blob operations, the metered
// resource this migration exists to reduce. Doesn't violate the "respond
// first" rule used elsewhere in this file: this read IS the response.
function touchAndResolveSql(): string {
  return (
    "UPDATE img_cache_entries " +
    "SET last_seen = now(), requests = requests + 1 " +
    "WHERE cache_key = $1 " +
    "RETURNING object_key, content_hash"
  );
}

async function touchAndResolve(sql: any, cacheKey: any): Promise<any> {
  if (!sql) return null;
  try {
    const rows = await sql.query(touchAndResolveSql(), [cacheKey]);
    return rows?.[0] || null;
  } catch (_err) {
    // A bookkeeping failure must never fail an image. Returning null falls the
    // caller back to the Blob path, which is what it did before any of this.
    return null;
  }
}

// Called only after a successful PUT -- that ordering is what makes the key
// trustworthy enough to skip the existence check above. object_written_at is
// distinct from admitted_at (first allowed to be stored vs. when the current
// bytes landed) so "stored long ago" and "rewritten yesterday" stay tellable
// apart.
function recordObjectSql(): string {
  return (
    "UPDATE img_cache_entries " +
    "SET object_key = $2, content_hash = $3, bytes = $4, " +
    "    object_written_at = now(), " +
    "    admitted_at = COALESCE(admitted_at, now()) " +
    "WHERE cache_key = $1"
  );
}

async function recordObject(
  sql: any,
  cacheKey: any,
  objectKey: any,
  contentHash: any,
  bytes: any,
): Promise<boolean> {
  if (!sql) return false;
  try {
    await sql.query(recordObjectSql(), [
      cacheKey,
      objectKey,
      contentHash,
      bytes,
    ]);
    return true;
  } catch (_err) {
    // The object IS in S3; only our note failed. The next request finds no
    // key, falls back, and rewrites -- wasteful but correct.
    return false;
  }
}

export {
  cdnUrlFor,
  configFromEnv,
  OBJECT_PREFIX,
  recordObject,
  recordObjectSql,
  resolveHit,
  touchAndResolve,
  touchAndResolveSql,
};
