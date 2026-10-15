/** Domain model shared across storage, A2A protocol, workers and the API server. */

export type AgentStatus = "online" | "offline" | "unknown";

/** A peer discovered on the A2A network. */
export interface PeerAgent {
  id: string;
  name?: string;
  url: string;
  description?: string;
  skills?: string[];
  status: AgentStatus;
  /** Last successful handshake / heartbeat. */
  lastSeen: string;
  /** Negotiation completeness 0..1 learned from prior tasks. */
  reputation?: number;
  source: "registry" | "seed" | "inbound";
}

export type TaskStatus =
  | "discovered"
  | "negotiating"
  | "accepted"
  | "in_progress"
  | "completed"
  | "settled"
  | "rejected"
  | "failed";

export type PricingDecision = "accept" | "bargain" | "reject";

export interface TaskQuote {
  quoteId: string;
  taskId: string;
  peerId: string;
  peerUrl: string;
  title: string;
  description: string;
  /** What the requesting agent offers to pay, in USD. */
  offeredPayout: number;
  /** HyperAgent's own estimate of fair market value, in USD. */
  estimatedValue: number;
  /** HyperAgent's counter-offer / asking price in USD. */
  askingPrice: number;
  currency: string;
  round: number;
  decision: PricingDecision;
  rationale?: string;
  createdAt: string;
}

export interface Negotiation {
  id: string;
  taskId: string;
  peerId: string;
  peerUrl: string;
  title: string;
  description: string;
  status: "open" | "accepted" | "rejected" | "expired";
  round: number;
  offeredPayout: number;
  askingPrice: number;
  estimatedValue: number;
  history: Array<{
    round: number;
    actor: "peer" | "self";
    amount: number;
    note?: string;
    at: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface A2ATask {
  id: string;
  title: string;
  description: string;
  peerId: string;
  peerUrl: string;
  payout: number;
  currency: string;
  status: TaskStatus;
  /** The actual work payload: prompt, code, JSON or data handed to the executor. */
  input?: TaskInput;
  negotiationId?: string;
  acceptedAt?: string;
  completedAt?: string;
  settledAt?: string;
  /** Whop identifier of the credit/payment once settled. */
  whopPaymentId?: string;
  /** Real executor output (never a placeholder — see agent/execution.ts). */
  result?: string;
  /** How the result was produced, for auditability. */
  execution?: TaskExecutionMeta;
  createdAt: string;
  updatedAt: string;
}

/** A unit of work an agent is asked to perform. */
export interface TaskInput {
  /**
   * Task modality. Drives the executor's system instruction:
   * text = written answer, code = runnable code, json = structured data,
   * reasoning = step-by-step analysis.
   */
  kind: "text" | "code" | "json" | "reasoning";
  /** The primary instruction / question / problem statement. */
  prompt: string;
  /** Optional supporting material (source text, data, existing code). */
  context?: string;
  /** Output language for code tasks (e.g. "typescript", "python"). */
  language?: string;
}

export interface TaskExecutionMeta {
  /** Which engine produced the result. */
  source: "gemini" | "deterministic";
  /** Gemini model that answered, when applicable. */
  model?: string;
  tokens?: number;
  /** Why the deterministic fallback was used, when it was. */
  reason?: string;
  /** True when Gemini was configured but the call failed. */
  degraded?: boolean;
  at: string;
}

export type LedgerEntryType =
  | "credit"
  | "debit"
  | "payout"
  | "webhook_credit"
  | "webhook_debit"
  | "adjustment";

export interface LedgerEntry {
  id: string;
  agentId: string;
  type: LedgerEntryType;
  amount: number;
  currency: string;
  taskId?: string;
  whopPaymentId?: string;
  memo?: string;
  at: string;
}

export interface WalletBalance {
  /** Equal to agentId; present so it fits the generic collection key. */
  id: string;
  agentId: string;
  available: number;
  currency: string;
  updatedAt: string;
}

/** Whop webhook payload, normalized across event types. */
export interface WhopWebhookEvent {
  id?: string;
  type: string;
  createdAt?: string;
  data: Record<string, unknown>;
}
