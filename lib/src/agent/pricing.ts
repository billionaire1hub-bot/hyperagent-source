import { randomUUID } from "crypto";
import { config } from "../config";
import { createLogger } from "../logger";
import { gemini } from "./gemini";
import {
  heuristicValuation,
  round2,
  type ValuationInput,
  type ValuationResult,
} from "./pricingHeuristic";
import type { PricingDecision, TaskQuote } from "../types";

const log = createLogger("pricing");

interface GeminiValuation {
  estimatedValue?: number;
  complexity?: number;
  rationale?: string;
}

/** Estimate fair market value of a task, preferring Gemini, falling back to heuristic. */
export async function estimateTaskValue(
  input: ValuationInput,
): Promise<ValuationResult> {
  const fallback = heuristicValuation(input);
  if (!gemini.configured) return fallback;

  const prompt = [
    "You are the pricing engine of an autonomous agent on an A2A task network.",
    "Estimate the fair USD market value of performing the following task, and",
    "return a proposed asking price that includes a healthy margin.",
    "",
    `Title: ${input.title}`,
    `Description: ${input.description}`,
    `Peer offered: ${input.offeredPayout} USD`,
    `Our minimum acceptable payout: ${config.pricing.minTaskPayout} USD`,
    `Target margin: ${config.pricing.targetMarginPct}%`,
    "",
    "Respond with ONLY compact JSON:",
    '{"estimatedValue": <number>, "complexity": <number 0.5-5>, "rationale": <string>}',
  ].join("\n");

  const parsed = await gemini.generateJson<GeminiValuation>(prompt, "json");
  if (
    !parsed ||
    typeof parsed.estimatedValue !== "number" ||
    !Number.isFinite(parsed.estimatedValue)
  ) {
    log.debug("gemini valuation unusable, using heuristic");
    return fallback;
  }

  const estimatedValue = Math.max(
    config.pricing.minTaskPayout,
    round2(parsed.estimatedValue),
  );
  return {
    estimatedValue,
    askingPrice: estimatedValue,
    complexity:
      typeof parsed.complexity === "number" ? round2(parsed.complexity) : fallback.complexity,
    rationale: parsed.rationale || "Gemini valuation.",
    source: "gemini",
  };
}

export interface PriceDecisionInput {
  taskId: string;
  peerId: string;
  peerUrl: string;
  title: string;
  description: string;
  offeredPayout: number;
  /** Peer's available balance if known (Whop / ledger), else null. */
  peerBalance: number | null;
  round?: number;
  currency?: string;
}

export interface PriceDecisionResult {
  decision: PricingDecision;
  estimatedValue: number;
  askingPrice: number;
  rationale: string;
  source: "gemini" | "heuristic";
  quote: TaskQuote;
}

/**
 * Core pricing gateway (requirement 2).
 *
 * 1. Value the task (Gemini, else heuristic).
 * 2. Check the requesting agent's available balance.
 * 3. Accept when terms are met, otherwise return a counter-offer for bargaining.
 */
export async function evaluateOffer(
  input: PriceDecisionInput,
): Promise<PriceDecisionResult> {
  const valuation = await estimateTaskValue({
    title: input.title,
    description: input.description,
    offeredPayout: input.offeredPayout,
  });

  const round = input.round ?? 0;
  const target = valuation.estimatedValue;
  const floor = round2(config.pricing.minTaskPayout);

  // A balance below what is offered makes the offer non-credible; below the
  // absolute floor it cannot be salvaged by negotiation.
  const balance = input.peerBalance;
  const balanceCap = balance === null ? Infinity : balance;
  const effectiveOffer = round2(Math.min(input.offeredPayout, balanceCap));

  let decision: PricingDecision;
  let rationale: string;

  if (balance !== null && balance < floor) {
    decision = "reject";
    rationale = `Peer balance ${balance} is below the ${floor} minimum payout.`;
  } else if (effectiveOffer >= target) {
    decision = "accept";
    rationale = `Offer ${effectiveOffer} meets target value ${target}.`;
  } else if (effectiveOffer >= floor) {
    decision = "bargain";
    rationale = `Offer ${effectiveOffer} is below target ${target}; countering.`;
  } else {
    decision = "reject";
    rationale = `Offer ${effectiveOffer} is below the ${floor} minimum payout.`;
  }

  // Counter-offer bounded below by the target and above by what the peer can pay.
  const upperBound = round2(Math.min(
    target * config.pricing.maxCounterMultiplier,
    balanceCap === Infinity ? target * config.pricing.maxCounterMultiplier : Math.max(target, balanceCap),
  ));
  let askingPrice = round2(Math.max(target, effectiveOffer));
  askingPrice = round2(
    Math.min(
      Math.max(askingPrice, round2(effectiveOffer * 1.1)),
      upperBound,
    ),
  );
  if (balance !== null) {
    askingPrice = round2(Math.min(askingPrice, Math.max(floor, balance)));
  }

  const quote: TaskQuote = {
    quoteId: randomUUID(),
    taskId: input.taskId,
    peerId: input.peerId,
    peerUrl: input.peerUrl,
    title: input.title,
    description: input.description,
    offeredPayout: round2(input.offeredPayout),
    estimatedValue: target,
    askingPrice,
    currency: input.currency ?? "USD",
    round,
    decision,
    rationale,
    createdAt: new Date().toISOString(),
  };

  log.info("price decision", {
    taskId: input.taskId,
    peerId: input.peerId,
    decision,
    offered: effectiveOffer,
    target,
    asking: askingPrice,
    source: valuation.source,
  });

  return {
    decision,
    estimatedValue: target,
    askingPrice,
    rationale,
    source: valuation.source,
    quote,
  };
}
