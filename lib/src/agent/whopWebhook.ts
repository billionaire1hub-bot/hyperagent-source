import { createHmac, timingSafeEqual } from "crypto";
import { config } from "../config";
import { createLogger } from "../logger";

const log = createLogger("whop:webhook");

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

/** Headers Whop sends with every webhook (Standard Webhooks scheme). */
export interface WebhookHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

/**
 * Derive the HMAC key from a Whop signing secret.
 *
 * Whop secrets are `ws_`-prefixed (Standard Webhooks uses `whsec_`); per the
 * spec the prefix is stripped and the remainder is base64-decoded to obtain the
 * raw key bytes. If the remainder is not valid base64 we fall back to the raw
 * string bytes, which keeps custom/local secrets working.
 */
export function deriveSigningKey(secret: string): Buffer {
  const trimmed = secret.replace(/^(ws_|whsec_)/, "");
  try {
    const decoded = Buffer.from(trimmed, "base64");
    // A valid base64 secret round-trips; otherwise treat the secret as literal.
    if (decoded.length > 0 && decoded.toString("base64").replace(/=+$/, "") === trimmed.replace(/=+$/, "")) {
      return decoded;
    }
  } catch {
    /* fall through */
  }
  return Buffer.from(secret, "utf8");
}

/**
 * Verify a Whop webhook exactly as documented:
 *   signed content = `{webhook-id}.{webhook-timestamp}.{raw body}`
 *   signature      = base64(HMAC-SHA256(key, signed content))
 *   header value   = `v1,<base64>` (space-delimited during key rotation)
 *
 * A constant-time comparison is used, and requests whose timestamp is outside
 * the tolerance window are rejected to prevent replay.
 */
export function verifyWhopSignature(
  rawBody: Buffer,
  headers: WebhookHeaders,
  secret = config.whop.webhookSecret,
): VerifyResult {
  if (!config.whop.requireWebhookSignature) {
    return { ok: true, reason: "signature check disabled" };
  }
  if (!secret) return { ok: false, reason: "no webhook secret configured" };
  if (!headers.id || !headers.timestamp || !headers.signature) {
    return { ok: false, reason: "missing webhook-id/timestamp/signature header" };
  }

  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "invalid webhook-timestamp" };
  const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (skew > config.whop.webhookToleranceSec) {
    return { ok: false, reason: `timestamp outside tolerance (${skew}s)` };
  }

  const key = deriveSigningKey(secret);
  const signedContent = Buffer.concat([
    Buffer.from(`${headers.id}.${headers.timestamp}.`, "utf8"),
    rawBody,
  ]);
  const expected = createHmac("sha256", key).update(signedContent).digest("base64");
  const expectedBuf = Buffer.from(expected, "utf8");

  for (const pair of headers.signature.split(" ")) {
    const comma = pair.indexOf(",");
    if (comma === -1) continue;
    const version = pair.slice(0, comma);
    const candidate = pair.slice(comma + 1);
    if (version !== "v1") continue;
    const candidateBuf = Buffer.from(candidate, "utf8");
    if (
      candidateBuf.length === expectedBuf.length &&
      timingSafeEqual(candidateBuf, expectedBuf)
    ) {
      return { ok: true };
    }
  }
  log.warn("signature mismatch");
  return { ok: false, reason: "signature mismatch" };
}

/** Produce a `v1,<base64>` signature. Used by tests and for local replay. */
export function signWhopPayload(
  rawBody: Buffer,
  id: string,
  timestamp: string,
  secret = config.whop.webhookSecret,
): string {
  const key = deriveSigningKey(secret);
  const signedContent = Buffer.concat([
    Buffer.from(`${id}.${timestamp}.`, "utf8"),
    rawBody,
  ]);
  return `v1,${createHmac("sha256", key).update(signedContent).digest("base64")}`;
}
