// The SigV4 signer, validated against the real bucket before these tests
// existed (a hand-signed PUT returned 200, one outside the permitted prefix
// 403'd with the IAM policy's own explanation). No golden signature value
// is asserted -- inventing one from this same implementation tests
// nothing, and AWS's published vectors cover generic SigV4, not S3's
// specific canonicalisation. What's pinned instead: determinism, what's
// included in the signature, and the URL shape.
import { describe, expect, it } from "vitest";
import * as s3 from "../lib/img-s3.ts";

const BASE = {
  method: "PUT",
  host: "s3.us-east-1.amazonaws.com",
  canonicalUri: "/cdn.tranquilo.art/img-cache/met/436535/display/abc123",
  payloadHash:
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  contentType: "image/png",
  amzDate: "20260823T120000Z",
  region: "us-east-1",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

describe("signRequest", () => {
  it("is deterministic for identical inputs", () => {
    expect(s3.signRequest(BASE).signature).toBe(s3.signRequest(BASE).signature);
  });

  it("changes when any signed input changes", () => {
    const base = s3.signRequest(BASE).signature;
    const vary = {
      canonicalUri: "/cdn.tranquilo.art/img-cache/met/436535/display/DIFFERENT",
      payloadHash: "0".repeat(64),
      contentType: "image/jpeg",
      amzDate: "20260823T120001Z",
      region: "eu-west-1",
      secretAccessKey: "another-secret",
    };
    for (const [field, value] of Object.entries(vary)) {
      const changed = s3.signRequest(
        Object.assign({}, BASE, { [field]: value }),
      );
      expect(
        changed.signature,
        `${field} did not affect the signature`,
      ).not.toBe(base);
    }
  });

  it("signs content-type, because it is sent", () => {
    // An unsigned header that IS present is a signature mismatch, not a
    // warning -- the easiest way to break a working signer.
    expect(s3.signRequest(BASE).signedHeaders).toBe(
      "content-type;host;x-amz-content-sha256;x-amz-date",
    );
  });

  it("omits content-type from signed headers when none is sent -- GET has no body, no content-type header", () => {
    const noType = Object.assign({}, BASE, { contentType: undefined });
    expect(s3.signRequest(noType).signedHeaders).toBe(
      "host;x-amz-content-sha256;x-amz-date",
    );
  });

  it("never puts the secret in the Authorization header", () => {
    const auth = s3.signRequest(BASE).authorization;
    expect(auth).not.toContain(BASE.secretAccessKey);
    expect(auth).toContain(BASE.accessKeyId); // the ACCESS KEY id is public
    expect(auth).toMatch(
      /^AWS4-HMAC-SHA256 Credential=.+, SignedHeaders=.+, Signature=[0-9a-f]{64}$/,
    );
  });

  it("signs the session token when temporary role credentials supply one", () => {
    const withToken = Object.assign({}, BASE, {
      sessionToken: "IQoJb3JpZ2luX2VjEXAMPLE",
    });
    expect(s3.signRequest(withToken).signedHeaders).toBe(
      "content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token",
    );
    expect(s3.signRequest(withToken).signature).not.toBe(
      s3.signRequest(BASE).signature,
    );
  });

  it("scopes the credential to date, region and service", () => {
    expect(s3.signRequest(BASE).authorization).toContain(
      "Credential=AKIAEXAMPLE/20260823/us-east-1/s3/aws4_request",
    );
  });
});

describe("canonicalUriFor", () => {
  it("keeps separators literal and encodes the segments", () => {
    expect(
      s3.canonicalUriFor("bucket", "img-cache/met/436535/display/abc"),
    ).toBe("/bucket/img-cache/met/436535/display/abc");
  });

  it("encodes characters that appear in real ids", () => {
    const uri = s3.canonicalUriFor(
      "b",
      "img-cache/commons/File-A-Colorful.jpg/display/h",
    );
    expect(uri.includes(" ")).toBe(false);
    expect(uri.startsWith("/b/img-cache/")).toBe(true);
  });

  it("puts the BUCKET in the path -- path-style, not virtual-hosted", () => {
    // The bucket name contains dots, so virtual-hosted-style over HTTPS
    // would have more labels than AWS's wildcard cert can match -- confirmed
    // live, curl fails with a certificate subject mismatch.
    expect(s3.canonicalUriFor("cdn.tranquilo.art", "img-cache/x")).toBe(
      "/cdn.tranquilo.art/img-cache/x",
    );
  });
});

describe("putObject", () => {
  const config = {
    bucket: "cdn.tranquilo.art",
    region: "us-east-1",
    accessKeyId: "AKIAEXAMPLE",
    secret: () => "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  };

  it("addresses the path-style endpoint and sends the signed headers", async () => {
    let seen: any = null;
    await s3.putObject(
      config,
      "img-cache/a/b/display/h",
      Buffer.from("x"),
      "image/png",
      {
        fetch: async (url: any, init: any) => {
          seen = { url, init };
          return { ok: true, status: 200, headers: { get: () => '"etag"' } };
        },
      },
    );
    expect(seen.url).toBe(
      "https://s3.us-east-1.amazonaws.com/cdn.tranquilo.art/img-cache/a/b/display/h",
    );
    expect(seen.init.method).toBe("PUT");
    expect(seen.init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(seen.init.headers["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sends the session token header only when the config has one", async () => {
    const seen: any[] = [];
    const capture = {
      fetch: async (_url: any, init: any) => {
        seen.push(init.headers);
        return { ok: true, status: 200, headers: { get: () => null } };
      },
    };
    await s3.putObject(config, "k", Buffer.from("x"), "image/png", capture);
    await s3.putObject(
      Object.assign({}, config, { sessionToken: () => "TOKEN" }),
      "k",
      Buffer.from("x"),
      "image/png",
      capture,
    );
    expect(seen[0]["x-amz-security-token"]).toBeUndefined();
    expect(seen[1]["x-amz-security-token"]).toBe("TOKEN");
    expect(seen[1].authorization).toContain("x-amz-security-token");
  });

  it("reports an HTTP failure instead of throwing", async () => {
    // The caller's fallback is Blob or origin; an exception here would turn
    // a degraded cache into a failed image.
    const out = await s3.putObject(config, "k", Buffer.from("x"), "image/png", {
      fetch: async () => ({
        ok: false,
        status: 403,
        headers: { get: () => null },
      }),
    });
    expect(out).toMatchObject({ ok: false, status: 403 });
  });

  it("reports a network failure instead of throwing", async () => {
    const out = await s3.putObject(config, "k", Buffer.from("x"), "image/png", {
      fetch: async () => {
        throw new Error("ECONNRESET");
      },
    });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(0);
  });
});

describe("getObject", () => {
  // Reads an already-stored object back out of S3, to downscale oversized
  // display-tier objects without touching the origin -- load-bearing for
  // Commons, which is under a standing NOC hold ruling out any re-fetch.
  const config = {
    bucket: "cdn.tranquilo.art",
    region: "us-east-1",
    accessKeyId: "AKIAEXAMPLE",
    secret: () => "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  };

  it("addresses the path-style endpoint with GET and no content-type header", async () => {
    let seen: any = null;
    await s3.getObject(config, "img-cache/a/b/display/h", {
      fetch: async (url: any, init: any) => {
        seen = { url, init };
        return {
          ok: true,
          status: 200,
          headers: {
            get: (k: any) => (k === "content-type" ? "image/jpeg" : null),
          },
          arrayBuffer: async () => Buffer.from("bytes").buffer,
        };
      },
    });
    expect(seen.url).toBe(
      "https://s3.us-east-1.amazonaws.com/cdn.tranquilo.art/img-cache/a/b/display/h",
    );
    expect(seen.init.method).toBe("GET");
    expect(seen.init.headers["content-type"]).toBeUndefined();
    expect(seen.init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("returns the body and content-type on success", async () => {
    // TextEncoder's ArrayBuffer is never pooled, unlike Buffer.from(string)'s,
    // so it's the faithful stand-in for a real fetch response's arrayBuffer().
    const out = await s3.getObject(config, "k", {
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: {
          get: (k: any) => (k === "content-type" ? "image/webp" : null),
        },
        arrayBuffer: async () => new TextEncoder().encode("hello").buffer,
      }),
    });
    expect(out.ok).toBe(true);
    expect(Buffer.compare(out.body, Buffer.from("hello"))).toBe(0);
    expect(out.contentType).toBe("image/webp");
  });

  it("reports an HTTP failure instead of throwing", async () => {
    const out = await s3.getObject(config, "missing-key", {
      fetch: async () => ({
        ok: false,
        status: 404,
        headers: { get: () => null },
      }),
    });
    expect(out).toMatchObject({ ok: false, status: 404 });
  });

  it("reports a network failure instead of throwing", async () => {
    const out = await s3.getObject(config, "k", {
      fetch: async () => {
        throw new Error("ECONNRESET");
      },
    });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(0);
  });
});
