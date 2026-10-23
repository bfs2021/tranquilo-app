// The image proxy's miss path, runtime-neutral: admission, fetch budgets,
// single-flight, origin fetch, transform, S3 write. Returns a plain result
// so a Lambda Function URL adapter or a test can drive it.
//
// The origin URL always comes from the item's row via lookupOriginUrl(),
// never from the caller. Blob storage is not handled here; S3 only.
import * as admission from "../../lib/img-admission.ts";
import * as guard from "../../lib/img-fetch-guard.ts";
import * as objectKeys from "../../lib/img-object-key.ts";
import * as s3 from "../../lib/img-s3.ts";
import * as store from "../../lib/img-store.ts";
import {
  CACHE_CONTROL_HEADER,
  canShedToOrigin,
  fetchOrigin,
  hostOf,
  isAllowedOrigin,
  isImgTier,
  lookupOriginUrl,
  ORIGIN_COOLDOWN_DEFAULT_SECONDS,
  transformForTier,
} from "../../lib/img-transform.ts";

// A degraded substitute must not outlive the condition that caused it.
const CACHE_CONTROL_DEGRADED = "public, max-age=120";

type Alert = (
  key: string,
  message: string,
  extra?: any,
) => Promise<void> | void;

type MissResult =
  | { kind: "redirect"; url: string; cacheControl: string; reason: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "error"; status: number; reason: string };

async function bestEffort(writes: Promise<unknown>[]): Promise<void> {
  try {
    await Promise.all(writes);
  } catch (_e) {
    // Bookkeeping must never change the answer.
  }
}

async function displayCdnUrl(
  sql: any,
  s3Config: any,
  source: string,
  id: string,
) {
  const entry = await store.touchAndResolve(sql, `${source}:${id}:display`);
  const resolved = store.resolveHit(entry, s3Config);
  return resolved.from === "cdn" ? resolved.url : null;
}

// Display sheds to its own small origin; lightbox falls back to the cached
// display image, never its multi-megabyte original.
async function shed(
  sql: any,
  s3Config: any,
  source: string,
  id: string,
  tier: string,
  originUrl: string,
  reason: string,
): Promise<MissResult> {
  const writes = [
    guard.bumpStat(sql, source, tier, "shed"),
    guard.bumpShedReason(sql, source, tier, reason),
  ];
  if (canShedToOrigin(tier as any)) {
    await bestEffort([
      ...writes,
      guard.bumpShedReason(sql, source, tier, "origin-handoff"),
    ]);
    return {
      kind: "redirect",
      url: originUrl,
      cacheControl: "no-store",
      reason,
    };
  }
  const fallback = await displayCdnUrl(sql, s3Config, source, id);
  await bestEffort(writes);
  if (fallback) {
    return {
      kind: "redirect",
      url: fallback,
      cacheControl: CACHE_CONTROL_DEGRADED,
      reason,
    };
  }
  return { kind: "unavailable", reason };
}

async function resolveMiss(
  sql: any,
  s3Config: any,
  params: { source: string; id: string; tier: string },
  alert: Alert,
): Promise<MissResult> {
  const { source, id, tier } = params;
  if (!isImgTier(tier)) {
    return { kind: "error", status: 400, reason: "bad-tier" };
  }

  const originUrl = await lookupOriginUrl(sql, source, id, tier);
  if (!originUrl) {
    return { kind: "error", status: 404, reason: "no-such-image" };
  }
  if (!isAllowedOrigin(source, tier, originUrl)) {
    return { kind: "error", status: 400, reason: "disallowed-origin" };
  }
  const host = hostOf(originUrl);
  const cacheKey = `${source}:${id}:${tier}`;

  await bestEffort([guard.bumpStat(sql, source, tier, "misses")]);

  const verdict = await admission.noteRequest(sql, cacheKey, source, tier, id);
  if (!verdict.admit) {
    return shed(
      sql,
      s3Config,
      source,
      id,
      tier,
      originUrl,
      `not-admitted-${verdict.requests}`,
    );
  }

  let budget = await guard.acquireFetchToken(sql, source);
  if (budget.allowed) {
    const hostBudget = await guard.acquireHostToken(sql, host, source);
    if (!hostBudget.allowed) {
      budget = {
        allowed: false,
        reason: hostBudget.reason,
        tokens: hostBudget.tokens,
      };
    }
  }
  if (!budget.allowed) {
    if (budget.reason === "unknown-source") {
      await alert(
        `unknown-source:${source}`,
        `no source_fetch_state row for '${source}' -- it can never be fetched ` +
          "server-side until one exists. See sql/010_img_fetch_state.sql.",
      );
    }
    return shed(sql, s3Config, source, id, tier, originUrl, budget.reason);
  }

  if (!(await guard.claimFetch(sql, cacheKey))) {
    return shed(sql, s3Config, source, id, tier, originUrl, "in-flight");
  }

  try {
    let origin: any;
    try {
      origin = await fetchOrigin(originUrl, source);
    } catch (fetchErr: any) {
      const status = fetchErr?.status;
      if (status === 429) {
        const cooldown = guard.parseRetryAfter(
          fetchErr.retryAfter,
          ORIGIN_COOLDOWN_DEFAULT_SECONDS,
        );
        await guard.blockHost(sql, host, cooldown, source);
        await guard.recordHostOutcome(sql, host, 429, false);
        await guard.recordOriginOutcome(sql, source, 429, false);
        await bestEffort([guard.bumpStat(sql, source, tier, "origin_429")]);
        await alert(
          `429:${host}`,
          `rate-limited (429) by ${host} -- pausing server-side fetches to that ` +
            `host for ${cooldown}s. Other hosts for this source are unaffected.`,
          { source, host, cooldown_seconds: cooldown },
        );
        return shed(sql, s3Config, source, id, tier, originUrl, "origin-429");
      }
      await guard.recordOriginOutcome(sql, source, status || 0, false);
      await bestEffort([guard.bumpStat(sql, source, tier, "origin_error")]);
      return shed(sql, s3Config, source, id, tier, originUrl, "origin-error");
    }
    await guard.recordOriginOutcome(sql, source, 200, true);
    await guard.recordHostOutcome(sql, host, 200, true);
    await bestEffort([guard.bumpStat(sql, source, tier, "origin_ok")]);

    const transformed = await transformForTier(
      origin.buf,
      origin.contentType,
      tier,
    );
    const hash = objectKeys.contentHash(transformed.buf);
    const objectKey = objectKeys.objectKeyFor(source, id, tier, hash);
    const put = await s3.putObject(
      s3Config,
      objectKey,
      transformed.buf,
      transformed.contentType,
    );
    if (!put.ok) {
      await alert(
        "s3-put-failed",
        "S3 put failed -- hotlinking to origin instead of caching this image. " +
          "Check the function role's bucket permissions.",
        { source, id, tier, status: put.status, key: objectKey },
      );
      return {
        kind: "redirect",
        url: originUrl,
        cacheControl: "no-store",
        reason: "s3-put-failed",
      };
    }
    // Only after a successful PUT: the hit path trusts a recorded key.
    await store.recordObject(
      sql,
      cacheKey,
      objectKey,
      hash,
      transformed.buf.length,
    );
    return {
      kind: "redirect",
      url: store.cdnUrlFor(s3Config.cdnBaseUrl, objectKey),
      cacheControl: CACHE_CONTROL_HEADER,
      reason: "written",
    };
  } finally {
    await guard.releaseFetch(sql, cacheKey);
  }
}

export { type Alert, CACHE_CONTROL_DEGRADED, type MissResult, resolveMiss };
