// The daily health check reports bursts of refused /api/items requests:
// 429s from the firewall rate limit and 400s from bulk requests the API
// rejects. Neither reaches Sentry, so this is the only signal.
import { describe, expect, it, vi } from "vitest";
import {
  API_ITEMS_400_THRESHOLD_24H,
  API_ITEMS_429_THRESHOLD_24H,
  checkApiItemsRefusals,
} from "../lib/api-items-refusals.ts";

const ENV = {
  VERCEL_API_TOKEN: "token",
  VERCEL_PROJECT_ID: "prj_1",
  VERCEL_ORG_ID: "team_1",
};
const NOW = new Date("2026-10-26T12:00:00Z");

function fetchReturning(summary: { http_status: string; n: number }[]) {
  return vi.fn(async () =>
    Response.json({
      result: {
        summary: summary.map((s) => ({
          http_status: s.http_status,
          vercel_request_count_sum: s.n,
        })),
      },
    }),
  );
}

describe("checkApiItemsRefusals", () => {
  it("stays quiet at normal levels", async () => {
    const fetchImpl = fetchReturning([
      { http_status: "200", n: 5000 },
      { http_status: "429", n: 11 },
      { http_status: "400", n: 1 },
    ]);
    expect(await checkApiItemsRefusals(ENV, fetchImpl, NOW)).toEqual([]);
  });

  it("alerts on a burst of 429s", async () => {
    const fetchImpl = fetchReturning([
      { http_status: "429", n: API_ITEMS_429_THRESHOLD_24H },
    ]);
    const alerts = await checkApiItemsRefusals(ENV, fetchImpl, NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/429/);
  });

  it("alerts on a burst of 400s", async () => {
    const fetchImpl = fetchReturning([
      { http_status: "400", n: API_ITEMS_400_THRESHOLD_24H },
    ]);
    const alerts = await checkApiItemsRefusals(ENV, fetchImpl, NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/400/);
  });

  it("asks for the last 24 hours of /api/items responses by status", async () => {
    const fetchImpl = fetchReturning([]);
    await checkApiItemsRefusals(ENV, fetchImpl, NOW);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("teamId=team_1");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer token",
    );
    const body = JSON.parse(String(init.body));
    expect(body.scope.projectIds).toEqual(["prj_1"]);
    expect(body.filter).toContain("/api/items");
    expect(body.groupBy).toEqual(["http_status"]);
    expect(new Date(body.endTime).getTime()).toBe(NOW.getTime());
    expect(new Date(body.startTime).getTime()).toBe(
      NOW.getTime() - 24 * 3600 * 1000,
    );
  });

  it("skips without calling Vercel when credentials are missing", async () => {
    const fetchImpl = fetchReturning([]);
    expect(await checkApiItemsRefusals({}, fetchImpl, NOW)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports an unreadable metrics API as an alert, not a crash", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 403 }));
    const alerts = await checkApiItemsRefusals(ENV, fetchImpl, NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/403/);
  });
});
