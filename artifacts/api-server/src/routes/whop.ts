import { Router, type Request, type Response } from "express";
import {
  config,
  createLogger,
  verifyWhopSignature,
  whopWebhookProcessor,
  type WhopWebhookEvent,
} from "hyperagent-lib";

const log = createLogger("route:whop");
export const whopRouter = Router();

/**
 * Whop webhook receiver (requirement 3).
 *
 * Security:
 *  - Signature is verified over the Standard Webhooks signed content
 *    `{webhook-id}.{webhook-timestamp}.{raw body}` using base64 HMAC-SHA256
 *    with a constant-time comparison.
 *  - Requests older than the tolerance window are rejected (replay protection).
 *  - Processing is idempotent by event id, so retries/redeliveries are safe.
 *
 * The raw bytes are captured by the express.raw middleware mounted for this
 * path in app.ts, so JSON parsing cannot alter what gets verified.
 */
whopRouter.post("/webhook", async (req: Request, res: Response) => {
  const rawBody: Buffer = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}));

  const verdict = verifyWhopSignature(rawBody, {
    id: req.header("webhook-id") ?? req.header("x-whop-id") ?? undefined,
    timestamp: req.header("webhook-timestamp") ?? req.header("x-whop-timestamp") ?? undefined,
    signature: req.header("webhook-signature") ?? req.header("x-whop-signature") ?? undefined,
  });
  if (!verdict.ok) {
    log.warn("rejected webhook", { reason: verdict.reason });
    return res.status(401).json({ ok: false, error: verdict.reason });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
  } catch {
    return res.status(400).json({ ok: false, error: "invalid JSON body" });
  }

  const type =
    (typeof payload.type === "string" && payload.type) ||
    req.header("webhook-event") ||
    "unknown";
  const event: WhopWebhookEvent = {
    id: (typeof payload.id === "string" && payload.id) || req.header("webhook-id") || undefined,
    type,
    createdAt:
      (typeof payload.created_at === "string" && payload.created_at) ||
      (typeof payload.createdAt === "string" && payload.createdAt) ||
      undefined,
    data: (payload.data as Record<string, unknown>) ?? payload,
  };

  try {
    const result = await whopWebhookProcessor.process(event);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    // A processing failure must not crash the server; ask Whop to retry.
    log.error("webhook processing error", { error: (err as Error).message, type });
    return res.status(500).json({ ok: false, error: "processing failed" });
  }
});

/** Liveness probe for the webhook surface. */
whopRouter.get("/webhook", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    endpoint: "/api/whop/webhook",
    scheme: "standard-webhooks",
    requireSignature: config.whop.requireWebhookSignature,
    secretConfigured: Boolean(config.whop.webhookSecret),
    toleranceSec: config.whop.webhookToleranceSec,
  });
});
