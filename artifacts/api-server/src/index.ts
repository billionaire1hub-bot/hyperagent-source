import {
  config,
  configWarnings,
  createLogger,
  gemini,
  whop,
  workerManager,
} from "hyperagent-lib";
import { createApp } from "./app";

const log = createLogger("boot");

/**
 * Process entrypoint (requirement 4).
 *
 * Starts the HTTP server *and* the autonomous background workers on boot, with
 * no manual trigger required. Crash guards and a graceful shutdown keep the
 * node running unattended on a 24/7 host.
 */
async function main() {
  const app = createApp();

  // Surface degraded integrations at boot. This never throws — every config
  // value has a fallback — it just tells the operator what is missing.
  for (const warning of configWarnings()) log.warn("config", { warning });

  const server = app.listen(config.server.port, config.server.host, async () => {
    log.info("http server listening", {
      url: `http://${config.server.host}:${config.server.port}`,
      agentId: config.agent.id,
      publicUrl: config.agent.publicUrl,
      platform: config.server.platform,
    });

    // Fail loud, not silent: an operator must be able to see at a glance
    // whether the paid integrations are actually wired. A node with no keys
    // still runs, but nothing external will move money or discover live peers.
    log.info("integration status", {
      gemini: gemini.configured ? "configured" : "MISSING GEMINI_API_KEY (heuristic pricing only)",
      whop: whop.configured ? "configured" : "MISSING WHOP_API_KEY (ledger-only settlement)",
      whopBaseUrl: config.whop.baseUrl,
      seedPeers: config.a2a.seedPeers.length,
      registryUrls: config.a2a.registryUrls.length,
      webhookSignatureRequired: config.whop.requireWebhookSignature,
    });
    if (gemini.configured) log.info("gemini reachable check", { ok: await gemini.ping() });
    if (whop.configured) log.info("whop balance at boot", { balance: await whop.getBalance() });

    // Kick off all background loops (discovery, acquisition, settlement,
    // heartbeat) as soon as the server is up. Always on — no manual trigger.
    // Skipped on Vercel: serverless functions are short-lived and cannot host a
    // 24/7 loop; there the same pipeline is driven by the /api/cron/tick
    // endpoint on a schedule (Vercel Cron or an external scheduler).
    if (process.env.VERCEL) {
      log.warn("vercel detected: background workers disabled in this entrypoint", {
        cronTick: config.cron.secret
          ? "enabled at GET /api/cron/tick (scheduled)"
          : "DISABLED — set CRON_SECRET to enable the scheduled tick",
        hint: "for a true 24/7 loop deploy on Railway/Render/Docker",
      });
    } else {
      workerManager.start();
    }
  });

  // ── Crash guards: log and keep serving ────────────────────────────────────
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled promise rejection", {
      error: reason instanceof Error ? reason.message : String(reason),
    });
  });

  process.on("uncaughtException", (err) => {
    log.error("uncaught exception", { error: err.message, stack: err.stack });
    // Do not exit: a 24/7 node must stay up. The error is isolated to one call.
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    log.info("shutdown signal received", { signal });
    try {
      await workerManager.stop();
    } catch (err) {
      log.warn("error stopping workers", { error: (err as Error).message });
    }
    server.close(() => {
      log.info("http server closed");
      process.exit(0);
    });
    // Force-exit if connections linger.
    setTimeout(() => process.exit(0), 10000).unref();
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

void main();
