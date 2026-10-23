// The S3 migration: where does a cache hit redirect to? This file pins
// the read decision, pure logic worth separating from the SigV4/SDK
// question. The S3 path needs no existence check at all: with object_key
// recorded only after a successful PUT and never deleted, the database is
// authoritative, so the fast path gets faster rather than slower.
import { describe, expect, it } from "vitest";
import * as store from "../lib/img-store.ts";

const CDN = "https://d111111abcdef8.cloudfront.net";
const KEY = "img-cache/met/436535-1f0a3c9d/display/2ac8844e678589a8";

describe("cdnUrlFor", () => {
  it("joins the base and the key with exactly one slash", () => {
    expect(store.cdnUrlFor(CDN, KEY)).toBe(`${CDN}/${KEY}`);
  });

  it("tolerates a trailing slash on the base", () => {
    expect(store.cdnUrlFor(`${CDN}/`, KEY)).toBe(`${CDN}/${KEY}`);
  });

  it("refuses a base that already ends in the object prefix", () => {
    // The object key already starts with "img-cache/", so a base URL
    // ending in it would produce .../img-cache/img-cache/met/... -- a 404
    // invisible until a real visitor loads a real image.
    expect(() => store.cdnUrlFor(`${CDN}/img-cache`, KEY)).toThrow(
      /already ends in .*img-cache/i,
    );
    expect(() => store.cdnUrlFor(`${CDN}/img-cache/`, KEY)).toThrow(
      /already ends in .*img-cache/i,
    );
  });

  it("refuses a base that is not absolute", () => {
    // A relative base would loop the Location header back through the
    // proxy rather than reaching the CDN.
    expect(() => store.cdnUrlFor("d111111abcdef8.cloudfront.net", KEY)).toThrow(
      /absolute/i,
    );
  });
});

describe("resolveHit", () => {
  const cfg = { cdnBaseUrl: CDN };

  it("serves from the CDN when the entry has an object key", () => {
    const out = store.resolveHit({ object_key: KEY }, cfg);
    expect(out).toEqual({ from: "cdn", url: `${CDN}/${KEY}` });
  });

  it("falls back to Blob when the entry has no object key", () => {
    // NULL means "Blob-only" -- every row written before the migration.
    expect(store.resolveHit({ object_key: null }, cfg)).toEqual({
      from: "blob",
    });
    expect(store.resolveHit({}, cfg)).toEqual({ from: "blob" });
    expect(store.resolveHit(null, cfg)).toEqual({ from: "blob" });
  });

  it("falls back to Blob when the CDN is not configured yet", () => {
    // A missing base URL must degrade to current behaviour, not throw --
    // an unconfigured CDN should look like "S3 is not on yet", not an outage.
    expect(store.resolveHit({ object_key: KEY }, { cdnBaseUrl: "" })).toEqual({
      from: "blob",
    });
    expect(store.resolveHit({ object_key: KEY }, {})).toEqual({ from: "blob" });
  });

  it("does not treat an empty-string key as a key", () => {
    expect(store.resolveHit({ object_key: "" }, cfg)).toEqual({ from: "blob" });
  });
});

describe("configFromEnv", () => {
  it("reads the documented variable names", () => {
    const cfg = store.configFromEnv({
      S3_BUCKET: "cora-tranquilo-img",
      S3_REGION: "us-east-1",
      S3_ACCESS_KEY_ID: "AKIA...",
      S3_SECRET_ACCESS_KEY: "shh",
      IMG_CDN_BASE_URL: CDN,
    });
    expect(cfg.bucket).toBe("cora-tranquilo-img");
    expect(cfg.region).toBe("us-east-1");
    expect(cfg.cdnBaseUrl).toBe(CDN);
    expect(cfg.enabled).toBe(true);
  });

  it("is disabled unless every piece is present", () => {
    // Partial configuration half-works either way: writing to S3 without
    // a CDN to serve from, or a CDN with no write credentials.
    const full = {
      S3_BUCKET: "b",
      S3_REGION: "r",
      S3_ACCESS_KEY_ID: "k",
      S3_SECRET_ACCESS_KEY: "s",
      IMG_CDN_BASE_URL: CDN,
    };
    for (const missing of Object.keys(full)) {
      const partial: any = Object.assign({}, full);
      delete partial[missing];
      expect(store.configFromEnv(partial).enabled, `missing ${missing}`).toBe(
        false,
      );
    }
  });

  it("carries an optional session token without exposing it", () => {
    const env = {
      S3_BUCKET: "b",
      S3_REGION: "r",
      S3_ACCESS_KEY_ID: "ASIA...",
      S3_SECRET_ACCESS_KEY: "s",
      IMG_CDN_BASE_URL: CDN,
    };
    expect(store.configFromEnv(env).sessionToken()).toBe("");
    const cfg = store.configFromEnv({ ...env, S3_SESSION_TOKEN: "TOKENVALUE" });
    expect(cfg.enabled).toBe(true);
    expect(cfg.sessionToken()).toBe("TOKENVALUE");
    expect(JSON.stringify(cfg)).not.toContain("TOKENVALUE");
  });

  it("never puts the secret anywhere it could be logged", () => {
    const cfg = store.configFromEnv({
      S3_BUCKET: "b",
      S3_REGION: "r",
      S3_ACCESS_KEY_ID: "k",
      S3_SECRET_ACCESS_KEY: "SUPERSECRET",
      IMG_CDN_BASE_URL: CDN,
    });
    // The whole config object gets stringified into error paths and
    // Sentry breadcrumbs sooner or later.
    expect(JSON.stringify(cfg)).not.toContain("SUPERSECRET");
  });
});
