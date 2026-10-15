// Integration test: boots the real built server and drives it over HTTP.
// No external services required. Run: node tests/integration.test.js
const assert = require("assert");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = 12987;
const SECRET = "ws_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const CRON_SECRET = "cron_it_secret_1234567890";
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), `hyperagent-it-${process.pid}`);

// Must be set before requiring the lib so signWhopPayload uses the same secret.
process.env.WHOP_WEBHOOK_SECRET = SECRET;
const lib = require("../lib/dist/index.js");
const { signWhopPayload } = lib;

let passed = 0;
let failed = 0;
function ok(name) { passed++; console.log(`  ok - ${name}`); }
function fail(name, err) { failed++; console.error(`  FAIL - ${name}\n        ${(err && err.stack) || err}`); process.exitCode = 1; }
async function test(name, fn) {
  try { await fn(); ok(name); } catch (err) { fail(name, err); }
}

async function get(pathname) {
  const res = await fetch(`${BASE}${pathname}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function postJson(pathname, body, headers = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function waitForReady(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/admin/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not become ready");
}

async function main() {
  const server = spawn(process.execPath, ["artifacts/api-server/dist/index.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      AGENT_ID: "node-a",
      AGENT_PUBLIC_URL: BASE,
      DATA_DIR,
      LOG_LEVEL: "error",
      WHOP_WEBHOOK_SECRET: SECRET,
      CRON_SECRET,
      GEMINI_API_KEY: "",
      WHOP_API_KEY: "",
      A2A_SEED_PEERS: "",
      A2A_REGISTRY_URLS: "",
      A2A_DISCOVERY_INTERVAL_MS: "600000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

  try {
    await waitForReady();

    console.log("agent discovery");
    await test("serves the Agent Card at the v1 well-known path", async () => {
      const { status, body } = await get("/.well-known/agent-card.json");
      assert.strictEqual(status, 200);
      assert.ok(body.name);
      assert.ok(Array.isArray(body.supportedInterfaces));
    });
    await test("also serves the legacy agent.json path", async () => {
      const { status, body } = await get("/.well-known/agent.json");
      assert.strictEqual(status, 200);
      assert.ok(body.name);
    });

    console.log("A2A JSON-RPC (real inbound handling)");
    await test("handles a v1 SendMessage handshake and registers the peer", async () => {
      const rpc = {
        jsonrpc: "2.0", id: 1, method: "SendMessage",
        params: {
          message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "handshake" }] },
          metadata: { handshake: { agentId: "peer-it", name: "ITPeer", url: "http://peer.it:9" } },
        },
      };
      const { status, body } = await postJson("/a2a", rpc);
      assert.strictEqual(status, 200);
      assert.strictEqual(body.result.accepted, true);
      assert.ok(body.result.agentId);

      const peers = await get("/api/admin/peers");
      assert.ok(peers.body.peers.some((p) => p.id === "peer-it"), "peer should be registered");
    });
    await test("handles the legacy message/send method", async () => {
      const { status, body } = await postJson("/a2a", {
        jsonrpc: "2.0", id: 2, method: "message/send",
        params: { message: { messageId: "m2", role: "user", parts: [{ text: "hi" }] } },
      });
      assert.strictEqual(status, 200);
      assert.ok(body.result);
    });
    await test("returns a JSON-RPC method-not-found error", async () => {
      const { status, body } = await postJson("/a2a", { jsonrpc: "2.0", id: 3, method: "does/not/exist" });
      assert.strictEqual(status, 404);
      assert.strictEqual(body.error.code, -32601);
    });
    await test("answers a price.quote request with a real decision", async () => {
      const { status, body } = await postJson("/a2a", {
        jsonrpc: "2.0", id: 4, method: "price.quote",
        params: {
          taskId: "q1", title: "Build a realtime data pipeline integration",
          description: "complex 24/7 realtime security audit", offeredPayout: 15, peerId: "peer-it",
        },
      });
      assert.strictEqual(status, 200);
      assert.ok(["accept", "bargain", "reject"].includes(body.result.decision));
      assert.ok(typeof body.result.askingPrice === "number");
    });

    console.log("Whop webhook over HTTP");
    await test("rejects an unsigned webhook with 401", async () => {
      const { status } = await postJson("/api/whop/webhook", { type: "payment.succeeded", data: { amount: 5 } });
      assert.strictEqual(status, 401);
    });
    await test("credits the wallet on a correctly signed webhook", async () => {
      const body = JSON.stringify({
        id: "evt-it-1", type: "payment.succeeded",
        data: { amount: 33.5, currency: "usd", agent_id: "peer-it", task_id: "t-it" },
      });
      const id = "msg_it_1";
      const ts = String(Math.floor(Date.now() / 1000));
      const res = await fetch(`${BASE}/api/whop/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "webhook-id": id,
          "webhook-timestamp": ts,
          "webhook-signature": signWhopPayload(Buffer.from(body), id, ts),
        },
        body,
      });
      const json = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(json.processed, true);
      assert.strictEqual(json.action, "credit");

      const wallet = await get("/api/admin/wallet?agentId=peer-it");
      assert.strictEqual(wallet.body.balance.available, 33.5);
    });
    await test("ignores a redelivery of the same signed webhook", async () => {
      const body = JSON.stringify({
        id: "evt-it-1", type: "payment.succeeded",
        data: { amount: 33.5, currency: "usd", agent_id: "peer-it" },
      });
      const id = "msg_it_1";
      const ts = String(Math.floor(Date.now() / 1000));
      const res = await fetch(`${BASE}/api/whop/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "webhook-id": id, "webhook-timestamp": ts,
          "webhook-signature": signWhopPayload(Buffer.from(body), id, ts),
        },
        body,
      });
      const json = await res.json();
      assert.strictEqual(json.duplicate, true);
      const wallet = await get("/api/admin/wallet?agentId=peer-it");
      assert.strictEqual(wallet.body.balance.available, 33.5, "must not double-credit");
    });

    console.log("24/7 readiness");
    await test("workers are running and readiness is 200", async () => {
      const ready = await get("/api/admin/ready");
      assert.strictEqual(ready.status, 200);
      assert.strictEqual(ready.body.ready, true);
      assert.ok(ready.body.workers.loops.length >= 4);
    });

    console.log("serverless cron tick (Vercel alternative to in-process loops)");
    await test("cron tick rejects an unauthorized caller with 401", async () => {
      const res = await fetch(`${BASE}/api/cron/tick`);
      assert.strictEqual(res.status, 401);
    });
    await test("cron tick runs the pipeline for an authorized caller", async () => {
      const res = await fetch(`${BASE}/api/cron/tick`, {
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      });
      const body = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(body.ok, true);
      assert.ok(Array.isArray(body.runs) && body.runs.length >= 1);
      // Same pipeline the loops run: discovery counts are reported per cycle.
      assert.ok(typeof body.runs[0].discovered === "number");
      assert.ok(typeof body.runs[0].tasksAcquired === "number");
    });

    console.log("live A2A federation (two real nodes)");
    await test("a second node discovers and handshakes the first over HTTP", async () => {
      const PORT_B = 12988;
      const DATA_B = path.join(os.tmpdir(), `hyperagent-it-b-${process.pid}`);
      const nodeB = spawn(process.execPath, ["artifacts/api-server/dist/index.js"], {
        cwd: path.join(__dirname, ".."),
        env: {
          ...process.env,
          PORT: String(PORT_B),
          HOST: "127.0.0.1",
          AGENT_ID: "node-b",
          AGENT_PUBLIC_URL: `http://127.0.0.1:${PORT_B}`,
          DATA_DIR: DATA_B,
          LOG_LEVEL: "error",
          GEMINI_API_KEY: "",
          WHOP_API_KEY: "",
          A2A_SEED_PEERS: BASE,
          A2A_DISCOVERY_INTERVAL_MS: "1000",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      nodeB.stderr.on("data", (d) => process.stderr.write(`[node-b] ${d}`));

      try {
        // Wait for B to boot and run at least one discovery cycle.
        const start = Date.now();
        let bPeers = null;
        while (Date.now() - start < 15000) {
          try {
            const res = await fetch(`http://127.0.0.1:${PORT_B}/api/admin/peers`);
            bPeers = await res.json();
            if (bPeers.peers.some((p) => p.status === "online")) break;
          } catch { /* not up yet */ }
          await new Promise((r) => setTimeout(r, 500));
        }
        assert.ok(bPeers, "node B should be reachable");
        const discovered = bPeers.peers.find((p) => p.url === BASE && p.status === "online");
        assert.ok(discovered, `node B should have discovered node A online; got ${JSON.stringify(bPeers)}`);

        // Node A should have registered node B via the inbound handshake.
        const aPeers = await get("/api/admin/peers");
        assert.ok(
          aPeers.body.peers.some((p) => p.id === "node-b"),
          "node A should have registered node B through the real handshake",
        );
      } finally {
        nodeB.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 400));
        if (!nodeB.killed) nodeB.kill("SIGKILL");
      }
    });

    console.log("autonomous end-to-end pipeline (phases 1-4, two live nodes)");
    await test("node B discovers A, negotiates, accepts and settles a task A posted", async () => {
      // Phase 1: post a task on node A's board, with a real work payload.
      const created = await postJson("/api/admin/tasks", {
        id: "task-e2e",
        title: "Realtime data pipeline integration",
        description: "complex 24/7 realtime security audit and deployment",
        payout: 10,
        currency: "USD",
        input: {
          kind: "text",
          prompt: "Summarise the operational risk in this deployment note",
          context:
            "The pipeline ingests realtime events. A security audit found the ingestion " +
            "endpoint unauthenticated. The deployment must add auth before going live.",
        },
      });
      assert.strictEqual(created.status, 201);

      const PORT_C = 12989;
      const DATA_C = path.join(os.tmpdir(), `hyperagent-it-c-${process.pid}`);
      const nodeC = spawn(process.execPath, ["artifacts/api-server/dist/index.js"], {
        cwd: path.join(__dirname, ".."),
        env: {
          ...process.env,
          PORT: String(PORT_C),
          HOST: "127.0.0.1",
          AGENT_ID: "node-c",
          AGENT_PUBLIC_URL: `http://127.0.0.1:${PORT_C}`,
          DATA_DIR: DATA_C,
          LOG_LEVEL: "error",
          GEMINI_API_KEY: "",
          WHOP_API_KEY: "",
          A2A_SEED_PEERS: BASE,          // Phase 1: discovery seed -> node A
          A2A_DISCOVERY_INTERVAL_MS: "1000",
          SETTLEMENT_INTERVAL_MS: "1000",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      nodeC.stderr.on("data", (d) => process.stderr.write(`[node-c] ${d}`));

      try {
        const CBASE = `http://127.0.0.1:${PORT_C}`;
        // Phase 2-4 run autonomously on node C; wait for the whole pipeline.
        const start = Date.now();
        let bTask = null;
        while (Date.now() - start < 40000) {
          try {
            const res = await fetch(`${CBASE}/api/admin/tasks`);
            const json = await res.json();
            bTask = json.tasks.find((t) => t.id === "node-a:task-e2e");
            if (bTask && bTask.status === "settled") break;
          } catch { /* not up yet */ }
          await new Promise((r) => setTimeout(r, 500));
        }

        assert.ok(bTask, "node C should have discovered and acquired node A's task");
        assert.strictEqual(bTask.status, "settled", `expected settled, got ${bTask && bTask.status}`);
        // Phase 3/4: negotiated up from the 10 offered to a Gemini/heuristic price.
        assert.ok(bTask.payout > 10, `expected a negotiated price above the initial offer, got ${bTask.payout}`);
        // Ledger-only settlement (no Whop key): must be clearly marked, not faked.
        assert.strictEqual(bTask.whopPaymentId, undefined);
        // The executor ran for real: a non-empty result is persisted, and it is
        // never the old placeholder string.
        assert.ok(typeof bTask.result === "string" && bTask.result.length > 0, "task must carry a real result");
        assert.ok(!/^Completed ".*" for peer /.test(bTask.result), "result must not be a placeholder");
        assert.ok(bTask.execution && bTask.execution.source, "execution provenance must be recorded");

        // Earnings credited to node C's wallet.
        const wallet = await fetch(`${CBASE}/api/admin/wallet?agentId=node-c`).then((r) => r.json());
        assert.ok(wallet.balance.available >= bTask.payout, "earnings should be credited to the wallet");

        // A real negotiation record exists.
        const negs = await fetch(`${CBASE}/api/admin/negotiations`).then((r) => r.json());
        assert.ok(negs.negotiations.some((n) => n.status === "accepted" && n.round >= 1));

        // Phase 4 completion propagated back: node A closed its own task and
        // received the real deliverable from the peer.
        const aTask = await get("/api/admin/tasks?status=settled");
        const closed = aTask.body.tasks.find((t) => t.id === "task-e2e");
        assert.ok(closed, "node A should have settled the task it posted once the peer reported completion");
        assert.ok(
          typeof closed.result === "string" && closed.result.length > 0,
          "node A should have stored the peer's real deliverable",
        );
      } finally {
        nodeC.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 400));
        if (!nodeC.killed) nodeC.kill("SIGKILL");
      }
    });
  } finally {
    server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    if (!server.killed) server.kill("SIGKILL");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
