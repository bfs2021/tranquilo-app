// Writing an object to S3. Plain fetch + SigV4, no SDK -- this codebase's
// stated convention (see lib/cron/db-backup.ts), avoiding a large dependency
// in the single hottest function in the project for one signed request.
//
// Path-style addressing, not virtual-hosted: the bucket name
// `cdn.prod.tranquilo.art` contains dots, so the virtual-hosted host
// (cdn.prod.tranquilo.art.s3.us-east-1.amazonaws.com) has more labels than
// AWS's wildcard cert (*.s3.us-east-1.amazonaws.com) can match -- confirmed
// live, TLS fails with "no alternative certificate subject name matches".
// Path-style keeps the host at plain s3.<region>.amazonaws.com, which
// verifies. The bucket itself has been rotated at least once (same dotted-
// name requirement each time) -- this reasoning outlives any one bucket
// name, so don't treat the literal name here as a config source of truth.

import crypto from "node:crypto";

const SERVICE = "s3";
const ALGORITHM = "AWS4-HMAC-SHA256";

function sha256hex(buf: any): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
function hmac(key: any, data: any): Buffer {
  return crypto.createHmac("sha256", key).update(data).digest();
}

// Each path segment is encoded but the "/" separators are not, matching S3's
// own canonicalisation.
function canonicalUriFor(bucket: any, key: any): string {
  return `/${bucket}/${String(key).split("/").map(encodeURIComponent).join("/")}`;
}

// Exported for testing: the signature has to be reproducible from fixed inputs,
// or there is no way to tell a correct implementation from one that merely
// happens to be accepted today.
function signRequest(opts: any): any {
  const method = opts.method;
  const host = opts.host;
  const canonicalUri = opts.canonicalUri;
  const payloadHash = opts.payloadHash;
  const contentType = opts.contentType;
  const amzDate = opts.amzDate; // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const region = opts.region;

  // content-type is signed only when actually sent (PUT) -- a signed header
  // that is absent, or an unsigned header that is present, is a mismatch.
  const sessionToken = opts.sessionToken;
  const canonicalHeaders =
    `${contentType ? `content-type:${contentType}\n` : ""}host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n` +
    `${sessionToken ? `x-amz-security-token:${sessionToken}\n` : ""}`;
  const signedHeaders =
    `${contentType ? "content-type;" : ""}host;x-amz-content-sha256;x-amz-date` +
    `${sessionToken ? ";x-amz-security-token" : ""}`;

  const canonicalRequest = [
    method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    sha256hex(Buffer.from(canonicalRequest)),
  ].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${opts.secretAccessKey}`, dateStamp), region), SERVICE),
    "aws4_request",
  );
  const signature = crypto
    .createHmac("sha256", signingKey)
    .update(stringToSign)
    .digest("hex");

  return {
    signedHeaders: signedHeaders,
    signature: signature,
    authorization: `${ALGORITHM} Credential=${opts.accessKeyId}/${
      scope
    }, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// Set only for temporary credentials, such as a Lambda's IAM role.
function sessionTokenOf(config: any): string {
  return config.sessionToken ? config.sessionToken() : "";
}

function securityTokenHeader(config: any): Record<string, string> {
  const token = sessionTokenOf(config);
  return token ? { "x-amz-security-token": token } : {};
}

function amzDateNow(now?: any): string {
  return (now || new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
}

// PUT one object. Never throws -- an exception on the hot path would turn a
// degraded cache into a failed request; the caller falls back to Blob/origin.
async function putObject(
  config: any,
  key: any,
  body: any,
  contentType: any,
  opts?: any,
): Promise<any> {
  const options = opts || {};
  const host = `s3.${config.region}.amazonaws.com`;
  const canonicalUri = canonicalUriFor(config.bucket, key);
  const payloadHash = sha256hex(body);
  const amzDate = amzDateNow(options.now);

  const signed = signRequest({
    method: "PUT",
    host: host,
    canonicalUri: canonicalUri,
    payloadHash: payloadHash,
    contentType: contentType,
    amzDate: amzDate,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secret(),
    sessionToken: sessionTokenOf(config),
  });

  try {
    const res = await (options.fetch || fetch)(
      `https://${host}${canonicalUri}`,
      {
        method: "PUT",
        headers: {
          "content-type": contentType,
          "x-amz-content-sha256": payloadHash,
          "x-amz-date": amzDate,
          ...securityTokenHeader(config),
          authorization: signed.authorization,
        },
        body: body,
      },
    );
    return {
      ok: res.ok,
      status: res.status,
      etag: res.headers?.get ? res.headers.get("etag") : null,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: String(((err as any) && (err as any).message) || err),
    };
  }
}

// GET one object. Same non-throwing convention as putObject. No body means
// no content-type to sign; the payload hash is just the hash of an empty
// buffer, same as AWS's own GET/DELETE examples.
async function getObject(config: any, key: any, opts?: any): Promise<any> {
  const options = opts || {};
  const host = `s3.${config.region}.amazonaws.com`;
  const canonicalUri = canonicalUriFor(config.bucket, key);
  const payloadHash = sha256hex(Buffer.alloc(0));
  const amzDate = amzDateNow(options.now);

  const signed = signRequest({
    method: "GET",
    host: host,
    canonicalUri: canonicalUri,
    payloadHash: payloadHash,
    amzDate: amzDate,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secret(),
    sessionToken: sessionTokenOf(config),
  });

  try {
    const res = await (options.fetch || fetch)(
      `https://${host}${canonicalUri}`,
      {
        method: "GET",
        headers: {
          "x-amz-content-sha256": payloadHash,
          "x-amz-date": amzDate,
          ...securityTokenHeader(config),
          authorization: signed.authorization,
        },
      },
    );
    if (!res.ok) {
      return { ok: false, status: res.status };
    }
    return {
      ok: true,
      status: res.status,
      body: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers?.get ? res.headers.get("content-type") : null,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: String(((err as any) && (err as any).message) || err),
    };
  }
}

export { amzDateNow, canonicalUriFor, getObject, putObject, signRequest };
