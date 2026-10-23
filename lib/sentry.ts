// Shared Sentry init for /api serverless functions -- Vercel Hobby's own
// runtime logs retain only 1 hour, so an error at 2am is otherwise
// invisible by morning. Lives outside /api/ for the usual function-cap
// reason. No Sentry SDK variant targets Vercel's bare (req, res) style, so
// each /api file wraps its own try/catch with reportError() instead.
// reportError() always awaits Sentry.flush(), since a Vercel function can
// freeze the instant its response is sent, dropping an unflushed event.
// Sentry.init() with no dsn no-ops rather than throwing, so this is safe to
// import before SENTRY_DSN is set, same fail-quiet posture as getSql().

import * as Sentry from "@sentry/node";

// PII policy: this project has no visitor accounts, so nothing here should
// ever carry a name/email/session id. `sendDefaultPii: false` is set
// explicitly (it's already the SDK default) so this file states the policy
// rather than silently inheriting one that could change upstream.
// scrubEvent() is a second, redundant layer stripping cookies/auth
// headers/any `user` object before an event leaves the process.
function scrubEvent(event: any) {
  if (event?.request) {
    delete event.request.cookies;
    if (event.request.headers) {
      delete event.request.headers.cookie;
      delete event.request.headers.authorization;
    }
  }
  if (event) delete event.user;
  return event;
}

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment:
    process.env.SENTRY_ENVIRONMENT || process.env.VERCEL_ENV || "development",
  sendDefaultPii: false,
  // Off (0) unless explicitly turned on via env -- a sampling/cost decision,
  // not a code change. Set SENTRY_TRACES_SAMPLE_RATE in Vercel to enable.
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE) || 0,
  beforeSend: scrubEvent,
  beforeSendTransaction: scrubEvent,
});

async function reportError(
  err: unknown,
  context?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
): Promise<void> {
  Sentry.captureException(err, context);
  await Sentry.flush(2000);
}

// For a failure that isn't an exception: a request we rejected or an upstream
// we couldn't use, where the bug is ours rather than the visitor's (a form
// sending a value the endpoint doesn't accept, a missing key, Resend refusing
// a call). These used to reach only the function log, which nobody watches;
// a signup form was quietly turned away for weeks that way. `key` is the
// fingerprint, so repeats group into one issue instead of one alert each.
//
// Callers pass only shapes and statuses, never visitor input; upstream error
// text goes through redactEmails() (lib/redact.ts) first, since providers sometimes echo the
// address back.
async function reportProblem(
  key: string,
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  Sentry.captureMessage(message, {
    level: "error",
    fingerprint: [key],
    tags: { problem: key },
    extra,
  });
  await Sentry.flush(2000);
}

export { reportError, reportProblem, Sentry };
