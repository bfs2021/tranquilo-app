// Lambda Function URL entry point for the image miss path. CloudFront calls
// it as ?source=&id=&tier=; all decisions live in resolve-miss.ts.
import { getSql } from "../../lib/db.ts";
import * as store from "../../lib/img-store.ts";
import { headerSafeLocation } from "../../lib/img-transform.ts";
import * as sentry from "../../lib/sentry.ts";
import { resolveMiss } from "./resolve-miss.ts";

const ALERT_REPEAT_MS = 15 * 60 * 1000;
const alertedAt = new Map<string, number>();

// Lambda injects its role's temporary credentials as AWS_*; explicit S3_*
// keys still win so the function can run outside Lambda.
function s3EnvFrom(env: Record<string, string | undefined>) {
  if (env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY) return { ...env };
  return {
    ...env,
    S3_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
    S3_SESSION_TOKEN: env.AWS_SESSION_TOKEN,
  };
}

// Same error name and alert_key tag as the Vercel proxy, so existing
// Sentry alert rules match both.
async function alertOnce(key: string, message: string, extra?: any) {
  const now = Date.now();
  const last = alertedAt.get(key);
  if (last !== undefined && now - last < ALERT_REPEAT_MS) return;
  alertedAt.set(key, now);
  console.error(`img resize: ${message}`, extra || "");
  try {
    const err = new Error(`img resize: ${message}`);
    err.name = "ImgProxyDegraded";
    await sentry.reportError(err, { tags: { alert_key: key }, extra });
  } catch (_e) {
    // Alerting must never fail the request.
  }
}

function json(
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

async function handler(event: any): Promise<any> {
  const qs = event?.queryStringParameters || {};
  const { source, id, tier } = qs;
  if (!source || !id || !tier) {
    return json(400, { error: "Expected ?source=&id=&tier=" });
  }

  const sql = getSql();
  const s3Config = store.configFromEnv(s3EnvFrom(process.env));
  if (!sql || !s3Config.enabled) {
    return json(500, { error: "Database or S3 is not configured" });
  }

  try {
    const result = await resolveMiss(
      sql,
      s3Config,
      { source, id, tier },
      alertOnce,
    );
    if (result.kind === "redirect") {
      return {
        statusCode: 302,
        headers: {
          location: headerSafeLocation(result.url),
          "cache-control": result.cacheControl,
          "x-tranquilo-reason": result.reason,
        },
        body: "",
      };
    }
    if (result.kind === "unavailable") {
      return json(
        503,
        { error: "Image temporarily unavailable", reason: result.reason },
        { "retry-after": "60" },
      );
    }
    return json(result.status, { error: result.reason });
  } catch (err) {
    console.error(`img resize: failed for ${source}:${id}:${tier}`, err);
    await sentry.reportError(err);
    return json(502, { error: "Image unavailable" });
  }
}

function _resetAlerts() {
  alertedAt.clear();
}

export { _resetAlerts, handler, s3EnvFrom };
