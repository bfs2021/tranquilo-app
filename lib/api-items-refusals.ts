// Daily count of refused /api/items requests, read from Vercel's metrics
// API. 429s come from the firewall's per-IP rate limit (and Bot Protection
// challenges); 400s from bulk requests the API rejects. Neither reaches
// Sentry, so a burst of either is the signal that someone is scraping.
//
// Required env vars: VERCEL_API_TOKEN, VERCEL_PROJECT_ID, and
// VERCEL_ORG_ID or VERCEL_TEAM_ID. Skipped when any is missing.

const API_BASE = "https://api.vercel.com";

// Bot Protection challenges alone produce about 11 429s a day.
const API_ITEMS_429_THRESHOLD_24H = 200;
// Real visitors never send bulk requests, so any steady stream is a client
// probing the API.
const API_ITEMS_400_THRESHOLD_24H = 50;

type Env = Record<string, string | undefined>;
type SummaryRow = { http_status?: string; vercel_request_count_sum?: number };

async function checkApiItemsRefusals(
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<string[]> {
  const token = env.VERCEL_API_TOKEN;
  const projectId = env.VERCEL_PROJECT_ID;
  const teamId = env.VERCEL_ORG_ID || env.VERCEL_TEAM_ID;
  if (!token || !projectId || !teamId) {
    console.warn(
      "health-check: skipping /api/items refusal check, Vercel API credentials not set",
    );
    return [];
  }

  const url = new URL(`${API_BASE}/v2/observability/query`);
  url.searchParams.set("teamId", teamId);
  const res = await fetchImpl(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      metric: "vercel.request.count",
      scope: { type: "project", ownerId: teamId, projectIds: [projectId] },
      startTime: new Date(now.getTime() - 24 * 3600 * 1000).toISOString(),
      endTime: now.toISOString(),
      filter: "request_path eq '/api/items'",
      groupBy: ["http_status"],
      aggregation: "sum",
      summaryOnly: true,
    }),
  });
  if (!res.ok) {
    return [
      `Could not read /api/items refusal counts from Vercel (HTTP ${res.status}).`,
    ];
  }

  const body = await res.json();
  const summary: SummaryRow[] = body?.result?.summary ?? [];
  const countFor = (status: string) =>
    Number(
      summary.find((row) => row.http_status === status)
        ?.vercel_request_count_sum ?? 0,
    );

  const alerts: string[] = [];
  const rateLimited = countFor("429");
  if (rateLimited >= API_ITEMS_429_THRESHOLD_24H) {
    alerts.push(
      `/api/items returned ${rateLimited} 429 responses in the last 24h ` +
        `(threshold ${API_ITEMS_429_THRESHOLD_24H}): possible scraping hitting the rate limit.`,
    );
  }
  const rejected = countFor("400");
  if (rejected >= API_ITEMS_400_THRESHOLD_24H) {
    alerts.push(
      `/api/items returned ${rejected} 400 responses in the last 24h ` +
        `(threshold ${API_ITEMS_400_THRESHOLD_24H}): a client is sending bulk or malformed requests.`,
    );
  }
  return alerts;
}

export {
  API_ITEMS_400_THRESHOLD_24H,
  API_ITEMS_429_THRESHOLD_24H,
  checkApiItemsRefusals,
};
