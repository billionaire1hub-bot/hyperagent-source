import { timingSafeEqual } from "crypto";
import { Router, type Request, type Response } from "express";
import { config, createLogger, runPipelineCycle, workerManager } from "hyperagent-lib";

const log = createLogger("route:cron");
export const cronRouter = Router();

/** Constant-time comparison so the secret cannot be guessed by timing. */
function secretMatches(provided: string): boolean {
  const expected = config.cron.secret;
  if (!expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Autonomous tick for serverless hosts (requirement 1 & 4 on Vercel).
 *
 * A serverless function cannot hold the infinite discovery/acquisition loops, so
 * Vercel Cron (or any external scheduler) calls this endpoint on a schedule and
 * it runs the *same* pipeline the in-process loops run — discovery, handshake,
 * task polling, Gemini pricing/bargaining, acceptance and settlement.
 *
 * Security: Vercel sends `Authorization: Bearer $CRON_SECRET`. The secret is
 * required; without it the endpoint is disabled (503) so it can never be an
 * open trigger. `CRON_ALLOW_UNAUTHENTICATED=true` opts out for local testing.
 *
 * Idempotent by design: re-runs are safe, and every phase is isolated so one
 * failure never stops the others or crashes the function.
 */
cronRouter.get("/tick", async (req: Request, res: Response) => {
  const header = req.header("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (config.cron.secret) {
    if (!secretMatches(provided)) {
      log.warn("rejected unauthorized cron tick");
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
  } else if (!config.cron.allowUnauthenticated) {
    log.warn("cron tick called but CRON_SECRET is not configured; disabled");
    return res.status(503).json({
      ok: false,
      error: "cron disabled",
      detail: "set CRON_SECRET to enable the scheduled autonomous tick",
    });
  }

  const cycles = Math.max(1, Math.min(config.cron.cycles, config.cron.maxCycles));
  const startedAt = Date.now();
  const deadline = startedAt + config.cron.tickBudgetMs;
  const runs = [];
  for (let i = 0; i < cycles; i++) {
    // Stop early if a previous cycle already spent the tick's wall-clock budget.
    if (i > 0 && Date.now() >= deadline) {
      log.warn("cron tick budget reached; skipping remaining cycles", { cycles, done: i });
      break;
    }
    try {
      runs.push(await runPipelineCycle({ deadline }));
    } catch (err) {
      // runPipelineCycle already isolates phases; this is a belt-and-braces guard.
      log.error("cron tick cycle threw", { error: (err as Error).message });
      runs.push({ error: (err as Error).message });
    }
  }

  const summary = {
    ok: true,
    cycles,
    cyclesRun: runs.length,
    durationMs: Date.now() - startedAt,
    budgetMs: config.cron.tickBudgetMs,
    budgetExceeded: runs.some((r) => "budgetExceeded" in r && r.budgetExceeded),
    workerLoopsActive: workerManager.status().started,
    runs,
  };
  log.info("cron tick complete", {
    cycles,
    durationMs: summary.durationMs,
    acquired: runs.reduce((n, r) => n + (("tasksAcquired" in r && r.tasksAcquired) || 0), 0),
  });
  return res.status(200).json(summary);
});

/** Liveness/self-description for the cron surface. */
cronRouter.get("/", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    tickEndpoint: "/api/cron/tick",
    configured: Boolean(config.cron.secret) || config.cron.allowUnauthenticated,
    cycles: config.cron.cycles,
    workerLoopsActive: workerManager.status().started,
  });
});
