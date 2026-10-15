/**
 * Central configuration for a HyperAgent node.
 *
 * Everything is sourced from the environment so a single image can be deployed
 * to any 24/7 host and behave differently per node without code changes.
 */

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function csv(name: string, fallback: string[] = []): string[] {
  const parsed = str(name)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

/**
 * A discovery bootstrap mostly needs *somewhere* to look. When no operators or
 * registries are configured we fall back to the well-known A2A bootstrap
 * endpoints so discovery is never inert. Operators override these lists.
 */
const DEFAULT_SEED_PEERS = [
  "http://localhost:12000",
  "http://localhost:12001",
];

const AGENT_ID = str("AGENT_ID", `hyperagent-${Math.random().toString(36).slice(2, 8)}`);
const PORT = str("PORT", "12000");

/**
 * Resolve the URL peers use to reach us. Explicit config wins; otherwise we
 * infer it from the common free-tier host variables so a deployed node
 * advertises a reachable address instead of `localhost`.
 */
function resolvePublicUrl(): string {
  const explicit = str("AGENT_PUBLIC_URL") || str("PUBLIC_URL");
  if (explicit) return explicit.replace(/\/$/, "");
  const render = str("RENDER_EXTERNAL_URL");
  if (render) return render.replace(/\/$/, "");
  const railway = str("RAILWAY_PUBLIC_DOMAIN");
  if (railway) return `https://${railway.replace(/\/$/, "")}`;
  const fly = str("FLY_APP_NAME");
  if (fly) return `https://${fly}.fly.dev`;
  // Vercel injects the deployment host (no scheme) automatically. Prefer the
  // stable production URL over the per-deployment one when both are present.
  const vercel = str("VERCEL_PROJECT_PRODUCTION_URL") || str("VERCEL_URL");
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  return `http://localhost:${PORT}`;
}
const PUBLIC_URL = resolvePublicUrl();

/** Best-effort host detection, used only for logging and readiness hints. */
function detectPlatform(): string {
  if (process.env.VERCEL) return "vercel";
  if (process.env.RAILWAY_ENVIRONMENT) return "railway";
  if (process.env.RENDER) return "render";
  if (process.env.FLY_APP_NAME) return "fly";
  if (process.env.K_SERVICE) return "cloud-run";
  return "node";
}

export const config = {
  agent: {
    id: AGENT_ID,
    name: str("AGENT_NAME", "HyperAgent"),
    // Use the value resolved above so platform-injected hosts (Render, Railway,
    // Fly, Vercel) are actually advertised instead of a bare localhost URL.
    publicUrl: PUBLIC_URL,
    description: str(
      "AGENT_DESCRIPTION",
      "Autonomous A2A agent that discovers peers, negotiates task pricing and settles earnings over Whop.",
    ),
  },

  server: {
    port: num("PORT", 12000),
    host: str("HOST", "0.0.0.0"),
    /** Hosting platform detected from the environment (logging/readiness only). */
    platform: detectPlatform(),
  },

  gemini: {
    apiKey: str("GEMINI_API_KEY"),
    primaryModel: str("GEMINI_MODEL", "gemini-2.5-flash"),
    fallbackModels: csv("GEMINI_FALLBACK_MODELS"),
    timeoutMs: num("GEMINI_TIMEOUT_MS", 20000),
    /** Output budget for real task execution (pricing/bargaining use far less). */
    maxOutputTokens: num("GEMINI_MAX_OUTPUT_TOKENS", 8192),
    /** Wall-clock budget for a single task execution, ms. */
    executionTimeoutMs: num("GEMINI_EXECUTION_TIMEOUT_MS", 60000),
  },

  whop: {
    apiKey: str("WHOP_API_KEY"),
    /** Whop account id, prefixed `biz_`. */
    companyId: str("WHOP_COMPANY_ID"),
    baseUrl: str("WHOP_BASE_URL", "https://api.whop.com/api/v1"),
    /** Optional dated API version pin (Api-Version-Date header). */
    apiVersionDate: str("WHOP_API_VERSION_DATE"),
    webhookSecret: str("WHOP_WEBHOOK_SECRET"),
    requireWebhookSignature: bool("WHOP_WEBHOOK_REQUIRE_SIGNATURE", true),
    /** Reject webhooks whose timestamp is older than this (replay protection). */
    webhookToleranceSec: num("WHOP_WEBHOOK_TOLERANCE_SEC", 300),
    /** Destination account for payouts (user_/biz_/ldgr_). Defaults to our company. */
    payoutDestinationId: str("WHOP_PAYOUT_DESTINATION_ID"),
    timeoutMs: num("WHOP_TIMEOUT_MS", 15000),
  },

  a2a: {
    /**
     * Discovery is always enabled (requirement 1). There is deliberately no
     * "disabled" flag: the loops run for the life of the process. `enabled`
     * exists only so consumers can assert the invariant.
     */
    enabled: true as const,
    /**
     * Registry list. When the operator supplies none, we self-register against
     * our own Agent Card endpoint so a hosted node re-hydrates its peer set
     * after a restart (the peers we previously discovered are advertised there).
     */
    registryUrls: csv("A2A_REGISTRY_URLS", [PUBLIC_URL]),
    seedPeers: csv("A2A_SEED_PEERS", DEFAULT_SEED_PEERS),
    /** Real A2A well-known path (v0.3+); the legacy path is also served/probed. */
    agentCardPath: str("A2A_AGENT_CARD_PATH", "/.well-known/agent-card.json"),
    legacyAgentCardPath: "/.well-known/agent.json",
    /** Preferred protocol generation: "v1" (SendMessage) or "legacy" (message/send). */
    protocol: str("A2A_PROTOCOL", "v1"),
    /** Optional bearer token presented to secured peers. */
    authToken: str("A2A_AUTH_TOKEN"),
    /** Optional bearer token required from inbound peers (empty = open). */
    inboundAuthToken: str("A2A_INBOUND_AUTH_TOKEN"),
    discoveryIntervalMs: num("A2A_DISCOVERY_INTERVAL_MS", 60000),
    handshakeTimeoutMs: num("A2A_HANDSHAKE_TIMEOUT_MS", 8000),
    protocolVersion: "1.0.0",
    legacyProtocolVersion: "0.2.0",
  },

  pricing: {
    minTaskPayout: num("MIN_TASK_PAYOUT", 5),
    /** Base USD value of a unit-complexity task. */
    unitRate: num("TASK_UNIT_RATE", 10),
    targetMarginPct: num("TARGET_MARGIN_PCT", 25),
    maxBargainRounds: num("MAX_BARGAIN_ROUNDS", 4),
    minCounterFraction: num("MIN_COUNTER_FRACTION", 0.6),
    maxCounterMultiplier: num("MAX_COUNTER_MULTIPLIER", 3),
  },

  workers: {
    errorBackoffMs: num("WORKER_ERROR_BACKOFF_MS", 5000),
    maxBackoffMs: num("WORKER_MAX_BACKOFF_MS", 300000),
    /** How often accepted tasks are executed and settled. */
    settlementIntervalMs: num("SETTLEMENT_INTERVAL_MS", 15000),
    /**
     * The autonomous pipeline always starts on boot (requirement 4). This is a
     * constant, not an env toggle, so no missing/misset variable can leave a
     * deployed container idle.
     */
    startOnBoot: true as const,
  },

  /**
   * Serverless tick (Vercel). A serverless function cannot hold an infinite
   * loop, so on Vercel the same pipeline is driven by a scheduled GET to
   * `/api/cron/tick` (Vercel Cron, or any external scheduler). On a long-lived
   * host the in-process loops run instead and the tick is a no-op.
   */
  cron: {
    /** Shared secret Vercel sends as `Authorization: Bearer <CRON_SECRET>`. */
    secret: str("CRON_SECRET"),
    /** Pipeline cycles executed per tick (raise on low-frequency schedules). */
    cycles: num("CRON_CYCLES", 1),
    /** Hard cap so a tick can never run away. */
    maxCycles: num("CRON_MAX_CYCLES", 20),
    /** Only for local/dev: accept an unauthenticated tick when no secret is set. */
    allowUnauthenticated: bool("CRON_ALLOW_UNAUTHENTICATED", false),
    /**
     * Wall-clock budget for one tick. Real task execution is slow, so the tick
     * stops settling and defers the rest (they stay `accepted`) rather than
     * overrunning the serverless function limit. Must be under the function
     * maxDuration (see vercel.json).
     */
    tickBudgetMs: num("CRON_TICK_BUDGET_MS", 240000),
  },

  storage: {
    // Vercel's filesystem is read-only except /tmp, so default there on Vercel
    // to avoid write-error noise; the store still degrades to in-memory safely.
    dataDir: str("DATA_DIR", process.env.VERCEL ? "/tmp/hyperagent-data" : "data"),
  },

  logLevel: str("LOG_LEVEL", "info"),
} as const;

export type AppConfig = typeof config;

/**
 * Non-fatal configuration validation.
 *
 * Every value above already has a safe fallback, so a missing variable can never
 * crash the process (important on serverless where env vars are easy to forget).
 * These warnings surface *degraded* integrations — a node that boots but cannot
 * move money or reach the LLM — so an operator can see why nothing happens
 * instead of guessing. Returns [] when everything needed is present.
 */
export function configWarnings(): string[] {
  const warnings: string[] = [];
  if (!config.gemini.apiKey) {
    warnings.push(
      "GEMINI_API_KEY is not set: pricing/bargaining falls back to the heuristic, and " +
        "tasks are executed by the deterministic extractive executor instead of the LLM.",
    );
  }
  if (!config.whop.apiKey) {
    warnings.push("WHOP_API_KEY is not set: settlement uses the internal ledger only.");
  }
  if (!config.whop.companyId) {
    warnings.push("WHOP_COMPANY_ID is not set: live Whop balance lookups are disabled.");
  }
  if (config.whop.requireWebhookSignature && !config.whop.webhookSecret) {
    warnings.push(
      "WHOP_WEBHOOK_SECRET is not set while signature verification is required: " +
        "all Whop webhooks will be rejected with 401. Set the secret or set " +
        "WHOP_WEBHOOK_REQUIRE_SIGNATURE=false to accept unsigned events.",
    );
  }
  if (config.a2a.registryUrls.some((u) => /localhost|127\.0\.0\.1/.test(u))) {
    warnings.push(
      "No external A2A registry/seed configured: discovery only reaches localhost " +
        "peers. Set A2A_REGISTRY_URLS or A2A_SEED_PEERS to discover agents globally.",
    );
  }
  if (process.env.VERCEL && !config.cron.secret) {
    warnings.push(
      "CRON_SECRET is not set: the /api/cron/tick endpoint that drives the autonomous " +
        "pipeline on Vercel is disabled (it would be callable by anyone). Set CRON_SECRET " +
        "to enable the scheduled tick.",
    );
  }
  if (config.cron.cycles > config.cron.maxCycles) {
    warnings.push(
      `CRON_CYCLES (${config.cron.cycles}) exceeds CRON_MAX_CYCLES ` +
        `(${config.cron.maxCycles}); it will be capped at runtime.`,
    );
  }
  return warnings;
}
