import { Router, type Request, type Response, type NextFunction } from "express";
import {
  buildAgentCard,
  config,
  createLogger,
  evaluateOffer,
  rpcError,
  rpcResult,
  store,
  toPeerAgent,
  upsertPeer,
  type A2ATask,
  type JsonRpcRequest,
  type PeerAgent,
  type TaskInput,
} from "hyperagent-lib";

const log = createLogger("route:a2a");
export const a2aRouter = Router();

/** Serve the Agent Card on both the current and legacy well-known paths. */
a2aRouter.get(["/.well-known/agent-card.json", "/.well-known/agent.json", "/agent-card"], async (
  _req: Request,
  res: Response,
) => {
  // Advertise known peers so this card doubles as a registry endpoint that a
  // restarted node can self-register against to re-hydrate its peer set.
  const peers = await store.peers.find((p: PeerAgent) => p.status === "online");
  res.type("application/a2a+json").json(buildAgentCard(peers));
});

/**
 * Optional bearer-token gate for inbound peers. Open unless
 * A2A_INBOUND_AUTH_TOKEN is set.
 */
function requireInboundAuth(req: Request, res: Response, next: NextFunction) {
  const expected = config.a2a.inboundAuthToken;
  if (!expected) return next();
  const header = req.header("authorization") ?? "";
  if (header === `Bearer ${expected}`) return next();
  return res.status(401).json(rpcError(null, -32001, "Unauthorized"));
}

/**
 * REST task board (requirement 3, phase 2). Other agents' acquisition loops
 * poll `GET /a2a/tasks` to discover work. Only open tasks are advertised.
 */
a2aRouter.get("/a2a/tasks", async (_req: Request, res: Response) => {
  const tasks = await store.tasks.find(
    (t: A2ATask) => t.status === "discovered" || t.status === "negotiating",
  );
  res.json({
    tasks: tasks.map((t: A2ATask) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      payout: t.payout,
      currency: t.currency,
      input: t.input,
    })),
  });
});

/**
 * A2A JSON-RPC transport. Accepts both the v1 method names (SendMessage,
 * GetTask) and the legacy names (message/send, tasks/get).
 */
a2aRouter.post("/a2a", requireInboundAuth, async (req: Request, res: Response) => {
  const rpc = req.body as JsonRpcRequest;
  if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
    return res.status(400).json(rpcError(rpc?.id, -32600, "Invalid JSON-RPC request"));
  }

  try {
    switch (rpc.method) {
      case "SendMessage":
      case "message/send":
        return res.json(await handleSendMessage(rpc));
      case "GetTask":
      case "tasks/get":
        return res.json(await handleGetTask(rpc));
      case "ListTasks":
      case "tasks/list":
        return res.json(await handleListTasks(rpc));
      case "CancelTask":
      case "tasks/cancel":
        return res.json(await handleCancelTask(rpc));
      case "price.quote":
        return res.json(await handlePriceQuote(rpc));
      default:
        return res.status(404).json(rpcError(rpc.id, -32601, `Method not found: ${rpc.method}`));
    }
  } catch (err) {
    log.error("a2a handler error", { method: rpc.method, error: (err as Error).message });
    return res.status(500).json(rpcError(rpc.id, -32603, "Internal error"));
  }
});

interface A2APart {
  text?: string;
  data?: Record<string, unknown>;
}
interface A2AMessageLike {
  messageId?: string;
  role?: string;
  parts?: A2APart[];
  metadata?: Record<string, unknown>;
}

function readMessage(params: Record<string, unknown> | undefined): A2AMessageLike {
  const p = params ?? {};
  return (p.message ?? p) as A2AMessageLike;
}

function textOf(msg: A2AMessageLike): string {
  return (msg.parts ?? []).map((p) => p.text ?? "").join(" ").trim();
}

/**
 * SendMessage: this is how peers handshake, ask us to price work, and hand us
 * tasks. Behaviour is driven by `metadata.intent` (or a handshake payload).
 */
async function handleSendMessage(rpc: JsonRpcRequest) {
  const msg = readMessage(rpc.params);
  const meta = { ...(rpc.params?.metadata ?? {}), ...(msg.metadata ?? {}) } as Record<string, unknown>;

  // Handshake: register the peer and return our identity.
  const handshake = meta.handshake as Record<string, unknown> | undefined;
  if (handshake) {
    const peer = toPeerAgent(
      {
        agentId: handshake.agentId as string,
        name: handshake.name as string,
        url: handshake.url as string,
      },
      "inbound",
    );
    if (peer) {
      await upsertPeer({ ...peer, status: "online", lastSeen: new Date().toISOString() });
      log.info("inbound handshake registered peer", { peerId: peer.id, url: peer.url });
    }
    return rpcResult(rpc.id, {
      accepted: true,
      agentId: config.agent.id,
      name: config.agent.name,
      protocolVersion: config.a2a.protocolVersion,
      nonce: handshake.nonce,
      serverTime: new Date().toISOString(),
    });
  }

  // Peer asking what work we have open.
  if (meta.intent === "list-open-tasks") {
    const tasks = await store.tasks.find(
      (t: A2ATask) => t.status === "discovered" || t.status === "negotiating",
    );
    return rpcResult(rpc.id, {
      messageId: `msg-${Date.now()}`,
      role: "ROLE_AGENT",
      parts: [
        {
          data: {
            tasks: tasks.map((t: A2ATask) => ({
              id: t.id,
              title: t.title,
              description: t.description,
              payout: t.payout,
              currency: t.currency,
              input: t.input,
            })),
          },
        },
      ],
    });
  }

  // Negotiation (phase 4): a peer wants to bargain over one of our posted
  // tasks. We answer with our position — accept at or above our asking price,
  // otherwise a counter-offer — never a fabricated agreement.
  if (meta.intent === "negotiate" || meta.negotiation === true) {
    const offer = Number(meta.price);
    const task = await findOwnTask(String(meta.taskId ?? ""));
    if (!task || !Number.isFinite(offer)) {
      return rpcResult(rpc.id, { data: { unreachable: true } });
    }
    const asking = Math.max(config.pricing.minTaskPayout, task.payout);
    if (offer >= asking) {
      await store.tasks.update(task.id, {
        status: "in_progress",
        payout: offer,
        updatedAt: new Date().toISOString(),
      });
      return rpcResult(rpc.id, { data: { accepted: true, price: offer, taskId: task.id } });
    }
    return rpcResult(rpc.id, { data: { counterOffer: round2(asking), taskId: task.id } });
  }

  // Completion notice from the peer doing our task: close the client-side task
  // and store the real deliverable the peer produced.
  if (meta.status === "completed") {
    const task = await findOwnTask(String(meta.taskId ?? ""));
    if (task) {
      await store.tasks.update(task.id, {
        status: "settled",
        result: typeof meta.result === "string" ? meta.result : task.result,
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      log.info("client task settled by peer", {
        taskId: task.id,
        peer: task.peerId,
        hasResult: typeof meta.result === "string",
      });
    }
    return rpcResult(rpc.id, { acknowledged: true });
  }

  // Task delivery: queue it for autonomous execution. The settlement worker
  // picks up `accepted` tasks and runs them through the real executor.
  const taskId = (meta.taskId as string) ?? `task-${Date.now()}`;
  const text = textOf(msg);
  const senderId = String(meta.senderId ?? meta.peerId ?? "inbound-peer");
  const senderUrl = String(meta.senderUrl ?? meta.peerUrl ?? "");
  const input = normalizeInboundInput(meta, text);
  const now = new Date().toISOString();

  const existing = await store.tasks.get(taskId);
  const task: A2ATask = existing ?? {
    id: taskId,
    title: String(meta.title ?? taskId),
    description: text.slice(0, 2000),
    peerId: senderId,
    peerUrl: senderUrl,
    payout: typeof meta.payout === "number" ? meta.payout : 0,
    currency: typeof meta.currency === "string" ? meta.currency : "USD",
    status: "accepted",
    input,
    acceptedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await store.tasks.put(task);
  log.info("task received from peer; queued for execution", {
    taskId,
    kind: input.kind,
    chars: input.prompt.length,
  });
  return rpcResult(rpc.id, {
    id: taskId,
    status: { state: "TASK_STATE_SUBMITTED" },
    message: "Task accepted and queued for autonomous execution.",
  });
}

/**
 * Build a work payload for an inbound task from its metadata, falling back to
 * the message body so peers that only send text still get real execution.
 */
function normalizeInboundInput(
  meta: Record<string, unknown>,
  text: string,
): TaskInput {
  const raw = meta.input as Record<string, unknown> | undefined;
  if (raw && typeof raw === "object") {
    const kindRaw = typeof raw.kind === "string" ? raw.kind.toLowerCase() : "text";
    const kind: TaskInput["kind"] =
      kindRaw === "code" || kindRaw === "json" || kindRaw === "reasoning" ? kindRaw : "text";
    return {
      kind,
      prompt: String(raw.prompt ?? text ?? ""),
      ...(typeof raw.context === "string" ? { context: raw.context } : {}),
      ...(typeof raw.language === "string" ? { language: raw.language } : {}),
    };
  }
  const kindRaw = typeof meta.kind === "string" ? meta.kind.toLowerCase() : "text";
  const kind: TaskInput["kind"] =
    kindRaw === "code" || kindRaw === "json" || kindRaw === "reasoning" ? kindRaw : "text";
  return { kind, prompt: text || String(meta.title ?? "Complete the task") };
}

/**
 * Find one of our own posted tasks by exact id, or by the trailing segment of a
 * peer's composite id (`<ourAgentId>:<ourTaskId>`).
 */
async function findOwnTask(requestedId: string) {
  if (!requestedId) return undefined;
  const exact = await store.tasks.get(requestedId);
  if (exact && exact.peerId === config.agent.id) return exact;
  const own = await store.tasks.find((t: A2ATask) => t.peerId === config.agent.id);
  return own
    .filter((t: A2ATask) => requestedId.endsWith(t.id))
    .sort((a: A2ATask, b: A2ATask) => b.id.length - a.id.length)[0];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function handleGetTask(rpc: JsonRpcRequest) {
  const params = (rpc.params ?? {}) as { id?: string };
  if (!params.id) return rpcError(rpc.id, -32602, "Missing task id");
  const task = await store.tasks.get(params.id);
  if (!task) return rpcError(rpc.id, -32001, "Task not found");
  return rpcResult(rpc.id, task);
}

async function handleListTasks(rpc: JsonRpcRequest) {
  const tasks = await store.tasks.all();
  return rpcResult(rpc.id, { tasks });
}

async function handleCancelTask(rpc: JsonRpcRequest) {
  const params = (rpc.params ?? {}) as { id?: string };
  if (!params.id) return rpcError(rpc.id, -32602, "Missing task id");
  const task = await store.tasks.get(params.id);
  if (!task) return rpcError(rpc.id, -32001, "Task not found");
  await store.tasks.update(params.id, { status: "failed", updatedAt: new Date().toISOString() });
  return rpcResult(rpc.id, { success: true });
}

/**
 * A peer asks us to value a task before engaging us. Runs the same pricing
 * engine used for our own acquisitions, including balance checks.
 */
async function handlePriceQuote(rpc: JsonRpcRequest) {
  const p = (rpc.params ?? {}) as {
    taskId?: string;
    title?: string;
    description?: string;
    offeredPayout?: number;
    peerId?: string;
    peerUrl?: string;
  };
  if (typeof p.offeredPayout !== "number") {
    return rpcError(rpc.id, -32602, "Missing numeric offeredPayout");
  }
  const peerId = p.peerId ?? "unknown-peer";
  const local = await store.balances.get(peerId);
  const decision = await evaluateOffer({
    taskId: p.taskId ?? `quote-${Date.now()}`,
    peerId,
    peerUrl: p.peerUrl ?? "",
    title: p.title ?? "Untitled task",
    description: p.description ?? "",
    offeredPayout: p.offeredPayout,
    peerBalance: local?.available ?? null,
  });
  return rpcResult(rpc.id, {
    decision: decision.decision,
    estimatedValue: decision.estimatedValue,
    askingPrice: decision.askingPrice,
    rationale: decision.rationale,
  });
}
