import { config } from "../config";
import { createLogger } from "../logger";
import { gemini } from "./gemini";
import { round2 } from "./pricingHeuristic";

const log = createLogger("bargain");

export interface BargainContext {
  taskId: string;
  title: string;
  description: string;
  /** Our fair-value estimate. */
  estimatedValue: number;
  /** Current offer on the table. */
  currentOffer: number;
  /** Round number, 1-based. */
  round: number;
  /** Peer's available balance, when known. */
  peerBalance: number | null;
  history: Array<{ round: number; actor: "peer" | "self"; amount: number }>;
}

export interface BargainProposal {
  /** Price we counter with. */
  amount: number;
  /** Natural-language justification sent to the peer. */
  message: string;
  /** Whether we believe the peer will accept; used to decide to keep going. */
  shouldContinue: boolean;
  source: "gemini" | "heuristic";
}

interface GeminiProposal {
  amount?: number;
  message?: string;
  shouldContinue?: boolean;
}

/**
 * Generate our counter-offer (requirement 2).
 *
 * Concedes gradually across rounds toward the minimum acceptable payout while
 * never dropping below the floor or above what the peer can actually pay.
 */
export async function proposeCounter(ctx: BargainContext): Promise<BargainProposal> {
  const floor = round2(config.pricing.minTaskPayout);
  const ceiling =
    ctx.peerBalance === null
      ? round2(ctx.estimatedValue)
      : round2(Math.min(ctx.estimatedValue, Math.max(floor, ctx.peerBalance)));

  const fallback = heuristicCounter(ctx, floor, ceiling);
  if (!gemini.configured) return fallback;

  const historyText = ctx.history
    .map((h) => `  round ${h.round}: ${h.actor} offered ${h.amount}`)
    .join("\n");

  const prompt = [
    "You are the negotiation module of an autonomous agent selling task work on",
    "an A2A network. Propose a counter-offer that is fair to both parties and",
    "moves the deal toward agreement.",
    "",
    `Task: ${ctx.title}`,
    `Description: ${ctx.description}`,
    `Our fair-value estimate: ${ctx.estimatedValue} USD`,
    `Our minimum acceptable payout: ${floor} USD`,
    `Current peer offer: ${ctx.currentOffer} USD`,
    `Peer's available balance: ${ctx.peerBalance === null ? "unknown" : ctx.peerBalance + " USD"}`,
    `Round: ${ctx.round} of ${config.pricing.maxBargainRounds}`,
    "History:",
    historyText || "  (none)",
    "",
    "Constraints:",
    `- Counter must be between ${floor} and ${ceiling} USD.`,
    "- Concede more generously in later rounds to close the deal.",
    "- Keep the message concise, professional and persuasive.",
    "",
    "Respond with ONLY compact JSON:",
    '{"amount": <number>, "message": <string>, "shouldContinue": <boolean>}',
  ].join("\n");

  const parsed = await gemini.generateJson<GeminiProposal>(prompt, "json");
  if (!parsed || typeof parsed.amount !== "number" || !Number.isFinite(parsed.amount)) {
    log.debug("gemini proposal unusable, using heuristic");
    return fallback;
  }

  const amount = clamp(round2(parsed.amount), floor, ceiling);
  return {
    amount,
    message: parsed.message || fallback.message,
    shouldContinue:
      typeof parsed.shouldContinue === "boolean"
        ? parsed.shouldContinue
        : ctx.round < config.pricing.maxBargainRounds,
    source: "gemini",
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function heuristicCounter(
  ctx: BargainContext,
  floor: number,
  ceiling: number,
): BargainProposal {
  // Concede linearly from our estimate toward the floor as rounds progress.
  const progress = Math.min(1, ctx.round / Math.max(1, config.pricing.maxBargainRounds));
  const concession = config.pricing.minCounterFraction + progress * (1 - config.pricing.minCounterFraction);
  const target = ctx.currentOffer + (ctx.estimatedValue - ctx.currentOffer) * concession;
  const amount = clamp(round2(target), floor, ceiling);
  return {
    amount,
    message:
      `Thanks for the offer of ${ctx.currentOffer}. Given the scope of "${ctx.title}", ` +
      `we can deliver for ${amount} USD this round. Shall we proceed?`,
    shouldContinue: ctx.round < config.pricing.maxBargainRounds,
    source: "heuristic",
  };
}

export interface BargainOutcome {
  accepted: boolean;
  agreedPrice: number | null;
  rounds: number;
  reason: string;
  /** True when the peer could not be reached, so no agreement was possible. */
  unreachable?: boolean;
}

/** Result of asking the peer for its next position. */
export type PeerReply =
  | { kind: "accepted" }
  | { kind: "offer"; amount: number }
  | { kind: "unreachable" };

/**
 * Run the full bargaining loop against a real peer responder. The responder
 * performs the actual A2A exchange; it must return `unreachable` (never a
 * fabricated number) when the peer cannot be contacted, so we never settle a
 * price that the counterparty did not agree to.
 */
export async function runBargain(
  ctx: Omit<BargainContext, "round" | "history">,
  peerRespond: (offer: number, round: number) => Promise<PeerReply>,
): Promise<BargainOutcome> {
  const floor = round2(config.pricing.minTaskPayout);
  const history: BargainContext["history"] = [];
  let current = ctx.currentOffer;

  for (let round = 1; round <= config.pricing.maxBargainRounds; round++) {
    history.push({ round, actor: "peer", amount: current });

    const proposal = await proposeCounter({ ...ctx, currentOffer: current, round, history });
    history.push({ round, actor: "self", amount: proposal.amount });

    const reply = await peerRespond(proposal.amount, round);

    if (reply.kind === "unreachable") {
      return {
        accepted: false,
        agreedPrice: null,
        rounds: round,
        unreachable: true,
        reason: `Peer unreachable at round ${round}; no agreement possible.`,
      };
    }
    if (reply.kind === "accepted") {
      return {
        accepted: true,
        agreedPrice: proposal.amount,
        rounds: round,
        reason: "Peer accepted counter-offer.",
      };
    }

    const peerNext = reply.amount;
    if (peerNext >= proposal.amount) {
      return {
        accepted: true,
        agreedPrice: round2(peerNext),
        rounds: round,
        reason: "Peer met our asking price.",
      };
    }
    if (!proposal.shouldContinue || round === config.pricing.maxBargainRounds) {
      // Final position: accept only if it clears the floor, else walk away.
      if (peerNext >= floor && peerNext >= ctx.estimatedValue * 0.9) {
        return {
          accepted: true,
          agreedPrice: round2(peerNext),
          rounds: round,
          reason: "Accepted near-target offer on final round.",
        };
      }
      return {
        accepted: false,
        agreedPrice: null,
        rounds: round,
        reason: `No agreement after ${round} rounds; best offer ${peerNext} below threshold.`,
      };
    }
    current = peerNext;
  }

  return {
    accepted: false,
    agreedPrice: null,
    rounds: config.pricing.maxBargainRounds,
    reason: "Exhausted bargaining rounds.",
  };
}
