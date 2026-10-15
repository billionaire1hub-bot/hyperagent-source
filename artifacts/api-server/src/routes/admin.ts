import { Router, type Request, type Response } from "express";
import {
  config,
  configWarnings,
  gemini,
  store,
  walletService,
  whop,
  workerManager,
  type A2ATask,
  type LoopStatus,
  type PeerAgent,
  type TaskInput,
} from "hyperagent-lib";

export const adminRouter = Router();

/**
 * Serverless platforms (Vercel) serve HTTP only — the 24/7 workers are not
 * started there, so readiness must not depend on them. On a long-lived host the
 * workers are expected and their health gates readiness.
 */
const workersExpected = !process.env.VERCEL;

/** Liveness probe. Always 200 while the process is up. */
adminRouter.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    agentId: config.agent.id,
    uptimeSec: Math.round(process.uptime()),
    workers: workerManager.status().started,
  });
});

/**
 * Readiness probe for 24/7 platforms: 503 until the autonomous workers are
 * actually running, so an orchestrator can restart a node whose loops died.
 * On serverless (Vercel) the HTTP surface is the whole service, so it is ready
 * as soon as it responds.
 */
adminRouter.get("/ready", (_req: Request, res: Response) => {
  const status = workerManager.status();
  const running =
    !workersExpected ||
    (status.started && status.loops.every((l: LoopStatus) => l.running));
  res.status(running ? 200 : 503).json({ ready: running, workersExpected, workers: status });
});

/** Full node status: workers, integrations, balances and counters. */
adminRouter.get("/status", async (_req: Request, res: Response) => {
  const [peers, tasks, balances] = await Promise.all([
    store.peers.all(),
    store.tasks.all(),
    walletService.listBalances(),
  ]);
  res.json({
    agent: config.agent,
    protocolVersion: config.a2a.protocolVersion,
    platform: config.server.platform,
    workersExpected,
    workers: workerManager.status(),
    warnings: configWarnings(),
    integrations: {
      gemini: gemini.configured,
      whop: whop.configured,
      webhookSignatureRequired: config.whop.requireWebhookSignature,
    },
    counters: {
      peers: peers.length,
      peersOnline: peers.filter((p: PeerAgent) => p.status === "online").length,
      tasks: tasks.length,
      tasksSettled: tasks.filter((t: A2ATask) => t.status === "settled").length,
      tasksNegotiating: tasks.filter((t: A2ATask) => t.status === "negotiating").length,
    },
    balances,
  });
});

adminRouter.get("/peers", async (_req: Request, res: Response) => {
  const peers = await store.peers.all();
  res.json({ count: peers.length, peers });
});

adminRouter.get("/tasks", async (req: Request, res: Response) => {
  const status = req.query.status;
  const tasks = await store.tasks.all();
  const filtered = typeof status === "string"
    ? tasks.filter((t: A2ATask) => t.status === status)
    : tasks;
  res.json({ count: filtered.length, tasks: filtered });
});

adminRouter.get("/negotiations", async (_req: Request, res: Response) => {
  const negotiations = await store.negotiations.all();
  res.json({ count: negotiations.length, negotiations });
});

adminRouter.get("/wallet", async (req: Request, res: Response) => {
  const agentId = typeof req.query.agentId === "string" ? req.query.agentId : config.agent.id;
  const [balance, ledger, whopBalance] = await Promise.all([
    walletService.getBalance(agentId),
    walletService.listLedger(agentId, 100),
    whop.getBalance(),
  ]);
  res.json({ balance, whopBalance, ledger });
});

/**
 * Publish a task to this node's board. Other agents' acquisition loops poll
 * `GET /a2a/tasks` (and the A2A `list-open-tasks` message) and pick these up,
 * driving the negotiation + settlement pipeline. No authentication is required
 * to read the board; posting is a local operator action, so this route is not
 * exposed to peers.
 */
adminRouter.post("/tasks", async (req: Request, res: Response) => {
  const body = req.body as Partial<{
    id: string;
    title: string;
    description: string;
    payout: number;
    currency: string;
    input: TaskInput;
  }>;
  if (typeof body.title !== "string" || typeof body.payout !== "number") {
    return res.status(400).json({ error: "title (string) and payout (number) are required" });
  }
  const now = new Date().toISOString();
  const id = body.id ?? `local-${Date.now().toString(36)}`;
  const task = {
    id,
    title: body.title,
    description: body.description ?? "",
    peerId: config.agent.id,
    peerUrl: config.agent.publicUrl,
    payout: body.payout,
    currency: body.currency ?? "USD",
    status: "discovered" as const,
    input: body.input,
    createdAt: now,
    updatedAt: now,
  };
  await store.tasks.put(task);
  return res.status(201).json({ task });
});
