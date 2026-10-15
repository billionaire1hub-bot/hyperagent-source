// Tests for the real task executor (lib/src/agent/execution.ts).
//
// There is no live Gemini key here, so the *real* Gemini code path is exercised
// by injecting a fetch that talks to a local HTTP server which speaks the Gemini
// generateContent wire format. Nothing is mocked at the module level: the actual
// GeminiClient builds a real request, and executeTask returns whatever the
// endpoint produced. The deterministic fallback is tested by making that
// endpoint fail, exactly as a real outage would.
//
// Run: node tests/execution.test.js
const assert = require("assert");
const http = require("http");
const os = require("os");
const path = require("path");

process.env.DATA_DIR = path.join(os.tmpdir(), `hyperagent-exec-${process.pid}`);
process.env.LOG_LEVEL = "error";
process.env.GEMINI_API_KEY = "test-key-not-real";
process.env.GEMINI_MODEL = "gemini-test-model";
process.env.GEMINI_FALLBACK_MODELS = "";

const lib = require("../lib/dist/index.js");
const { executeTask, taskPrompt } = lib;

let passed = 0;
let failed = 0;
function ok(name) { passed++; console.log(`  ok - ${name}`); }
function fail(name, err) { failed++; console.error(`  FAIL - ${name}\n        ${(err && err.stack) || err}`); process.exitCode = 1; }
async function test(name, fn) {
  try { await fn(); ok(name); } catch (err) { fail(name, err); }
}

// A stand-in for generativelanguage.googleapis.com that records the last request
// body so we can assert the client really sent what we expect.
function startFakeGemini() {
  const state = { lastBody: null, reply: null, status: 200 };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      state.lastBody = JSON.parse(raw);
      res.writeHead(state.status, { "Content-Type": "application/json" });
      if (state.status !== 200) return res.end(JSON.stringify({ error: { message: "boom" } }));
      res.end(JSON.stringify({
        candidates: [{ content: { parts: [{ text: state.reply }] } }],
        usageMetadata: { totalTokenCount: 42 },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      // fetchImpl ignores the real host and hits our local server instead.
      const fetchImpl = (url, init) => fetch(`http://127.0.0.1:${port}/v1beta`, init);
      resolve({ state, fetchImpl, close: () => server.close() });
    });
  });
}

async function main() {
  const fake = await startFakeGemini();

  await test("taskPrompt builds a prompt from the task input", () => {
    const { prompt, kind } = taskPrompt({
      title: "T",
      description: "D",
      input: { kind: "code", prompt: "Reverse a string", language: "python", context: "def f(s): ..." },
    });
    assert.strictEqual(kind, "code");
    assert.ok(prompt.includes("Reverse a string"));
    assert.ok(prompt.includes("python"));
    assert.ok(prompt.includes("def f(s): ..."));
  });

  await test("executeTask returns the real Gemini output (not a placeholder)", async () => {
    fake.state.status = 200;
    fake.state.reply = "def reverse(s):\n    return s[::-1]";
    const result = await executeTask(
      { title: "Reverse a string", description: "", input: { kind: "code", prompt: "Reverse a string in python" } },
      { fetchImpl: fake.fetchImpl },
    );
    assert.strictEqual(result.output, "def reverse(s):\n    return s[::-1]");
    assert.strictEqual(result.meta.source, "gemini");
    assert.strictEqual(result.meta.model, "gemini-test-model");
    assert.strictEqual(result.meta.tokens, 42);
  });

  await test("the request carries a system instruction and the code modality", async () => {
    fake.state.reply = "ok";
    await executeTask(
      { title: "x", description: "", input: { kind: "code", prompt: "do it" } },
      { fetchImpl: fake.fetchImpl },
    );
    const body = fake.state.lastBody;
    assert.ok(body.systemInstruction, "systemInstruction must be sent");
    assert.ok(body.systemInstruction.parts[0].text.toLowerCase().includes("code"));
    assert.ok(body.generationConfig.maxOutputTokens >= 1024);
    assert.strictEqual(body.contents[0].parts[0].text.includes("do it"), true);
  });

  await test("json tasks request application/json response mode", async () => {
    fake.state.reply = '{"ok":true}';
    const result = await executeTask(
      { title: "x", description: "", input: { kind: "json", prompt: "return ok" } },
      { fetchImpl: fake.fetchImpl },
    );
    assert.strictEqual(result.meta.source, "gemini");
    assert.strictEqual(fake.state.lastBody.generationConfig.responseMimeType, "application/json");
  });

  await test("a Gemini outage degrades to a grounded deterministic result, clearly marked", async () => {
    fake.state.status = 500;
    const result = await executeTask(
      {
        title: "Summarise the incident",
        description: "Disk filled up. The service returned 500. We cleared logs and recovered.",
        input: { kind: "text", prompt: "Summarise the incident", context: "Disk filled up. The service returned 500. We cleared logs and recovered." },
      },
      { fetchImpl: fake.fetchImpl },
    );
    assert.strictEqual(result.meta.source, "deterministic");
    assert.strictEqual(result.meta.degraded, true);
    assert.ok(result.output.length > 0);
    assert.ok(!/Completed ".*" for peer/.test(result.output), "must not be the old placeholder");
    fake.state.status = 200;
  });

  await test("deterministic executor summarises from the supplied material", async () => {
    fake.state.status = 500;
    const material = "First sentence. Second sentence. Third sentence. Fourth sentence.";
    const result = await executeTask(
      { title: "s", description: material, input: { kind: "text", prompt: "Summarise this", context: material } },
      { fetchImpl: fake.fetchImpl },
    );
    assert.strictEqual(result.meta.source, "deterministic");
    assert.ok(result.output.includes("First sentence"));
    assert.ok(result.output.length < material.length);
    fake.state.status = 200;
  });

  await test("no source material and no LLM yields an explicit, honest message", async () => {
    fake.state.status = 500;
    const result = await executeTask(
      { title: "Unanswerable", description: "", input: { kind: "text", prompt: "What is the meaning of life?" } },
      { fetchImpl: fake.fetchImpl },
    );
    assert.strictEqual(result.meta.source, "deterministic");
    assert.ok(/unavailable|Unable/i.test(result.output));
    fake.state.status = 200;
  });

  fake.close();
  console.log(`\n${passed} passed, ${failed} failed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
