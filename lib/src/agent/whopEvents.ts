import { createLogger } from "../logger";
import { store } from "../storage";
import { walletService } from "../storage/wallet";
import { config } from "../config";
import type { WhopWebhookEvent } from "../types";

const log = createLogger("whop:events");

export interface ProcessResult {
  processed: boolean;
  duplicate?: boolean;
  action?: string;
  agentId?: string;
  amount?: number;
}

/** Event types that credit vs. debit the local wallet. */
const CREDIT_EVENTS = [
  "payment.succeeded",
  "payment.completed",
  "payment.created",
  "payment_succeeded",
  "payout.completed",
  "balance.credited",
  "app_payment.succeeded",
];

const DEBIT_EVENTS = [
  "payment.refunded",
  "payment.failed",
  "refund.created",
  "balance.debited",
  "payout.failed",
];

/**
 * Classify an event as crediting or debiting the local wallet. Explicit debit
 * types are checked first so shared prefixes (e.g. `payment.*`) can never
 * credit a refund by mistake.
 */
function classify(type: string): "credit" | "debit" | "ignore" {
  const t = type.toLowerCase();
  if (DEBIT_EVENTS.includes(t)) return "debit";
  if (CREDIT_EVENTS.includes(t)) return "credit";
  return "ignore";
}

function pickNumber(data: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = data[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
      return Number(v);
    }
  }
  // Nested amount objects (e.g. Stripe-style { amount: { value, currency } }).
  const nested = data.amount;
  if (nested && typeof nested === "object") {
    const value = (nested as Record<string, unknown>).value;
    if (typeof value === "number") return value;
    if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function pickAgentId(data: Record<string, unknown>): string {
  const candidates = [
    "agent_id",
    "metadata.agent_id",
    "account_id",
    "member_id",
    "user_id",
  ];
  for (const c of candidates) {
    if (c.includes(".")) {
      const [outer, inner] = c.split(".");
      const obj = data[outer];
      if (obj && typeof obj === "object") {
        const v = (obj as Record<string, unknown>)[inner];
        if (typeof v === "string" && v) return v;
      }
    } else if (typeof data[c] === "string" && data[c]) {
      return data[c] as string;
    }
  }
  // Default to ourselves: most events represent money flowing to this node.
  return config.agent.id;
}

export class WhopWebhookProcessor {
  /**
   * Idempotently apply a Whop event to the wallet/ledger.
   * Events are keyed by id so redeliveries never double-credit.
   */
  async process(event: WhopWebhookEvent): Promise<ProcessResult> {
    const eventId = event.id ?? `${event.type}:${JSON.stringify(event.data)}`;
    const seen = await store.processedEvents.get(eventId);
    if (seen) {
      log.debug("duplicate webhook event ignored", { eventId, type: event.type });
      return { processed: false, duplicate: true };
    }

    const kind = classify(event.type);
    if (kind === "ignore") {
      await store.processedEvents.put({ id: eventId, at: new Date().toISOString() });
      log.debug("ignored webhook event", { type: event.type });
      return { processed: false, action: "ignore" };
    }

    const data = event.data ?? {};
    const amount = pickNumber(data, [
      "amount",
      "total",
      "net_amount",
      "amount_after_fees",
      "subtotal",
    ]);

    if (amount === null) {
      await store.processedEvents.put({ id: eventId, at: new Date().toISOString() });
      log.warn("webhook event without a parseable amount", { type: event.type });
      return { processed: false, action: "no_amount" };
    }

    const agentId = pickAgentId(data);
    const currency =
      (typeof data.currency === "string" && data.currency) || "USD";
    const taskId =
      (typeof data.task_id === "string" && data.task_id) ||
      (typeof data.metadata === "object" &&
        data.metadata &&
        typeof (data.metadata as Record<string, unknown>).task_id === "string" &&
        ((data.metadata as Record<string, unknown>).task_id as string)) ||
      undefined;

    if (kind === "credit") {
      await walletService.apply(agentId, Math.abs(amount), "webhook_credit", {
        currency,
        taskId: taskId || undefined,
        whopPaymentId: event.id,
        memo: `Whop ${event.type}`,
        allowNegative: true,
      });
    } else {
      await walletService.apply(agentId, -Math.abs(amount), "webhook_debit", {
        currency,
        taskId: taskId || undefined,
        whopPaymentId: event.id,
        memo: `Whop ${event.type}`,
      });
    }

    await store.processedEvents.put({ id: eventId, at: new Date().toISOString() });
    log.info("webhook event applied", { type: event.type, agentId, amount, kind });
    return { processed: true, action: kind, agentId, amount };
  }
}

export const whopWebhookProcessor = new WhopWebhookProcessor();
