import { config } from "../config";
import { createLogger } from "../logger";
import { fetchWithTimeout, withRetry } from "../retry";

const log = createLogger("whop");

/** Extract a numeric amount from a response that may nest it in a money object. */
function MoneyNumber(data: Record<string, unknown> | null): number | null {
  if (!data) return null;
  for (const key of ["amount", "total_usd", "total", "balance", "available"]) {
    const v = data[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
    if (v && typeof v === "object") {
      const inner = (v as Record<string, unknown>).amount;
      if (typeof inner === "number" && Number.isFinite(inner)) return inner;
    }
  }
  return null;
}

/** A money object as returned by the Whop API: `{ amount, currency, ... }`. */
export interface MoneyObject {
  amount: number;
  currency: string;
  decimals?: number;
}

export interface WhopTransfer {
  id: string;
  amount: number;
  currency: string;
  status?: string;
  raw?: Record<string, unknown>;
}

export interface WhopPayment {
  id: string;
  amount: number;
  currency: string;
  status: string;
  raw?: Record<string, unknown>;
}

/**
 * Real Whop API client (requirements 2 & 3).
 *
 * Endpoints used (Whop API v5):
 *   - GET  /accounts/{id}                  -> read the account (company) balance
 *   - POST /transfers                      -> move balance (payout / revenue share)
 *   - POST /payments                       -> charge a buyer on an existing plan
 *
 * Every call returns `null` (never throws) when the API is unavailable or not
 * configured, so the autonomous loop degrades to the internal ledger instead of
 * crashing. Responses are logged so balances reflect real API results.
 */
export class WhopClient {
  get configured(): boolean {
    return Boolean(config.whop.apiKey);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${config.whop.apiKey}`,
      "Content-Type": "application/json",
    };
    if (config.whop.apiVersionDate) h["Api-Version-Date"] = config.whop.apiVersionDate;
    return h;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T | null> {
    if (!this.configured) {
      log.debug("whop not configured, skipping request", { path });
      return null;
    }
    try {
      const res = await withRetry(
        () =>
          fetchWithTimeout(
            `${config.whop.baseUrl}${path}`,
            { ...init, headers: { ...this.headers(), ...(init.headers ?? {}) } },
            config.whop.timeoutMs,
          ),
        { retries: 2, baseDelayMs: 1000, maxDelayMs: 8000 },
      );
      if (!res.ok) {
        // Log loudly: a wrong base URL or missing scope otherwise fails silently
        // and the balance stays zero with no clue why.
        log.error("whop request failed", {
          path,
          status: res.status,
          body: (await res.text()).slice(0, 300),
        });
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      log.error("whop request error", { path, error: (err as Error).message });
      return null;
    }
  }

  /** Read the account's USD balance from the real Account resource. */
  private static extractBalance(data: Record<string, unknown> | null): number | null {
    if (!data) return null;
    // GET /accounts/{id} exposes `total_usd` (string) as the primary balance.
    const totalUsd = data.total_usd;
    if (typeof totalUsd === "string" && totalUsd.trim() !== "" && Number.isFinite(Number(totalUsd))) {
      return Number(totalUsd);
    }
    if (typeof totalUsd === "number" && Number.isFinite(totalUsd)) return totalUsd;
    // Fall back to summing the `balances[].breakdown.available` amounts.
    const balances = data.balances;
    if (Array.isArray(balances)) {
      let sum = 0;
      let found = false;
      for (const b of balances as Array<Record<string, unknown>>) {
        const breakdown = b.breakdown as Record<string, unknown> | undefined;
        const available = breakdown?.available;
        if (typeof available === "string" && Number.isFinite(Number(available))) {
          sum += Number(available);
          found = true;
        }
      }
      if (found) return Math.round(sum * 100) / 100;
    }
    return MoneyNumber(data);
  }

  /**
   * Retrieve the company/account balance. Prefers the company id; falls back to
   * the ledger-account endpoint. Returns null when unavailable.
   */
  async getBalance(accountId = config.whop.companyId): Promise<number | null> {
    if (!accountId) return null;
    const account = await this.request<Record<string, unknown>>(`/accounts/${accountId}`);
    const fromAccount = WhopClient.extractBalance(account);
    if (fromAccount !== null) return fromAccount;

    const ledger = await this.request<Record<string, unknown>>(`/ledger_accounts/${accountId}`);
    return WhopClient.extractBalance(ledger);
  }

  /**
   * Move balance from our account to a destination (`user_`/`biz_`/`ldgr_`).
   * Used to pay out an agent and, in reverse, to collect an agreed task payout.
   * `idempotenceKey` prevents a retried transfer from moving money twice.
   */
  async createTransfer(params: {
    amount: number;
    destinationId: string;
    originId?: string;
    currency?: string;
    notes?: string;
    metadata?: Record<string, string>;
    idempotenceKey: string;
  }): Promise<WhopTransfer | null> {
    const body = {
      amount: params.amount,
      currency: params.currency ?? "usd",
      origin_id: params.originId ?? config.whop.companyId,
      destination_id: params.destinationId,
      type: "balance",
      idempotence_key: params.idempotenceKey,
      notes: params.notes,
      metadata: params.metadata,
    };
    const data = await this.request<Record<string, unknown>>("/transfers", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!data) return null;
    return {
      id: String(data.id ?? `transfer_${Date.now()}`),
      amount: MoneyNumber(data) ?? params.amount,
      currency: String(data.currency ?? params.currency ?? "usd"),
      status: typeof data.status === "string" ? data.status : undefined,
      raw: data,
    };
  }

  /**
   * Create a payment. Per the real API an `account_id` is required and a
   * `plan_id` selects the variant, so both must be configured; without them we
   * return null and settlement stays ledger-only rather than sending a bad
   * request that Whop would reject.
   */
  async createPayment(params: {
    planId?: string;
    amount?: number;
    currency?: string;
    metadata?: Record<string, string>;
  }): Promise<WhopPayment | null> {
    if (!params.planId || !config.whop.companyId) {
      log.debug("createPayment skipped: plan_id/account_id not configured");
      return null;
    }
    const data = await this.request<Record<string, unknown>>("/payments", {
      method: "POST",
      body: JSON.stringify({
        account_id: config.whop.companyId,
        plan_id: params.planId,
        metadata: params.metadata,
      }),
    });
    if (!data) return null;
    return {
      id: String(data.id ?? `pay_${Date.now()}`),
      amount: MoneyNumber(data) ?? params.amount ?? 0,
      currency: String(data.currency ?? params.currency ?? "usd"),
      status: String(data.status ?? "created"),
      raw: data,
    };
  }

  /** Pay a peer for work they completed for us (outbound transfer). */
  async payOut(params: {
    amount: number;
    destinationId?: string;
    currency?: string;
    notes?: string;
    taskId: string;
  }): Promise<WhopTransfer | null> {
    const destination = params.destinationId ?? config.whop.payoutDestinationId;
    if (!destination) {
      log.debug("payOut skipped: no destination configured");
      return null;
    }
    return this.createTransfer({
      amount: params.amount,
      destinationId: destination,
      currency: params.currency,
      notes: params.notes ?? `HyperAgent payout for task ${params.taskId}`,
      metadata: { task_id: params.taskId },
      idempotenceKey: `task-payout-${params.taskId}`,
    });
  }
}

export const whop = new WhopClient();
