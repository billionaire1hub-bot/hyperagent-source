import { randomUUID } from "crypto";
import { config } from "../config";
import { createLogger } from "../logger";
import { fetchWithTimeout } from "../retry";
import type { PeerAgent } from "../types";

const log = createLogger("a2a");

/**
 * Agent Card as defined by the A2A protocol. We emit both the v1 field names
 * (`supportedInterfaces`) and the legacy `url`/`protocolVersion` fields so any
 * conformant A2A client can discover and talk to us.
 */
export interface AgentCard {
  name: string;
  description: string;
  version: string;
  /** Legacy (pre-1.0) endpoint field. */
  url: string;
  protocolVersion: string;
  supportedInterfaces: Array<{ url: string; transport: string }>;
  capabilities: { streaming: boolean; pushNotifications: boolean; extendedAgentCard?: boolean };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: Array<{ id: string; name: string; description: string; tags?: string[] }>;
  /**
   * Known peers, so this card also serves as a registry endpoint. A node that
   * self-registers here re-hydrates the peers it discovered before a restart.
   */
  agents: Array<{ id: string; name?: string; url: string; description?: string; skills?: string[] }>;
}

export function buildAgentCard(knownPeers: PeerAgent[] = []): AgentCard {
  return {
    name: config.agent.name,
    description: config.agent.description,
    version: "1.0.0",
    url: config.agent.publicUrl,
    protocolVersion: config.a2a.protocolVersion,
    supportedInterfaces: [{ url: config.agent.publicUrl, transport: "JSONRPC" }],
    capabilities: { streaming: false, pushNotifications: true, extendedAgentCard: false },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text", "data"],
    skills: [
      {
        id: "autonomous-task-execution",
        name: "Autonomous task execution",
        description:
          "Discovers A2A peers, negotiates pricing and executes real-world tasks end-to-end.",
        tags: ["automation", "a2a", "payments"],
      },
      {
        id: "negotiation",
        name: "Dynamic price negotiation",
        description: "Negotiates fair task payout against peer balance via LLM bargaining.",
        tags: ["pricing", "bargaining"],
      },
    ],
    agents: knownPeers.map((p) => ({
      id: p.id,
      name: p.name,
      url: p.url,
      description: p.description,
      skills: p.skills,
    })),
  };
}

/** A2A JSON-RPC envelope. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export function rpcResult(id: string | number | null | undefined, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

export function rpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}

/** A2A Message (v1 uses member-name discriminators, legacy used `kind`). */
export interface A2AMessage {
  messageId: string;
  role: "ROLE_USER" | "ROLE_AGENT" | "user" | "agent";
  parts: Array<{ text: string } | { data: Record<string, unknown> }>;
  metadata?: Record<string, unknown>;
}

export function textMessage(
  text: string,
  role: "ROLE_USER" | "ROLE_AGENT" = "ROLE_USER",
  metadata?: Record<string, unknown>,
): A2AMessage {
  return { messageId: `msg-${randomUUID()}`, role, parts: [{ text }], metadata };
}

export interface HandshakeResponse {
  accepted: boolean;
  agentId: string;
  name: string;
  protocolVersion: string;
  nonce?: string;
  serverTime: string;
}

/** Payload sent on a handshake (carried in message metadata). */
export function buildHandshake() {
  return {
    agentId: config.agent.id,
    name: config.agent.name,
    url: config.agent.publicUrl,
    protocolVersion: config.a2a.protocolVersion,
    nonce: randomUUID(),
  };
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.a2a.authToken) headers.Authorization = `Bearer ${config.a2a.authToken}`;
  return headers;
}

/** The JSON-RPC endpoint for a peer, derived from its Agent Card url. */
export function rpcEndpoint(peerUrl: string): string {
  return joinUrl(peerUrl, "/a2a");
}

/**
 * Send a JSON-RPC request to a peer, trying the preferred method name first
 * (v1 `SendMessage`) and falling back to the legacy `message/send` when the
 * peer rejects the method as unknown.
 */
async function sendRpc(
  peerUrl: string,
  params: Record<string, unknown>,
  text: string,
  role: "ROLE_USER" | "ROLE_AGENT",
): Promise<unknown | null> {
  const methods =
    config.a2a.protocol === "legacy" ? ["message/send", "SendMessage"] : ["SendMessage", "message/send"];

  for (const method of methods) {
    const rpc: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method,
      params: { message: textMessage(text, role), ...params },
    };
    try {
      const res = await fetchWithTimeout(
        rpcEndpoint(peerUrl),
        { method: "POST", headers: authHeaders(), body: JSON.stringify(rpc) },
        config.a2a.handshakeTimeoutMs,
      );
      if (!res.ok) continue;
      const json = (await res.json()) as JsonRpcResponse;
      if (json.error) {
        // Method not found on the other side -> try the next method name.
        if (json.error.code === -32601) continue;
        log.debug("peer rpc error", { method, error: json.error.message });
        return null;
      }
      return json.result ?? null;
    } catch (err) {
      log.debug("rpc failed", { peerUrl, method, error: (err as Error).message });
    }
  }
  return null;
}

/** Handshake with a peer and return its identity, or null if it is unreachable. */
export async function handshake(peerUrl: string): Promise<HandshakeResponse | null> {
  const hs = buildHandshake();
  const result = await sendRpc(
    peerUrl,
    { metadata: { handshake: hs } },
    `handshake from ${config.agent.name}`,
    "ROLE_USER",
  );
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (r.accepted === true || r.agentId) {
      return {
        accepted: true,
        agentId: String(r.agentId ?? "unknown"),
        name: String(r.name ?? "unknown"),
        protocolVersion: String(r.protocolVersion ?? "unknown"),
        nonce: typeof r.nonce === "string" ? r.nonce : hs.nonce,
        serverTime: String(r.serverTime ?? new Date().toISOString()),
      };
    }
  }
  return null;
}

/** Fetch a peer's Agent Card (v0.3+ path first, then the legacy path). */
export async function fetchAgentCard(peerUrl: string): Promise<AgentCard | null> {
  for (const path of [config.a2a.agentCardPath, config.a2a.legacyAgentCardPath]) {
    try {
      const res = await fetchWithTimeout(
        joinUrl(peerUrl, path),
        { method: "GET", headers: { Accept: "application/a2a+json, application/json" } },
        config.a2a.handshakeTimeoutMs,
      );
      if (res.ok) return (await res.json()) as AgentCard;
    } catch {
      /* try the next path */
    }
  }
  return null;
}

/** Invoke a task on a peer over A2A. Returns the raw result or null. */
export async function sendTask(
  peerUrl: string,
  params: Record<string, unknown>,
  text: string,
): Promise<unknown | null> {
  return sendRpc(peerUrl, params, text, "ROLE_USER");
}

/** Query a peer for a task's state (GetTask / tasks/get). */
export async function getTask(peerUrl: string, taskId: string): Promise<unknown | null> {
  const methods = config.a2a.protocol === "legacy" ? ["tasks/get", "GetTask"] : ["GetTask", "tasks/get"];
  for (const method of methods) {
    try {
      const res = await fetchWithTimeout(
        rpcEndpoint(peerUrl),
        {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params: { id: taskId } }),
        },
        config.a2a.handshakeTimeoutMs,
      );
      if (!res.ok) continue;
      const json = (await res.json()) as JsonRpcResponse;
      if (json.error?.code === -32601) continue;
      return json.result ?? null;
    } catch {
      /* try next */
    }
  }
  return null;
}

export function joinUrl(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, "")}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
}

/** Normalize a raw inbound peer identity into a stored PeerAgent. */
export function toPeerAgent(
  input: {
    agentId?: string;
    id?: string;
    name?: string;
    url?: string;
    description?: string;
    skills?: string[];
  },
  source: PeerAgent["source"] = "inbound",
): PeerAgent | null {
  const id = input.agentId ?? input.id;
  const url = input.url;
  if (!id || !url) return null;
  return {
    id,
    name: input.name,
    url,
    description: input.description,
    skills: input.skills,
    status: "online",
    lastSeen: new Date().toISOString(),
    source,
  };
}
