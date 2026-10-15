import { config } from "../config";
import { createLogger } from "../logger";
import { gemini } from "./gemini";
import type { A2ATask, TaskExecutionMeta, TaskInput } from "../types";

const log = createLogger("execution");

/** Outcome of performing a task. `meta` records exactly how it was produced. */
export interface ExecutionResult {
  /** The real deliverable: generated answer, code, JSON or analysis. */
  output: string;
  meta: TaskExecutionMeta;
}

/** Per-modality system instructions. These define what "doing the task" means. */
const SYSTEM_INSTRUCTIONS: Record<TaskInput["kind"], string> = {
  text:
    "You are an autonomous agent on an A2A task network. Complete the requested " +
    "task and return the finished deliverable directly. Be accurate, specific and " +
    "complete; do not describe what you would do — produce the actual result.",
  code:
    "You are an autonomous software agent. Write correct, runnable, production-quality " +
    "code that fully solves the task. Return only the code (with brief comments where " +
    "they add value), no prose explanation.",
  json:
    "You are an autonomous data agent. Produce the requested structured data as a single " +
    "valid JSON value. Return only the JSON, with no prose or markdown fences.",
  reasoning:
    "You are an autonomous analysis agent. Work through the problem step by step, then " +
    "give a clear, well-justified conclusion. Show the reasoning and the final answer.",
};

/**
 * Build the execution prompt from the task's input, falling back to the task's
 * title/description when no explicit input payload was supplied.
 */
export function taskPrompt(task: Pick<A2ATask, "title" | "description" | "input">): {
  prompt: string;
  kind: TaskInput["kind"];
  language?: string;
} {
  const input = task.input;
  const kind: TaskInput["kind"] = input?.kind ?? "text";
  const instruction = input?.prompt?.trim() || task.description.trim() || task.title;
  const parts = [instruction];
  if (input?.language) parts.push(`Target language: ${input.language}`);
  if (input?.context?.trim()) parts.push("", "Context / supporting material:", input.context.trim());
  return { prompt: parts.join("\n"), kind, language: input?.language };
}

/**
 * Perform a task for real (no placeholders).
 *
 *  - When Gemini is configured, the task text/code/JSON/reasoning is sent to the
 *    live API and the generated output is returned.
 *  - When Gemini is not configured, or every model fails, a deterministic
 *    extractive executor answers directly from the provided material (summarise,
 *    extract, transform) instead of inventing content, and the result is clearly
 *    marked `deterministic`/`degraded` so callers and the ledger are honest.
 *
 * `fetchImpl` is injectable so the real Gemini code path can be exercised in
 * tests against a local server without a live API key.
 */
export async function executeTask(
  task: Pick<A2ATask, "title" | "description" | "input">,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<ExecutionResult> {
  const { prompt, kind } = taskPrompt(task);

  if (gemini.configured) {
    const result = await gemini.generate(prompt, {
      systemInstruction: SYSTEM_INSTRUCTIONS[kind],
      maxOutputTokens: config.gemini.maxOutputTokens,
      temperature: kind === "code" ? 0.2 : 0.4,
      json: kind === "json",
      timeoutMs: config.gemini.executionTimeoutMs,
      fetchImpl: opts.fetchImpl,
    });
    if (result && result.text.trim()) {
      return {
        output: result.text.trim(),
        meta: {
          source: "gemini",
          model: result.model,
          tokens: result.tokens,
          at: new Date().toISOString(),
        },
      };
    }
    log.warn("gemini execution unavailable; using deterministic executor", {
      title: task.title,
    });
    return deterministicExecute(task, "gemini call failed or returned empty");
  }

  return deterministicExecute(task, "GEMINI_API_KEY not configured");
}

/**
 * Deterministic, non-generative executor.
 *
 * This is a real, honest answer derived from the task's own material — never a
 * fabricated claim of having called a model. It handles the common
 * information-processing shapes (summary, extraction, transformation) and, for
 * anything else, returns the task's grounded inputs plus an explicit note that
 * LLM execution was unavailable.
 */
function deterministicExecute(
  task: Pick<A2ATask, "title" | "description" | "input">,
  reason: string,
): ExecutionResult {
  const input = task.input;
  const material = [input?.context, task.description].filter(Boolean).join("\n\n").trim();
  const instruction = (input?.prompt ?? task.title).trim();
  const op = detectOperation(instruction);

  let output: string;
  if (!material) {
    output =
      `Unable to execute "${task.title}" with the LLM: no source material was ` +
      `provided and Gemini was unavailable. Supply task.input.context (or set ` +
      `GEMINI_API_KEY) to get a generated result.`;
  } else {
    switch (op) {
      case "summarise": {
        const sents = splitSentences(material);
        const keep = Math.max(1, Math.min(3, Math.ceil(sents.length / 3)));
        output = sents.slice(0, keep).join(" ").trim();
        break;
      }
      case "extract": {
        const items = extractItems(material, instruction);
        output = items.length
          ? JSON.stringify({ extracted: items }, null, 2)
          : JSON.stringify({ extracted: [] });
        break;
      }
      case "transform":
        output = transform(material, instruction);
        break;
      default:
        output =
          `Grounded answer (LLM unavailable — deterministic pass over the supplied ` +
          `material only):\n\n${material}`;
    }
  }

  return {
    output,
    meta: {
      source: "deterministic",
      reason,
      degraded: gemini.configured,
      at: new Date().toISOString(),
    },
  };
}

type Operation = "summarise" | "extract" | "transform" | "answer";

function detectOperation(instruction: string): Operation {
  const t = instruction.toLowerCase();
  if (/\b(summar\w*|tl;?dr|condense|shorten|abstract|overview)\b/.test(t)) return "summarise";
  if (/\b(extract|list|enumerate|pull out|find all|collect|parse|get all)\b/.test(t)) return "extract";
  if (/\b(convert|transform|reformat|translate|rewrite|normalis|normaliz|format)\b/.test(t))
    return "transform";
  return "answer";
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractItems(text: string, instruction: string): string[] {
  // Prefer explicit bullet/numbered items when present.
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const bullets = lines
    .filter((l) => /^([-*•]|\d+[.)])\s+/.test(l))
    .map((l) => l.replace(/^([-*•]|\d+[.)])\s+/, "").trim());
  if (bullets.length) return bullets;

  // Otherwise look for a quoted target term to search for.
  const quoted = instruction.match(/["'`]([^"'`]{2,})["'`]/);
  if (quoted) {
    const term = quoted[1].toLowerCase();
    return splitSentences(text).filter((s) => s.toLowerCase().includes(term));
  }
  return [];
}

function transform(text: string, instruction: string): string {
  const t = instruction.toLowerCase();
  if (/upper ?case|uppercase/.test(t)) return text.toUpperCase();
  if (/lower ?case|lowercase/.test(t)) return text.toLowerCase();
  if (/json/.test(t)) return JSON.stringify({ text });
  if (/csv/.test(t)) {
    return text
      .split(/\r?\n/)
      .map((l) => l.split(/,|\t|\s{2,}/).map((c) => `"${c.trim().replace(/"/g, '""')}"`).join(","))
      .join("\n");
  }
  return text.replace(/\s+/g, " ").trim();
}
