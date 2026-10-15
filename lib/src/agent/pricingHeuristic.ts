import { config } from "../config";

export interface ValuationInput {
  title: string;
  description: string;
  offeredPayout: number;
}

export interface ValuationResult {
  estimatedValue: number;
  askingPrice: number;
  complexity: number;
  rationale: string;
  source: "gemini" | "heuristic";
}

/**
 * Deterministic fallback valuation.
 *
 * Used when Gemini is unavailable so a node can still price and negotiate.
 * Blends the peer's offer with a text-complexity signal and a cost floor.
 */
export function heuristicValuation(input: ValuationInput): ValuationResult {
  const text = `${input.title} ${input.description}`.toLowerCase();
  const words = text.split(/\s+/).filter(Boolean).length;

  // Complexity signals: long/high-effort work commands a higher price.
  const heavySignals = [
    "integration", "migration", "deploy", "refactor", "audit", "security",
    "machine learning", "training", "data pipeline", "24/7", "realtime",
    "real-time", "multi-agent", "blockchain", "compliance",
  ];
  const lightSignals = ["summary", "lookup", "format", "translation", "rename", "lint"];

  let complexity = 1;
  complexity += Math.min(2, words / 200);
  for (const s of heavySignals) if (text.includes(s)) complexity += 0.5;
  for (const s of lightSignals) if (text.includes(s)) complexity -= 0.15;
  complexity = Math.max(0.5, Math.min(5, complexity));

  const base = Math.max(config.pricing.minTaskPayout, config.pricing.unitRate * complexity);
  const fair = base * (1 + config.pricing.targetMarginPct / 100);
  const estimatedValue = round2(fair);

  return {
    estimatedValue,
    askingPrice: estimatedValue,
    complexity: round2(complexity),
    rationale: `Heuristic valuation: complexity ${round2(complexity)}x at a ${config.pricing.unitRate} unit rate with ${config.pricing.targetMarginPct}% margin (peer offered ${input.offeredPayout}).`,
    source: "heuristic",
  };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
