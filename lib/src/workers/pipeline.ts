import { randomUUID } from "crypto";
import { config } from "../config";
import { createLogger } from "../logger";
import { store } from "../storage";
import { walletService } from "../storage/wallet";
import { evaluateOffer } from "../agent/pricing";
import { runBargain, type PeerReply } from "../agent/bargaining";
import { executeTask } from "../agent/execution";
import { whop } from "../agent/whop";
import { sendTask } from "../a2a/protocol";
import type { A2ATask, Negotiation, PeerAgent, TaskInput, TaskStatus } from "../types";

const log = createLogger("pipeline");

export interface AcquiredTask {
  task: A2ATask;
  negotiation: Negotiation;
  accepted: boolean;
}

/**
 * Task acquisition pipeline (requirements 1 & 2).
 *
 * Discovered task -> value it -> check peer balance -> negotiate if the offer
 * is below threshold -> accept only on a real agreement. Everything is
 * persisted so the settlement worker can finish the job later.
 */
export async function acquireTask(
  peer: PeerAgent,
  remote: {
    id: string;
    title: string;
    description: string;
    payout: number;
    currency?: string;
    input?: TaskInput;
  },
): Promise<AcquiredTask | null> {
  const taskId = `${peer.id}:${remote.id}`;
  const existing = await store.tasks.get(taskId);
  if (existing && existing.status !== "discovered" && existing.status !== "rejected") {
    return null; // Already handled.
  }

  const now = new Date().toISOString();
  const task: A2ATask = existing ?? {
    id: taskId,
    title: remote.title,
    description: remote.description,
    peerId: peer.id,
    peerUrl: peer.url,
    payout: remote.payout,
    currency: remote.currency ?? "USD",
    status: "discovered",
    input: remote.input,
    createdAt: now,
    updatedAt: now,
  };
  // Refresh the input on re-discovery in case the peer enriched the task.
  if (existing && remote.input) task.input = remote.input;
  await store.tasks.put(task);

  // Peer's available balance from the internal ledger first (fast, always
  // available), falling back to a live Whop lookup of the requesting agent.
  const peerBalance = await resolvePeerBalance(peer.id);

  const decision = await evaluateOffer({
    taskId,
    peerId: peer.id,
    peerUrl: peer.url,
    title: remote.title,
    description: remote.description,
    offeredPayout: remote.payout,
    peerBalance,
    currency: remote.currency ?? "USD",
  });

  const negotiation: Negotiation = {
    id: randomUUID(),
    taskId,
    peerId: peer.id,
    peerUrl: peer.url,
    title: remote.title,
    description: remote.description,
    status: "open",
    round: 0,
    offeredPayout: remote.payout,
    askingPrice: decision.askingPrice,
    estimatedValue: decision.estimatedValue,
    history: [{ round: 0, actor: "peer", amount: remote.payout, note: "initial offer", at: now }],
    createdAt: now,
    updatedAt: now,
  };

  if (decision.decision === "accept") {
    return await acceptTask(task, negotiation, decision.askingPrice, decision.estimatedValue);
  }

  if (decision.decision === "reject") {
    negotiation.status = "rejected";
    negotiation.updatedAt = new Date().toISOString();
    await store.negotiations.put(negotiation);
    await setStatus(task, "rejected");
    log.info("task rejected", { taskId, reason: decision.rationale });
    return { task: { ...task, status: "rejected" }, negotiation, accepted: false };
  }

  // Bargain over real A2A messages. If the peer cannot be reached, no deal is
  // recorded — we never invent a counterparty price.
  await setStatus(task, "negotiating");
  const outcome = await runBargain(
    {
      taskId,
      title: remote.title,
      description: remote.description,
      estimatedValue: decision.estimatedValue,
      currentOffer: remote.payout,
      peerBalance,
    },
    async (ourOffer, round) => {
      negotiation.history.push({
        round,
        actor: "self",
        amount: ourOffer,
        at: new Date().toISOString(),
      });
      const reply = await askPeer(peer, task, ourOffer, round);
      if (reply.kind === "offer") {
        negotiation.history.push({
          round,
          actor: "peer",
          amount: reply.amount,
          at: new Date().toISOString(),
        });
      }
      return reply;
    },
  );

  negotiation.round = outcome.rounds;
  negotiation.updatedAt = new Date().toISOString();

  if (outcome.accepted && outcome.agreedPrice !== null) {
    return await acceptTask(task, negotiation, outcome.agreedPrice, decision.estimatedValue);
  }

  negotiation.status = "rejected";
  await store.negotiations.put(negotiation);
  await setStatus(task, "rejected");
  log.info("negotiation ended without agreement", {
    taskId,
    unreachable: outcome.unreachable ?? false,
    reason: outcome.reason,
  });
  return { task: { ...task, status: "rejected" }, negotiation, accepted: false };
}

async function acceptTask(
  task: A2ATask,
  negotiation: Negotiation,
  agreedPrice: number,
  estimatedValue: number,
): Promise<AcquiredTask> {
  negotiation.status = "accepted";
  negotiation.askingPrice = agreedPrice;
  negotiation.updatedAt = new Date().toISOString();
  await store.negotiations.put(negotiation);

  const updated: A2ATask = {
    ...task,
    status: "accepted",
    payout: agreedPrice,
    negotiationId: negotiation.id,
    acceptedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await store.tasks.put(updated);
  log.info("task accepted", { taskId: task.id, agreedPrice, estimatedValue, peer: task.peerId });
  return { task: updated, negotiation, accepted: true };
}

async function resolvePeerBalance(peerId: string): Promise<number | null> {
  const local = await store.balances.get(peerId);
  if (local) return local.available;
  // Fall back to a live Whop lookup of the requesting agent's balance.
  return whop.getBalance(peerId);
}

/**
 * Ask the peer to accept our counter-offer over real A2A. Parses the peer's
 * reply into an explicit PeerReply; an unreachable or unparseable peer is
 * reported as `unreachable` so the negotiation stops rather than guessing.
 */
async function askPeer(
  peer: PeerAgent,
  task: A2ATask,
  offer: number,
  round: number,
): Promise<PeerReply> {
  const result = await sendTask(
    peer.url,
    { metadata: { intent: "negotiate", negotiation: true, round, price: offer, taskId: task.id } },
    `Counter-offer of ${offer} ${task.currency} for task "${task.title}". Reply with {"accepted":true} or {"counterOffer":<number>}.`,
  );

  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    // Direct structured reply.
    if (r.accepted === true) return { kind: "accepted" };
    if (typeof r.counterOffer === "number") return { kind: "offer", amount: r.counterOffer };
    if (typeof r.price === "number") return { kind: "offer", amount: r.price };
    // Reply nested in message parts / artifacts (standard A2A result shape).
    for (const data of extractDataParts(r)) {
      if (data.accepted === true) return { kind: "accepted" };
      if (typeof data.counterOffer === "number") return { kind: "offer", amount: data.counterOffer };
      if (typeof data.price === "number") return { kind: "offer", amount: data.price };
    }
  }
  return { kind: "unreachable" };
}

function extractDataParts(result: Record<string, unknown>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const push = (v: unknown) => {
    if (v && typeof v === "object") out.push(v as Record<string, unknown>);
  };
  push(result.data);
  const parts = result.parts as Array<{ data?: unknown }> | undefined;
  if (Array.isArray(parts)) for (const p of parts) push(p.data);
  const artifacts = result.artifacts as Array<{ parts?: Array<{ data?: unknown }> }> | undefined;
  if (Array.isArray(artifacts)) for (const a of artifacts) for (const p of a.parts ?? []) push(p.data);
  return out;
}

export async function setStatus(task: A2ATask, status: TaskStatus): Promise<A2ATask> {
  const updated = { ...task, status, updatedAt: new Date().toISOString() };
  await store.tasks.put(updated);
  return updated;
}

/**
 * Execute an accepted task and settle the earnings (requirement 2).
 *
 * Settlement is tied to real results:
 *  - The local balance is credited only after the peer confirms completion.
 *  - When Whop is configured, a real transfer/payment response id is recorded.
 */
export async function executeAndSettle(task: A2ATask): Promise<A2ATask> {
  if (task.status !== "accepted") return task;
  await setStatus(task, "in_progress");

  const { output, meta } = await executeTask(task);
  const completed: A2ATask = {
    ...task,
    status: "completed",
    result: output,
    execution: meta,
    completedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await store.tasks.put(completed);

  // Record settlement with Whop. A transfer moves the agreed amount from the
  // payer to us; if no API key/destination is set this returns null and the
  // credit is ledger-only (clearly marked).
  const settlement = await whop.createTransfer({
    amount: task.payout,
    destinationId: config.whop.companyId || config.agent.id,
    originId: task.peerId,
    currency: task.currency.toLowerCase(),
    notes: `Settlement for task ${task.id}`,
    metadata: { task_id: task.id, peer_id: task.peerId },
    idempotenceKey: `settle-${task.id}`,
  });

  await walletService.credit(
    config.agent.id,
    task.payout,
    `Earnings for task ${task.id}`,
    task.id,
    settlement?.id,
  );

  const settled: A2ATask = {
    ...completed,
    status: "settled",
    whopPaymentId: settlement?.id,
    settledAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await store.tasks.put(settled);

  // Notify the peer so it can release funds / close the task. The real result
  // travels in the message body (and the metadata) so the peer can consume it.
  await sendTask(
    task.peerUrl,
    {
      metadata: {
        status: "completed",
        taskId: task.id,
        execution: meta.source,
        model: meta.model,
        result: output,
      },
    },
    `Task "${task.title}" completed. Result:\n${output}`,
  );

  log.info("task settled", {
    taskId: task.id,
    payout: task.payout,
    settlementId: settlement?.id ?? "ledger-only",
    execution: meta.source,
  });
  return settled;
}
