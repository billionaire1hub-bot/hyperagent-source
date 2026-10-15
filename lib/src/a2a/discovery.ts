import { config } from "../config";
import { createLogger } from "../logger";
import { fetchWithTimeout } from "../retry";
import { store } from "../storage";
import { fetchAgentCard, handshake, joinUrl, sendTask, toPeerAgent } from "./protocol";
import type { PeerAgent, TaskInput } from "../types";

const log = createLogger("a2a:discovery");

export interface RemoteTask {
  id: string;
  title: string;
  description: string;
  payout: number;
  currency?: string;
  /** Work payload, when the peer advertises one. */
  input?: TaskInput;
  peerId?: string;
  peerUrl?: string;
}

/** Query a registry for globally active agents. Returns [] on any failure. */
export async function pollRegistries(): Promise<PeerAgent[]> {
  const found: PeerAgent[] = [];
  for (const registry of config.a2a.registryUrls) {
    try {
      const res = await fetchWithTimeout(registry, { method: "GET" }, config.a2a.handshakeTimeoutMs);
      if (!res.ok) {
        log.debug("registry non-2xx", { registry, status: res.status });
        continue;
      }
      const json = (await res.json()) as unknown;
      const list = extractAgentList(json);
      for (const raw of list) {
        const peer = toPeerAgent(raw as never, "registry");
        if (peer) found.push(peer);
      }
    } catch (err) {
      log.warn("registry poll failed", { registry, error: (err as Error).message });
    }
  }
  return found;
}

/**
 * Pull the agent list out of a registry response. Accepts a bare array or the
 * common envelope shapes used by A2A registries (Agentverse-style listings,
 * `{agents:[...]}`, `{data:[...]}`, `{items:[...]}`, `{results:[...]}`).
 */
function extractAgentList(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") {
    for (const key of ["agents", "data", "items", "results", "peers"]) {
      const value = (json as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

/** Convert seed peer URLs into PeerAgent records, probing each for a card. */
export async function probeSeedPeers(): Promise<PeerAgent[]> {
  const peers: PeerAgent[] = [];
  for (const url of config.a2a.seedPeers) {
    const card = await fetchAgentCard(url);
    peers.push({
      id: card?.name ? `seed:${card.name}` : `seed:${url}`,
      name: card?.name,
      url: card?.url ?? card?.supportedInterfaces?.[0]?.url ?? url,
      description: card?.description,
      skills: card?.skills?.map((s) => s.id),
      status: "unknown",
      lastSeen: new Date(0).toISOString(),
      source: "seed",
    });
  }
  return peers;
}

/** Upsert a peer, preserving local reputation if the peer is already known. */
export async function upsertPeer(peer: PeerAgent): Promise<PeerAgent> {
  const existing = await store.peers.get(peer.id);
  const merged: PeerAgent = existing
    ? { ...existing, ...peer, reputation: existing.reputation ?? peer.reputation }
    : peer;
  await store.peers.put(merged);
  return merged;
}

/**
 * Full discovery cycle: gather peers from registries and seeds, handshake with
 * each to confirm liveness, then persist. Never throws.
 */
export async function discoverPeers(): Promise<{ discovered: number; online: number }> {
  const candidates = [...(await pollRegistries()), ...(await probeSeedPeers())];
  let online = 0;

  for (const candidate of candidates) {
    // Never treat ourselves as a peer: self-dealing would fabricate activity.
    if (isSelf(candidate.url)) continue;

    const hs = await handshake(candidate.url);
    if (hs && hs.agentId !== config.agent.id) {
      await upsertPeer({
        ...candidate,
        id: hs.agentId || candidate.id,
        name: hs.name || candidate.name,
        status: "online",
        lastSeen: new Date().toISOString(),
      });
      online++;
    } else if (!hs) {
      await upsertPeer({ ...candidate, status: "offline" });
    }
  }

  log.info("discovery cycle complete", { candidates: candidates.length, online });
  return { discovered: candidates.length, online };
}

/** True when a URL points at this node's own advertised address. */
export function isSelf(url: string): boolean {
  const norm = (u: string) => u.replace(/\/$/, "").replace("://localhost:", "://127.0.0.1:");
  return norm(url) === norm(config.agent.publicUrl);
}

/**
 * Ask an online peer for work. A2A has no standard "list tasks" method, so we
 * (a) try the REST `GET /a2a/tasks` convention some agents expose, then
 * (b) send a real `SendMessage` asking for open tasks and parse any task data
 * from the reply. Returns [] when the peer has nothing to offer.
 */
export async function pollPeerTasks(peer: PeerAgent): Promise<RemoteTask[]> {
  const restTasks = await pollPeerTasksRest(peer);
  if (restTasks.length > 0) return restTasks;
  return pollPeerTasksViaMessage(peer);
}

async function pollPeerTasksRest(peer: PeerAgent): Promise<RemoteTask[]> {
  try {
    const res = await fetchWithTimeout(
      joinUrl(peer.url, "/a2a/tasks"),
      { method: "GET" },
      config.a2a.handshakeTimeoutMs,
    );
    if (!res.ok) return [];
    return normalizeTaskList(await res.json(), peer);
  } catch {
    return [];
  }
}

async function pollPeerTasksViaMessage(peer: PeerAgent): Promise<RemoteTask[]> {
  const result = await sendTask(
    peer.url,
    { metadata: { intent: "list-open-tasks" } },
    "Are there any open tasks you would like me to perform? Reply with task data including id, title, description and payout.",
  );
  return normalizeTaskList(result, peer);
}

/** Extract tasks from a variety of shapes (array, {tasks}, message data parts). */
function normalizeTaskList(raw: unknown, peer: PeerAgent): RemoteTask[] {
  if (!raw) return [];
  const candidates: unknown[] = [];

  if (Array.isArray(raw)) candidates.push(...raw);
  else if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.tasks)) candidates.push(...obj.tasks);
    // v1 Task result: { status, artifacts: [{ parts: [{ data }] }] }
    const artifacts = obj.artifacts as Array<{ parts?: Array<{ data?: unknown }> }> | undefined;
    if (Array.isArray(artifacts)) {
      for (const a of artifacts) {
        for (const part of a.parts ?? []) {
          if (part.data && typeof part.data === "object") {
            const d = part.data as Record<string, unknown>;
            if (Array.isArray(d.tasks)) candidates.push(...d.tasks);
            else candidates.push(d);
          }
        }
      }
    }
    // Message result: { parts: [{ data: { tasks } }] }
    const parts = obj.parts as Array<{ data?: unknown }> | undefined;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (part.data && typeof part.data === "object") {
          const d = part.data as Record<string, unknown>;
          if (Array.isArray(d.tasks)) candidates.push(...d.tasks);
        }
      }
    }
  }

  const out: RemoteTask[] = [];
  for (const item of candidates) {
    const t = item as Record<string, unknown>;
    if (!t || typeof t.id !== "string") continue;
    const payout =
      typeof t.payout === "number"
        ? t.payout
        : typeof t.offeredPayout === "number"
          ? t.offeredPayout
          : typeof t.budget === "number"
            ? t.budget
            : 0;
    out.push({
      id: t.id,
      title: String(t.title ?? t.name ?? "Untitled task"),
      description: String(t.description ?? ""),
      payout,
      currency: typeof t.currency === "string" ? t.currency : "USD",
      input: normalizeTaskInput(t),
      peerId: peer.id,
      peerUrl: peer.url,
    });
  }
  return out;
}

/**
 * Extract a work payload from a peer's task object, accepting either an
 * explicit `input` object or a top-level `prompt`/`code`/`context` shape.
 */
function normalizeTaskInput(t: Record<string, unknown>): TaskInput | undefined {
  const raw = (t.input ?? t.task ?? t.payload) as Record<string, unknown> | undefined;
  const source = raw && typeof raw === "object" ? raw : t;
  const prompt =
    typeof source.prompt === "string"
      ? source.prompt
      : typeof source.instruction === "string"
        ? source.instruction
        : typeof source.question === "string"
          ? source.question
          : typeof source.code === "string"
            ? source.code
            : "";
  const context =
    typeof source.context === "string"
      ? source.context
      : typeof source.material === "string"
        ? source.material
        : undefined;
  if (!prompt && !context) return undefined;

  const kind = normalizeKind(source.kind ?? source.type, source);
  const language = typeof source.language === "string" ? source.language : undefined;
  return {
    kind,
    prompt: prompt || String(t.title ?? t.name ?? "Complete the task"),
    ...(context ? { context } : {}),
    ...(language ? { language } : {}),
  };
}

function normalizeKind(raw: unknown, source: Record<string, unknown>): TaskInput["kind"] {
  const k = typeof raw === "string" ? raw.toLowerCase() : "";
  if (k === "code" || k === "json" || k === "reasoning" || k === "text") return k;
  if (typeof source.code === "string") return "code";
  if (k.includes("json") || source.json !== undefined) return "json";
  if (k.includes("reason") || k.includes("analysis")) return "reasoning";
  return "text";
}
