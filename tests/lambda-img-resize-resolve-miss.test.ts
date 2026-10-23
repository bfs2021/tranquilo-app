// Orchestration only: the modules resolveMiss() calls have their own tests
// (img-admission, img-guard-atomicity, img-proxy, img-origin-lookup).
import { beforeEach, describe, expect, it, vi } from "vitest";

const noteRequest = vi.fn();
vi.mock("../lib/img-admission.ts", () => ({ noteRequest }));

const acquireFetchToken = vi.fn();
const acquireHostToken = vi.fn();
const claimFetch = vi.fn();
const releaseFetch = vi.fn();
const recordOriginOutcome = vi.fn();
const recordHostOutcome = vi.fn();
const blockHost = vi.fn();
const parseRetryAfter = vi.fn();
const bumpStat = vi.fn();
const bumpShedReason = vi.fn();
vi.mock("../lib/img-fetch-guard.ts", () => ({
  acquireFetchToken,
  acquireHostToken,
  claimFetch,
  releaseFetch,
  recordOriginOutcome,
  recordHostOutcome,
  blockHost,
  parseRetryAfter,
  bumpStat,
  bumpShedReason,
}));

const contentHash = vi.fn();
const objectKeyFor = vi.fn();
vi.mock("../lib/img-object-key.ts", () => ({ contentHash, objectKeyFor }));

const putObject = vi.fn();
vi.mock("../lib/img-s3.ts", () => ({ putObject }));

const touchAndResolve = vi.fn();
const resolveHit = vi.fn();
const recordObject = vi.fn();
const cdnUrlFor = vi.fn();
vi.mock("../lib/img-store.ts", () => ({
  touchAndResolve,
  resolveHit,
  recordObject,
  cdnUrlFor,
}));

const canShedToOrigin = vi.fn();
const fetchOrigin = vi.fn();
const isAllowedOrigin = vi.fn();
const lookupOriginUrl = vi.fn();
const transformForTier = vi.fn();
vi.mock("../lib/img-transform.ts", () => ({
  CACHE_CONTROL_HEADER: "public, max-age=31536000, immutable",
  ORIGIN_COOLDOWN_DEFAULT_SECONDS: 300,
  canShedToOrigin,
  fetchOrigin,
  hostOf: (url: string) => new URL(url).host,
  isAllowedOrigin,
  isImgTier: (t: unknown) => t === "display" || t === "lightbox",
  lookupOriginUrl,
  transformForTier,
}));

const { resolveMiss } = await import("../lambda/img-resize/resolve-miss.ts");

const sql = {} as any;
const s3Config = { cdnBaseUrl: "https://cdn.tranquilo.art" } as any;
const params = { source: "met", id: "1", tier: "display" };
const ORIGIN = "https://images.metmuseum.org/x.jpg";
const alert = vi.fn();

function admitAndAllow() {
  noteRequest.mockResolvedValue({ admit: true, requests: 2 });
  acquireFetchToken.mockResolvedValue({ allowed: true, tokens: 5 });
  acquireHostToken.mockResolvedValue({ allowed: true, tokens: 5 });
  claimFetch.mockResolvedValue(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  lookupOriginUrl.mockResolvedValue(ORIGIN);
  isAllowedOrigin.mockReturnValue(true);
  canShedToOrigin.mockReturnValue(true);
  touchAndResolve.mockResolvedValue(null);
  resolveHit.mockReturnValue({ from: "none" });
});

describe("already cached", () => {
  it("redirects to the stored copy without fetching or counting a miss", async () => {
    touchAndResolve.mockResolvedValue({ object_key: "k" });
    resolveHit.mockReturnValue({
      from: "cdn",
      url: "https://cdn.tranquilo.art/k",
    });
    const r = await resolveMiss(sql, s3Config, params, alert);
    expect(r).toEqual({
      kind: "redirect",
      url: "https://cdn.tranquilo.art/k",
      cacheControl: "public, max-age=31536000, immutable",
      reason: "hit",
    });
    expect(touchAndResolve).toHaveBeenCalledWith(sql, "met:1:display");
    expect(bumpStat).not.toHaveBeenCalledWith(sql, "met", "display", "misses");
    expect(noteRequest).not.toHaveBeenCalled();
    expect(fetchOrigin).not.toHaveBeenCalled();
  });
});

describe("request validation", () => {
  it("rejects an unknown tier before any lookup", async () => {
    const r = await resolveMiss(
      sql,
      s3Config,
      { ...params, tier: "huge" },
      alert,
    );
    expect(r).toMatchObject({ kind: "error", status: 400 });
    expect(lookupOriginUrl).not.toHaveBeenCalled();
  });
});

describe("origin comes from the item row, never the request", () => {
  it("looks the origin up by source, id and tier", async () => {
    noteRequest.mockResolvedValue({ admit: false, requests: 1 });
    await resolveMiss(sql, s3Config, params, alert);
    expect(lookupOriginUrl).toHaveBeenCalledWith(sql, "met", "1", "display");
    expect(isAllowedOrigin).toHaveBeenCalledWith("met", "display", ORIGIN);
  });

  it("404s an unknown or non-live item without touching admission", async () => {
    lookupOriginUrl.mockResolvedValue(null);
    const r = await resolveMiss(sql, s3Config, params, alert);
    expect(r).toMatchObject({ kind: "error", status: 404 });
    expect(noteRequest).not.toHaveBeenCalled();
  });

  it("400s when the stored origin is outside the allowlist", async () => {
    isAllowedOrigin.mockReturnValue(false);
    const r = await resolveMiss(sql, s3Config, params, alert);
    expect(r).toMatchObject({ kind: "error", status: 400 });
    expect(noteRequest).not.toHaveBeenCalled();
  });
});

describe("admission", () => {
  it("counts the miss, then sheds display to origin without fetching", async () => {
    noteRequest.mockResolvedValue({ admit: false, requests: 1 });
    const r = await resolveMiss(sql, s3Config, params, alert);
    expect(r).toEqual({
      kind: "redirect",
      url: ORIGIN,
      cacheControl: "no-store",
      reason: "not-admitted-1",
    });
    expect(bumpStat).toHaveBeenCalledWith(sql, "met", "display", "misses");
    expect(bumpStat).toHaveBeenCalledWith(sql, "met", "display", "shed");
    expect(bumpShedReason).toHaveBeenCalledWith(
      sql,
      "met",
      "display",
      "not-admitted-1",
    );
    expect(bumpShedReason).toHaveBeenCalledWith(
      sql,
      "met",
      "display",
      "origin-handoff",
    );
    expect(fetchOrigin).not.toHaveBeenCalled();
  });

  it("falls back to the cached display image for an unadmitted lightbox", async () => {
    canShedToOrigin.mockReturnValue(false);
    noteRequest.mockResolvedValue({ admit: false, requests: 1 });
    touchAndResolve.mockImplementation(async (_sql, key) =>
      key === "met:1:display" ? { object_key: "k" } : null,
    );
    resolveHit.mockImplementation((entry) =>
      entry
        ? { from: "cdn", url: "https://cdn.tranquilo.art/k" }
        : { from: "none" },
    );

    const r = await resolveMiss(
      sql,
      s3Config,
      { ...params, tier: "lightbox" },
      alert,
    );
    expect(r).toEqual({
      kind: "redirect",
      url: "https://cdn.tranquilo.art/k",
      cacheControl: "public, max-age=120",
      reason: "not-admitted-1",
    });
    expect(touchAndResolve).toHaveBeenCalledWith(sql, "met:1:display");
  });

  it("is unavailable when a lightbox has no display fallback", async () => {
    canShedToOrigin.mockReturnValue(false);
    noteRequest.mockResolvedValue({ admit: false, requests: 1 });
    touchAndResolve.mockResolvedValue(null);
    resolveHit.mockReturnValue({ from: "none" });

    const r = await resolveMiss(
      sql,
      s3Config,
      { ...params, tier: "lightbox" },
      alert,
    );
    expect(r).toEqual({ kind: "unavailable", reason: "not-admitted-1" });
  });

  it("still answers when shed bookkeeping fails", async () => {
    noteRequest.mockResolvedValue({ admit: false, requests: 1 });
    bumpShedReason.mockRejectedValueOnce(new Error("db down"));
    const r = await resolveMiss(sql, s3Config, params, alert);
    expect(r).toMatchObject({ kind: "redirect", url: ORIGIN });
  });
});

describe("budget", () => {
  beforeEach(() => {
    noteRequest.mockResolvedValue({ admit: true, requests: 2 });
  });

  it("sheds when the source budget denies, before asking the host", async () => {
    acquireFetchToken.mockResolvedValue({
      allowed: false,
      reason: "no-tokens",
    });
    const r = await resolveMiss(sql, s3Config, params, alert);
    expect(r).toMatchObject({ kind: "redirect", reason: "no-tokens" });
    expect(acquireHostToken).not.toHaveBeenCalled();
    expect(claimFetch).not.toHaveBeenCalled();
  });

  it("sheds when the host budget denies", async () => {
    acquireFetchToken.mockResolvedValue({ allowed: true, tokens: 5 });
    acquireHostToken.mockResolvedValue({
      allowed: false,
      reason: "host-no-tokens",
    });
    const r = await resolveMiss(sql, s3Config, params, alert);
    expect(acquireHostToken).toHaveBeenCalledWith(
      sql,
      "images.metmuseum.org",
      "met",
    );
    expect(r).toMatchObject({ kind: "redirect", reason: "host-no-tokens" });
    expect(claimFetch).not.toHaveBeenCalled();
  });

  it("alerts when a source has no fetch-state row", async () => {
    acquireFetchToken.mockResolvedValue({
      allowed: false,
      reason: "unknown-source",
    });
    await resolveMiss(sql, s3Config, params, alert);
    expect(alert).toHaveBeenCalledWith(
      "unknown-source:met",
      expect.any(String),
    );
  });
});

describe("single-flight", () => {
  it("sheds without fetching when another caller holds the claim", async () => {
    admitAndAllow();
    claimFetch.mockResolvedValue(false);
    const r = await resolveMiss(sql, s3Config, params, alert);
    expect(r).toMatchObject({ kind: "redirect", reason: "in-flight" });
    expect(fetchOrigin).not.toHaveBeenCalled();
  });
});

describe("origin fetch failure", () => {
  beforeEach(admitAndAllow);

  it("parks the host, alerts, and sheds on a 429 with no second attempt", async () => {
    const err: any = new Error("rate limited");
    err.status = 429;
    err.retryAfter = "120";
    fetchOrigin.mockRejectedValue(err);
    parseRetryAfter.mockReturnValue(120);

    const r = await resolveMiss(sql, s3Config, params, alert);
    expect(r).toMatchObject({ kind: "redirect", reason: "origin-429" });
    expect(parseRetryAfter).toHaveBeenCalledWith("120", 300);
    expect(releaseFetch).toHaveBeenCalledWith(sql, "met:1:display");
    expect(blockHost).toHaveBeenCalledWith(
      sql,
      "images.metmuseum.org",
      120,
      "met",
    );
    expect(bumpStat).toHaveBeenCalledWith(sql, "met", "display", "origin_429");
    expect(alert).toHaveBeenCalledWith(
      "429:images.metmuseum.org",
      expect.any(String),
      expect.objectContaining({ cooldown_seconds: 120 }),
    );
    expect(fetchOrigin).toHaveBeenCalledTimes(1);
  });

  it("sheds on any other origin error without parking the host", async () => {
    const err: any = new Error("boom");
    err.status = 500;
    fetchOrigin.mockRejectedValue(err);

    const r = await resolveMiss(sql, s3Config, params, alert);
    expect(r).toMatchObject({ kind: "redirect", reason: "origin-error" });
    expect(blockHost).not.toHaveBeenCalled();
    expect(recordOriginOutcome).toHaveBeenCalledWith(sql, "met", 500, false);
    expect(bumpStat).toHaveBeenCalledWith(
      sql,
      "met",
      "display",
      "origin_error",
    );
  });
});

describe("fetch, transform, write", () => {
  beforeEach(() => {
    admitAndAllow();
    fetchOrigin.mockResolvedValue({
      buf: Buffer.from("origin-bytes"),
      contentType: "image/jpeg",
    });
    transformForTier.mockResolvedValue({
      buf: Buffer.from("webp-bytes"),
      contentType: "image/webp",
    });
    contentHash.mockReturnValue("abc123");
    objectKeyFor.mockReturnValue("img-cache/met/1/display/abc123");
    cdnUrlFor.mockReturnValue(
      "https://cdn.tranquilo.art/img-cache/met/1/display/abc123",
    );
  });

  it("writes to S3, records the key, and redirects to the CDN", async () => {
    putObject.mockResolvedValue({ ok: true, status: 200 });

    const r = await resolveMiss(sql, s3Config, params, alert);
    expect(r).toEqual({
      kind: "redirect",
      url: "https://cdn.tranquilo.art/img-cache/met/1/display/abc123",
      cacheControl: "public, max-age=31536000, immutable",
      reason: "written",
    });
    expect(fetchOrigin).toHaveBeenCalledWith(ORIGIN, "met");
    expect(bumpStat).toHaveBeenCalledWith(sql, "met", "display", "origin_ok");
    expect(recordObject).toHaveBeenCalledWith(
      sql,
      "met:1:display",
      "img-cache/met/1/display/abc123",
      "abc123",
      10,
    );
    expect(releaseFetch).toHaveBeenCalledWith(sql, "met:1:display");
  });

  it("records the key only after the PUT succeeds", async () => {
    const order: string[] = [];
    putObject.mockImplementation(async () => {
      order.push("put");
      return { ok: true, status: 200 };
    });
    recordObject.mockImplementation(async () => {
      order.push("record");
      return true;
    });
    await resolveMiss(sql, s3Config, params, alert);
    expect(order).toEqual(["put", "record"]);
  });

  it("hotlinks the origin and alerts when the S3 write fails", async () => {
    putObject.mockResolvedValue({ ok: false, status: 403 });

    const r = await resolveMiss(sql, s3Config, params, alert);
    expect(r).toEqual({
      kind: "redirect",
      url: ORIGIN,
      cacheControl: "no-store",
      reason: "s3-put-failed",
    });
    expect(recordObject).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith(
      "s3-put-failed",
      expect.any(String),
      expect.objectContaining({ status: 403 }),
    );
    expect(releaseFetch).toHaveBeenCalledWith(sql, "met:1:display");
  });

  it("releases the claim when the transform throws", async () => {
    transformForTier.mockRejectedValue(new Error("bad image"));
    await expect(resolveMiss(sql, s3Config, params, alert)).rejects.toThrow(
      "bad image",
    );
    expect(releaseFetch).toHaveBeenCalledWith(sql, "met:1:display");
  });
});
