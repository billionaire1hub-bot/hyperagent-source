import { randomUUID } from "crypto";
import { store } from "./index";
import { createLogger } from "../logger";
import type { LedgerEntry, LedgerEntryType, WalletBalance } from "../types";

const log = createLogger("wallet");

const DEFAULT_CURRENCY = "USD";

export class WalletService {
  async getBalance(agentId: string): Promise<WalletBalance> {
    const existing = await store.balances.get(agentId);
    if (existing) return existing;
    const fresh: WalletBalance = {
      id: agentId,
      agentId,
      available: 0,
      currency: DEFAULT_CURRENCY,
      updatedAt: new Date().toISOString(),
    };
    await store.balances.put(fresh);
    return fresh;
  }

  async listBalances(): Promise<WalletBalance[]> {
    return store.balances.all();
  }

  async listLedger(agentId?: string, limit = 100): Promise<LedgerEntry[]> {
    const entries = agentId
      ? await store.ledger.find((e) => e.agentId === agentId)
      : await store.ledger.all();
    return entries
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, limit);
  }

  /**
   * Apply a signed amount to an agent's balance and record a ledger entry.
   * Negative amounts debit. Balances may go negative only when `allowNegative`.
   */
  async apply(
    agentId: string,
    amount: number,
    type: LedgerEntryType,
    opts: {
      taskId?: string;
      whopPaymentId?: string;
      memo?: string;
      currency?: string;
      allowNegative?: boolean;
    } = {},
  ): Promise<WalletBalance> {
    const currency = opts.currency ?? DEFAULT_CURRENCY;
    const current = await this.getBalance(agentId);
    const next = current.available + amount;
    const balance =
      next < 0 && !opts.allowNegative ? 0 : next;

    const entry: LedgerEntry = {
      id: randomUUID(),
      agentId,
      type,
      amount,
      currency,
      taskId: opts.taskId,
      whopPaymentId: opts.whopPaymentId,
      memo: opts.memo,
      at: new Date().toISOString(),
    };
    await store.ledger.put(entry);

    const updated: WalletBalance = {
      id: agentId,
      agentId,
      available: Number(balance.toFixed(6)),
      currency,
      updatedAt: new Date().toISOString(),
    };
    await store.balances.put(updated);
    log.info("balance updated", {
      agentId,
      type,
      amount,
      available: updated.available,
    });
    return updated;
  }

  /** Credit earnings for a completed task. */
  async credit(agentId: string, amount: number, memo: string, taskId?: string, whopPaymentId?: string) {
    return this.apply(agentId, Math.abs(amount), "credit", {
      taskId,
      whopPaymentId,
      memo,
      allowNegative: true,
    });
  }

  /** Debit funds for a payout/charge. */
  async debit(agentId: string, amount: number, memo: string, taskId?: string, whopPaymentId?: string) {
    return this.apply(agentId, -Math.abs(amount), "debit", {
      taskId,
      whopPaymentId,
      memo,
    });
  }
}

export const walletService = new WalletService();
