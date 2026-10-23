// The Function URL adapter only; resolveMiss() has its own tests.
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveMiss = vi.fn();
vi.mock("../lambda/img-resize/resolve-miss.ts", () => ({ resolveMiss }));

const getSql = vi.fn();
vi.mock("../lib/db.ts", () => ({ getSql }));

const configFromEnv = vi.fn();
vi.mock("../lib/img-store.ts", () => ({ configFromEnv }));

const reportError = vi.fn();
vi.mock("../lib/sentry.ts", () => ({ reportError }));

const { handler, s3EnvFrom, _resetAlerts } = await import(
  "../lambda/img-resize/handler.ts"
);

function event(qs: Record<string, string>) {
  return { queryStringParameters: qs };
}
const params = { source: "met", id: "1", tier: "display" };

beforeEach(() => {
  vi.clearAllMocks();
  _resetAlerts();
  getSql.mockReturnValue({});
  configFromEnv.mockReturnValue({ enabled: true });
});

describe("request validation", () => {
  it("400s when a required query param is missing", async () => {
    const r = await handler(event({ source: "met", id: "1" }));
    expect(r.statusCode).toBe(400);
    expect(resolveMiss).not.toHaveBeenCalled();
  });

  it("ignores any origin the caller supplies", async () => {
    resolveMiss.mockResolvedValue({ kind: "unavailable", reason: "x" });
    await handler(event({ ...params, origin: "https://evil.example/x.jpg" }));
    expect(resolveMiss.mock.calls[0][2]).toEqual(params);
  });
});

describe("configuration", () => {
  it("500s when the database isn't configured", async () => {
    getSql.mockReturnValue(null);
    const r = await handler(event(params));
    expect(r.statusCode).toBe(500);
    expect(resolveMiss).not.toHaveBeenCalled();
  });

  it("500s when S3 isn't configured", async () => {
    configFromEnv.mockReturnValue({ enabled: false });
    const r = await handler(event(params));
    expect(r.statusCode).toBe(500);
    expect(resolveMiss).not.toHaveBeenCalled();
  });
});

describe("s3EnvFrom", () => {
  it("uses the role's temporary credentials when no S3 keys are set", () => {
    const env = s3EnvFrom({
      AWS_ACCESS_KEY_ID: "ASIAROLE",
      AWS_SECRET_ACCESS_KEY: "rolesecret",
      AWS_SESSION_TOKEN: "roletoken",
      S3_BUCKET: "b",
    });
    expect(env).toMatchObject({
      S3_ACCESS_KEY_ID: "ASIAROLE",
      S3_SECRET_ACCESS_KEY: "rolesecret",
      S3_SESSION_TOKEN: "roletoken",
      S3_BUCKET: "b",
    });
  });

  it("keeps explicit S3 keys without mixing in the role's token", () => {
    const env = s3EnvFrom({
      AWS_ACCESS_KEY_ID: "ASIAROLE",
      AWS_SECRET_ACCESS_KEY: "rolesecret",
      AWS_SESSION_TOKEN: "roletoken",
      S3_ACCESS_KEY_ID: "AKIAKEY",
      S3_SECRET_ACCESS_KEY: "keysecret",
    });
    expect(env.S3_ACCESS_KEY_ID).toBe("AKIAKEY");
    expect(env.S3_SECRET_ACCESS_KEY).toBe("keysecret");
    expect(env.S3_SESSION_TOKEN).toBeUndefined();
  });
});

describe("result translation", () => {
  it("302s with the given cache-control on a redirect", async () => {
    resolveMiss.mockResolvedValue({
      kind: "redirect",
      url: "https://cdn.tranquilo.art/x",
      cacheControl: "public, max-age=31536000, immutable",
      reason: "written",
    });
    const r = await handler(event(params));
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe("https://cdn.tranquilo.art/x");
    expect(r.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(r.headers["x-tranquilo-reason"]).toBe("written");
  });

  it("makes a redirect Location header-safe", async () => {
    resolveMiss.mockResolvedValue({
      kind: "redirect",
      url: "https://images.metmuseum.org/a–b.jpg",
      cacheControl: "no-store",
      reason: "origin-error",
    });
    const r = await handler(event(params));
    expect(r.headers.location).toBe(
      "https://images.metmuseum.org/a%E2%80%93b.jpg",
    );
  });

  it("503s with Retry-After when unavailable", async () => {
    resolveMiss.mockResolvedValue({
      kind: "unavailable",
      reason: "not-admitted-1",
    });
    const r = await handler(event(params));
    expect(r.statusCode).toBe(503);
    expect(r.headers["retry-after"]).toBe("60");
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("passes an explicit error status through, uncached", async () => {
    resolveMiss.mockResolvedValue({
      kind: "error",
      status: 404,
      reason: "no-such-image",
    });
    const r = await handler(event(params));
    expect(r.statusCode).toBe(404);
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("502s and reports when resolveMiss throws", async () => {
    resolveMiss.mockRejectedValue(new Error("sharp exploded"));
    const r = await handler(event(params));
    expect(r.statusCode).toBe(502);
    expect(reportError).toHaveBeenCalled();
  });
});

describe("alerts", () => {
  it("reports each condition once per repeat window, tagged for alert rules", async () => {
    resolveMiss.mockImplementation(async (_sql, _cfg, _p, alert) => {
      await alert("s3-put-failed", "S3 put failed", { status: 403 });
      return { kind: "unavailable", reason: "x" };
    });
    await handler(event(params));
    await handler(event(params));
    expect(reportError).toHaveBeenCalledTimes(1);
    const [err, ctx] = reportError.mock.calls[0];
    expect(err.name).toBe("ImgProxyDegraded");
    expect(ctx.tags).toEqual({ alert_key: "s3-put-failed" });
  });
});
