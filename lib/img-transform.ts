// Origin fetch and tier transform shared by the Vercel image proxy and
// the resize Lambda.
import sharp from "sharp";
import { LIVE_ITEMS_AND } from "./items-sql.ts";
import * as identity from "./source-identity.ts";

const TIERS = ["display", "lightbox"] as const;
type ImgTier = (typeof TIERS)[number];

function isImgTier(value: unknown): value is ImgTier {
  return value === "display" || value === "lightbox";
}

// The single most load-bearing rule in the caching design: which tiers
// may be shed to the source origin.
//   display   origin IS the web derivative (0.1-0.5MB) -- redirecting is
//             byte-identical to what we'd cache. Free to shed.
//   lightbox  origin is the ORIGINAL -- 20MB on Commons, 52.9MB for a
//             Cleveland TIFF. Redirecting hands the visitor ~100x more
//             data and makes the heaviest possible museum request. Never shed.
const SHEDDABLE_TO_ORIGIN: Record<ImgTier, boolean> = {
  display: true,
  lightbox: false,
};
function canShedToOrigin(tier: ImgTier): boolean {
  return SHEDDABLE_TO_ORIGIN[tier] === true;
}

// Backstop against a pathological origin response -- above the 52.9MB
// worst case actually fetched, so it protects the tier rather than
// breaking it. sharp has its own decode guard (limitInputPixels); this
// is the one on the step before that, which had none.
const MAX_ORIGIN_BYTES = 64 * 1024 * 1024;

// Generous vs. the client's own 8s -- this is the populate path, and
// Vercel Node functions default to a 300s timeout under Fluid Compute.
const ORIGIN_FETCH_TIMEOUT_MS = 20000;
// Was a 429-specific inline retry (up to 3x with backoff); removed
// because retrying sends MORE requests to a source that just asked us
// to stop -- the shape of the Wikimedia incident. The caller now parks
// the whole source for the Retry-After window instead (lib/img-fetch-guard.ts).
// Used when a 429 has no Retry-After header, or an unparseable one.
const ORIGIN_COOLDOWN_DEFAULT_SECONDS = 300;
const CACHE_CONTROL_HEADER = "public, max-age=31536000, immutable"; // images are effectively immutable once ingested/licensed
const LIGHTBOX_MAX_DIMENSION = 2200;
// 82 for WebP rather than JPEG's 85: WebP's quality curve differs, and
// 82 is the usual visual match for JPEG 85 at a smaller size.
const LIGHTBOX_WEBP_QUALITY = 82;
const DISPLAY_WEBP_QUALITY = 82;
// The display tier used to be re-encoded but never resized, so a large
// source derivative was stored at whatever size it arrived (15 objects
// over 1MB in production). 1600 is a judgement call against measured
// frames: comfortably above a 2x phone's need (780px), a mild upscale
// for a 2x laptop (2560px wanted), and clearly under the lightbox's
// 2200px so the lightbox stays worth opening. Applies to new writes
// only -- the cache key encodes neither format nor dimensions.
const DISPLAY_MAX_DIMENSION = 1600;

// Only fetch from known source CDNs, never a caller-supplied host --
// with one exception: Europeana aggregates rather than hosts, so its
// lightbox-tier full/full_img legitimately points at whichever
// contributing institution's own domain, different per item and
// impossible to enumerate. Its display tier still goes through
// Europeana's fixed thumbnail proxy and is allowlisted normally; its
// lightbox tier falls back to a scheme-only check (https, well-formed).
const ALLOWED_ORIGIN_HOSTS: Record<string, string[]> = {
  met: ["images.metmuseum.org"],
  smithsonian: ["ids.si.edu"],
  cleveland: ["openaccess-cdn.clevelandart.org"],
  // thumb.wikimedia.org serves Wikimedia's own rendered derivative for
  // anything not already a web-ready JPEG (e.g. TIFF scans).
  commons: ["upload.wikimedia.org", "thumb.wikimedia.org"],
  europeana: ["api.europeana.eu"],
  // npm.py's IIIF image service host, confirmed against real ingested
  // rows' img/full_img values -- this was missing entirely, so every
  // npm request 400'd here as "disallowed origin" before ever reaching
  // the S3 cache-hit lookup below, regardless of whether the object was
  // already cached.
  npm: ["iiifod.npm.gov.tw"],
  // wellcome.py's IIIF image service host -- confirmed against the
  // adapter's own map_item() (img/full both built from the work's
  // digital location's IIIF base url). Added ahead of the adapter's
  // first real ingestion run, not after, following the lesson recorded
  // above: this allowlist and ingest-time S3 caching are unrelated code
  // paths, so a source can cache cleanly at ingest time while every live
  // image request for it still 400s here until this entry exists.
  wellcome: ["iiif.wellcomecollection.org"],
  // nga.py's IIIF Image API host (api.nga.gov/iiif/{uuid}), the only
  // image host in NGA's published_images data. Added before the first
  // ingestion run for the same reason as wellcome above.
  nga: ["api.nga.gov"],
  // tepapa.py's media host, confirmed against real ingested rows (img and
  // full_img both). Missed at launch: the display tier was cached at
  // ingest, so only cache misses -- mostly the lightbox -- 400'd.
  tepapa: ["media.tepapa.govt.nz"],
  // tainacan.py reads each museum's own WordPress site, which serves its
  // own uploads; one host per instance in the adapter's INSTANCES. Added
  // before the first ingestion run, as with wellcome above.
  tainacan: [
    "acervo.margs.rs.gov.br",
    "museudoouro.acervos.museus.gov.br",
    "museuregionalcasadosottoni.acervos.museus.gov.br",
  ],
};

type ImgSource = keyof typeof ALLOWED_ORIGIN_HOSTS;
function isImgSource(value: unknown): value is ImgSource {
  return (
    typeof value === "string" && Object.hasOwn(ALLOWED_ORIGIN_HOSTS, value)
  );
}

function isAllowedOrigin(
  source: unknown,
  tier: ImgTier,
  originUrl: string,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(originUrl);
  } catch (_e) {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (source === "europeana" && tier === "lightbox") return true;
  if (!isImgSource(source)) return false;
  return ALLOWED_ORIGIN_HOSTS[source].indexOf(parsed.hostname) !== -1;
}

// The URL to fetch on a miss, read from the item's own row -- never from
// the request. `?origin=` used to be trusted here, which let anyone cache
// an image of their choosing under a real item's key. Same column choice
// as api/items.ts's imgProxyUrl() calls. null for an unknown or non-live
// item.
async function lookupOriginUrl(
  sql: any,
  source: any,
  id: any,
  tier: ImgTier,
): Promise<string | null> {
  if (!sql) return null;
  const rows = await sql.query(
    `SELECT img, full_img FROM items WHERE source = $1 AND native_id = $2 ${LIVE_ITEMS_AND} LIMIT 1`,
    [String(source), String(id)],
  );
  const row = rows[0];
  if (!row) return null;
  return (tier === "lightbox" ? row.full_img || row.img : row.img) || null;
}

// `status` left unset so the handler counts this as origin_error, not a
// misreported 429 -- nothing is wrong with the source, we're declining
// to hold what it offered.
function tooLargeError(bytes: any) {
  const err: any = new Error(
    `origin response exceeds ${MAX_ORIGIN_BYTES} bytes (${bytes})`,
  );
  err.tooLarge = true;
  return err;
}

async function fetchOriginOnce(url: any, source: any) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, ORIGIN_FETCH_TIMEOUT_MS);
  let r: any,
    err: any,
    declared: number,
    chunks: any[],
    total: number,
    buf: any,
    declaredContentType: any,
    typeErr: any,
    contentType: any;
  try {
    r = await fetch(url, {
      signal: controller.signal,
      headers: identity.imageFetchHeaders(source),
    });
    if (!r.ok) {
      err = new Error(`origin fetch failed with status ${r.status}`);
      err.status = r.status;
      err.retryAfter = r.headers.get("retry-after");
      throw err;
    }
    // Cheap rejection first, from the declared size.
    declared = Number(r.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_ORIGIN_BYTES) {
      throw tooLargeError(declared);
    }

    // The real check follows, streamed: content-length is a claim, not
    // the size, and some institutional servers omit it on chunked
    // responses. Reading in chunks lets an oversized body be abandoned
    // partway instead of fully materialised first.
    chunks = [];
    total = 0;
    for await (const chunk of r.body as any) {
      total += chunk.length;
      if (total > MAX_ORIGIN_BYTES) {
        controller.abort();
        throw tooLargeError(total);
      }
      chunks.push(chunk);
    }
    buf = Buffer.concat(chunks, total);
    declaredContentType = r.headers.get("content-type");
    // A 200 isn't proof of an image -- some institutional servers
    // (Nationalmuseum Sweden's eMuseumPlus, found live) answer a broken
    // asset request with 200 and an HTML error page as the body. Without
    // this, that HTML would sail through sharp's decode failure path and
    // get stored verbatim as if it were the image.
    if (declaredContentType && !/^image\//i.test(declaredContentType)) {
      typeErr = new Error(
        `origin returned a 200 with a non-image content-type (${declaredContentType})`,
      );
      typeErr.status = r.status;
      throw typeErr;
    }
    contentType = declaredContentType || "application/octet-stream";
    return { buf: buf, contentType: contentType };
  } finally {
    clearTimeout(timeout);
  }
}

function hostOf(url: any) {
  try {
    return new URL(url).host;
  } catch (_e) {
    return "unknown-host";
  }
}

// Single attempt -- see ORIGIN_COOLDOWN_DEFAULT_SECONDS above for why
// there's no retry loop.
async function fetchOrigin(url: any, source: any) {
  return await fetchOriginOnce(url, source);
}

async function transformForTier(buf: any, contentType: any, tier: any) {
  let webpBuf: any;
  if (tier === "display") {
    // Measured before building: 19 sampled display images re-encode at
    // WebP q82 for a 66.3% saving (56-75% per source), none got bigger.
    // Guarded anyway in case WebP ever loses to an already-optimised
    // source.
    try {
      webpBuf = await sharp(buf)
        .resize({
          width: DISPLAY_MAX_DIMENSION,
          height: DISPLAY_MAX_DIMENSION,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: DISPLAY_WEBP_QUALITY })
        .toBuffer();
      if (webpBuf.length < buf.length) {
        return { buf: webpBuf, contentType: "image/webp" };
      }
    } catch (_encodeErr) {
      // A source can serve something sharp can't decode (SVG, an exotic
      // TIFF) -- storing the original is correct, not a failure.
    }
    return { buf: buf, contentType: contentType };
  }

  if (tier === "lightbox") {
    // WebP rather than JPEG, ~30% smaller at equivalent quality; this
    // tier already goes through sharp so it's an encoder swap.
    return {
      buf: await sharp(buf)
        .resize({
          width: LIGHTBOX_MAX_DIMENSION,
          height: LIGHTBOX_MAX_DIMENSION,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: LIGHTBOX_WEBP_QUALITY })
        .toBuffer(),
      contentType: "image/webp",
    };
  }

  return { buf: buf, contentType: contentType };
}

export {
  ALLOWED_ORIGIN_HOSTS,
  CACHE_CONTROL_HEADER,
  canShedToOrigin,
  DISPLAY_MAX_DIMENSION,
  fetchOrigin,
  fetchOriginOnce,
  hostOf,
  type ImgTier,
  isAllowedOrigin,
  isImgTier,
  LIGHTBOX_MAX_DIMENSION,
  lookupOriginUrl,
  MAX_ORIGIN_BYTES,
  ORIGIN_COOLDOWN_DEFAULT_SECONDS,
  TIERS,
  transformForTier,
};
