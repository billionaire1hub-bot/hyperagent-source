// Deterministic tests for HyperAgent core logic. No external services.
// Run: node tests/core.test.js
const assert = require("assert");
const os = require("os");
const path = require("path");

process.env.DATA_DIR = path.join(os.tmpdir(), `hyperagent-test-${process.pid}`);
process.env.WHOP_WEBHOOK_SECRET = "ws_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
process.env.LOG_LEVEL = "error";
process.env.MIN_TASK_PAYOUT = "5";
process.env.TASK_UNIT_RATE = "10";
process.env.MAX_BARGAIN_ROUNDS = "4";
process.env.GEMINI_API_KEY = "";

const lib = require("../lib/dist/index.js");
const { verifyWhopSignature, signWhopPayload, heuristicValuation } = lib;

let passed = 0;
let failed = 0;

function ok(name) {
  passed++;
  console.log(`  ok - ${name}`);
}
function fail(name, err) {
  failed++;
  console.error(`  FAIL - ${name}\n        ${(err && err.stack) || err}`);
  process.exitCode = 1;
}
async function test(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

function signHeaders(body, { id = "msg_1", ts = String(Math.floor(Date.now() / 1000)) } = {}) {
  return { id, timestamp: ts, signature: signWhopPayload(body, id, ts) };
}

async function main() {
  console.log("whop standard-webhooks signature verification");
  await test("accepts a correct v1 base64 signature", () => {
    const body = Buffer.from(JSON.stringify({ type: "payment.succeeded" }));
    assert.strictEqual(verifyWhopSignature(body, signHeaders(body)).ok, true);
  });
  await test("rejects a tampered body", () => {
    const body = Buffer.from('{"amount":10}');
    const h = signHeaders(body);
    assert.strictEqual(verifyWhopSignature(Buffer.from('{"amount":999}'), h).ok, false);
  });
  await test("rejects a missing signature", () => {
    assert.strictEqual(verifyWhopSignature(Buffer.from("x"), {}).ok, false);
  });
  await test("rejects a stale timestamp (replay protection)", () => {
    const body = Buffer.from("{}");
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    assert.strictEqual(verifyWhopSignature(body, signHeaders(body, { ts: old })).ok, false);
  });
  await test("accepts space-delimited signatures during key rotation", () => {
    const body = Buffer.from("{}");
    const h = signHeaders(body);
    assert.strictEqual(verifyWhopSignature(body, { ...h, signature: `v1,AAAA ${h.signature}` }).ok, true);
  });

  console.log("pricing heuristic");
  await test("prices a complex task above a simple one", () => {
    const complex = heuristicValuation({
      title: "Build a realtime multi-agent data pipeline integration with security audit",
      description: "24/7 blockchain compliance migration",
      offeredPayout: 5,
    });
    const simple = heuristicValuation({ title: "Write a short summary", description: "one paragraph", offeredPayout: 5 });
    assert.ok(complex.estimatedValue > simple.estimatedValue);
  });
  await test("never values below the minimum payout floor", () => {
    assert.ok(heuristicValuation({ title: "rename", description: "lint", offeredPayout: 0 }).estimatedValue >= 5);
  });

  console.log("offer evaluation");
  await test("rejects when the peer balance is below the floor", async () => {
    const r = await lib.evaluateOffer({
      taskId: "t1", peerId: "p1", peerUrl: "http://x",
      title: "task", description: "simple", offeredPayout: 100, peerBalance: 1,
    });
    assert.strictEqual(r.decision, "reject");
  });
  await test("accepts when the offer meets the valuation", async () => {
    const r = await lib.evaluateOffer({
      taskId: "t2", peerId: "p1", peerUrl: "http://x",
      title: "task", description: "simple", offeredPayout: 1000, peerBalance: 1000,
    });
    assert.strictEqual(r.decision, "accept");
  });
  await test("bargains when the offer is below target but above the floor", async () => {
    const r = await lib.evaluateOffer({
      taskId: "t3", peerId: "p1", peerUrl: "http://x",
      title: "Build a realtime data pipeline integration",
      description: "complex 24/7 realtime security audit",
      offeredPayout: 15, peerBalance: 1000,
    });
    assert.strictEqual(r.decision, "bargain");
    assert.ok(r.askingPrice > 15, "counter must exceed the offer");
    assert.ok(r.askingPrice <= 1000, "counter must not exceed peer balance");
  });

  console.log("bargaining engine");
  await test("accepts when the peer accepts our counter", async () => {
    const outcome = await lib.runBargain(
      { taskId: "b1", title: "x", description: "y", estimatedValue: 50, currentOffer: 20, peerBalance: 200 },
      async () => ({ kind: "accepted" }),
    );
    assert.strictEqual(outcome.accepted, true);
  });
  await test("reaches agreement when the peer meets us partway", async () => {
    let last = 20;
    const outcome = await lib.runBargain(
      { taskId: "b2", title: "x", description: "y", estimatedValue: 60, currentOffer: 30, peerBalance: 200 },
      async (ourOffer) => {
        last = Math.round(((last + ourOffer) / 2) * 100) / 100;
        return { kind: "offer", amount: last };
      },
    );
    assert.strictEqual(outcome.accepted, true);
  });
  await test("walks away from a lowball peer", async () => {
    const outcome = await lib.runBargain(
      { taskId: "b3", title: "x", description: "y", estimatedValue: 100, currentOffer: 10, peerBalance: 200 },
      async () => ({ kind: "offer", amount: 6 }),
    );
    assert.strictEqual(outcome.accepted, false);
  });
  await test("aborts when the peer is unreachable (no fabricated price)", async () => {
    const outcome = await lib.runBargain(
      { taskId: "b4", title: "x", description: "y", estimatedValue: 100, currentOffer: 10, peerBalance: 200 },
      async () => ({ kind: "unreachable" }),
    );
    assert.strictEqual(outcome.accepted, false);
    assert.strictEqual(outcome.unreachable, true);
    assert.strictEqual(outcome.agreedPrice, null);
  });

  console.log("resilient loop");
  await test("survives repeated tick failures without stopping", async () => {
    let calls = 0;
    const loop = new lib.ResilientLoop("test", async () => { calls++; throw new Error("boom"); },
      { intervalMs: 5, errorBackoffMs: 1, maxBackoffMs: 2 });
    loop.start();
    await new Promise((r) => setTimeout(r, 100));
    await loop.stop();
    assert.ok(calls >= 3, `expected several retries, got ${calls}`);
    assert.ok(loop.status().consecutiveErrors > 0);
  });

  console.log("webhook event processing");
  await test("credits the wallet and is idempotent by event id", async () => {
    const agentId = lib.config.agent.id;
    const event = {
      id: "evt-abc", type: "payment.succeeded",
      data: { amount: 25, currency: "USD", agent_id: agentId, task_id: "task-9" },
    };
    const first = await lib.whopWebhookProcessor.process(event);
    assert.strictEqual(first.processed, true);
    assert.strictEqual(first.action, "credit");
    const second = await lib.whopWebhookProcessor.process(event);
    assert.strictEqual(second.duplicate, true);
    assert.strictEqual((await lib.walletService.getBalance(agentId)).available, 25);
  });
  await test("debits on a refund event", async () => {
    const agentId = lib.config.agent.id;
    await lib.whopWebhookProcessor.process({
      id: "evt-refund", type: "payment.refunded",
      data: { amount: 10, currency: "USD", agent_id: agentId },
    });
    assert.strictEqual((await lib.walletService.getBalance(agentId)).available, 15);
  });
  await test("ignores unrelated events", async () => {
    const r = await lib.whopWebhookProcessor.process({ id: "evt-x", type: "member.created", data: {} });
    assert.strictEqual(r.action, "ignore");
  });

  console.log("always-on autonomy invariants");
  await test("A2A discovery is permanently enabled", () => {
    assert.strictEqual(lib.config.a2a.enabled, true);
    assert.ok(lib.config.a2a.seedPeers.length > 0, "seed peers must never be empty");
  });
  await test("background workers always start on boot", () => {
    assert.strictEqual(lib.config.workers.startOnBoot, true);
  });
  await test("agent card advertises known peers (registry endpoint)", () => {
    const card = lib.buildAgentCard([
      { id: "peer-1", name: "Peer One", url: "https://peer.example", status: "online", lastSeen: "", source: "registry" },
    ]);
    assert.strictEqual(Array.isArray(card.agents), true);
    assert.strictEqual(card.agents[0].url, "https://peer.example");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
