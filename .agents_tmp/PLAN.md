# 1. OBJECTIVE

Enable full autonomous operation on Vercel (serverless, no long-lived loops) by
(a) making the Agent Card and task executor truthful and functional, (b) adding a
secret-protected `/api/cron-tick` endpoint that runs one iteration of the
background pipeline on demand, and (c) adding deterministic scope validation so
out-of-scope tasks are explicitly rejected instead of silently accepted.

Operationally: the Vercel deployment must be able to poll pending tasks, execute
them via Gemini, advance negotiations, and update the ledger/settlement state,
driven by an external pinger (cron-job.org or Vercel Cron) hitting one HTTP
endpoint — while the public Agent Card accurately describes what the node does.

# 2. CONTEXT SUMMARY

Monorepo: `lib` (`hyperagent-lib`) + `artifacts/api-server`, built with `tsc -b`
project references. Vercel entrypoint `api/index.ts` exports the Express app from
`artifacts/api-server/src/app.ts` and does NOT start workers; `index.ts` skips
`workerManager.start()` when `process.env.VERCEL` is set. So on Vercel the node is
HTTP-only and the pipeline must be driven externally.

Files that this change touches and why:
- `lib/src/a2a/protocol.ts` — `buildAgentCard()` (skill descriptions to fix).
- `lib/src/workers/pipeline.ts` — `performTask()` (static placeholder to replace)
  and `executeAndSettle()` (settlement, reused by the tick).
- `lib/src/agent/gemini.ts` — `gemini.generateText()` / `generateJson()` (the LLM
  engine `performTask()` will call; returns `null` when unconfigured).
- `lib/src/workers/manager.ts` — the four loop bodies the tick must replicate
  (discovery, acquisition, settlement, heartbeat).
- `lib/src/a2a/discovery.ts` — `discoverPeers()`, `pollPeerTasks()`.
- `lib/src/storage/index.ts` + `collection.ts` + `wallet.ts` — the shared `store`
  and `walletService` the tick mutates.
- `lib/src/types.ts` — `A2ATask`, `TaskStatus`, `Negotiation`.
- `artifacts/api-server/src/routes/a2a.ts` — `handleSendMessage()` (scope check +
  inbound task persistence).
- `artifacts/api-server/src/app.ts` — mount the new cron router.
- `lib/src/config.ts` + `.env.example` — add `CRON_SECRET`.
- `lib/src/index.ts` — export the new tick/scope functions.
- `tests/core.test.js`, `tests/integration.test.js` — extend coverage.
- `AGENTS.md`, `README.md`, `vercel.json` — document/configure.

Constraints & invariants that shape the design:
- Strict TS (`noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`,
  `noImplicitAny`); env vars are read ONLY in `lib/src/config.ts`; route handlers
  annotate params explicitly.
- **Never crash / graceful degradation:** Gemini and Whop are optional; the
  deterministic fallback path must keep working (tests run with
  `GEMINI_API_KEY=""`).
- **No fabricated counterparties:** negotiation only accepts a price a real peer
  replied with.
- `AGENTS.md` currently states "Zero manual trigger — do not add an HTTP endpoint
  that must be called to start the loops." This plan deliberately adds a
  serverless tick endpoint, so `AGENTS.md` must be updated to scope that
  invariant to long-lived hosts.

**⚠ Known limitation — serverless state is ephemeral (accepted, Option A).**
`config.storage.dataDir` defaults to `/tmp/hyperagent-data` on Vercel
(`config.ts`). Vercel `/tmp` is per-instance and not shared across invocations or
instances, so a task queued by one request is not reliably visible to a later
cron-tick request. `JsonCollection` keeps an in-process `cache` that survives only
while an instance stays warm. This affects requirement 2's "poll pending queued
tasks" and "update the ledger/settlement state." **Decision: Option A — accept
best-effort state; no shared backend, no new dependencies.** The tick is written
so that swapping in a shared `Store` later requires no signature changes.

# 3. APPROACH OVERVIEW

Four coordinated changes, all additive and backward-compatible with the existing
long-lived-host behavior:

1. **Truthful Agent Card + real executor.** Rewrite the two `buildAgentCard()`
   skill descriptions to describe what the code does (text reasoning, code/JSON
   analysis, LLM bargaining, A2A protocol exchange). Replace `performTask()` with
   a Gemini-backed implementation that returns the model's text, falling back to
   the current descriptive string when Gemini is unconfigured or fails.
2. **Serverless tick.** Add `runCronTick()` in `lib/src/workers/tick.ts` that runs
   one pass of each loop body, and expose it via a new
   `artifacts/api-server/src/routes/cron.ts` router mounted so both
   `GET|POST /api/cron-tick` and `GET|POST /api/cron/tick` work. Protect it with
   an optional `CRON_SECRET`.
3. **Inbound task persistence.** `handleSendMessage()` currently returns
   `TASK_STATE_SUBMITTED` without persisting anything, so there is nothing for the
   tick to "poll." Persist accepted inbound tasks as `A2ATask` records so the tick
   can execute them.
4. **Deterministic scope validator.** Add `validateTaskScope()` in
   `lib/src/a2a/scope.ts` (no LLM, so it is fast, free, and unit-testable) and
   call it at the top of `handleSendMessage()` to explicitly reject unsupported
   work (browser scraping, social posting, etc.). **Decision: deterministic
   denylist.**

Rationale: this reuses the already-real pipeline functions (`discoverPeers`,
`pollPeerTasks`, `acquireTask`, `executeAndSettle`, `walletService`) rather than
duplicating logic, keeps the deterministic fallback path intact, and confines the
serverless-specific behavior to one new endpoint + one new lib module.

# 4. IMPLEMENTATION STEPS

Step 1 — Add `CRON_SECRET` to config.
- Goal: a single source of truth for the cron secret (per repo convention).
- Method: in `lib/src/config.ts` add a `cron: { secret: str("CRON_SECRET") }`
  block (or a top-level `cronSecret`); add it to `.env.example` with a comment
  (empty = endpoint unprotected, with a boot warning).
- Reference: `lib/src/config.ts`, `.env.example`.

Step 2 — Align `buildAgentCard()` skill descriptions.
- Goal: stop over-claiming; describe text reasoning, code/JSON analysis, LLM
  bargaining, and network protocol exchange.
- Method: edit the `skills[]` array in `buildAgentCard()`. Keep `id`s stable
  (`autonomous-task-execution`, `negotiation`) so peer reputation/keys do not
  break; update `name`/`description`/`tags`. Leave `capabilities`
  (`streaming:false`, `pushNotifications:true`), `defaultInputModes:["text"]`,
  `defaultOutputModes:["text","data"]` unchanged unless the user asks otherwise.
  Optionally add a third skill describing the scope contract.
- Reference: `lib/src/a2a/protocol.ts`.

Step 3 — Replace `performTask()` with a Gemini-backed executor.
- Goal: actually process text/data tasks with the configured LLM.
- Method: build a prompt from `task.title` + `task.description` and call
  `gemini.generateText(...)`; return the trimmed result. When Gemini is
  unconfigured or returns `null`, return the existing descriptive fallback string
  so tests and key-less deployments behave exactly as before. Keep the function
  signature (`(task: A2ATask) => Promise<string>`) and the `result` field on
  `A2ATask` unchanged so `executeAndSettle()` and the integration test stay valid.
- Reference: `lib/src/workers/pipeline.ts` (`performTask`, `executeAndSettle`),
  `lib/src/agent/gemini.ts`.

Step 4 — Add the deterministic scope validator.
- Goal: reject unsupported tasks with an explicit response.
- Method: create `lib/src/a2a/scope.ts` exporting
  `validateTaskScope(text: string, metadata?: Record<string, unknown>): { inScope: boolean; reason?: string; matched?: string[] }`.
  Use a fixed denylist of out-of-scope signals (e.g. `scrape`, `scraping`,
  `crawl`, `browser`, `headless`, `puppeteer`, `playwright`, `selenium`,
  `captcha`, `twitter`, `x.com`, `tweet`, `instagram`, `facebook`, `tiktok`,
  `linkedin`, `social media`, `post to`). Return `inScope:false` with the matched
  signals. Export from `lib/src/index.ts`.
- Reference: new `lib/src/a2a/scope.ts`, `lib/src/index.ts`.

Step 5 — Enforce scope + persist inbound tasks in `handleSendMessage()`.
- Goal: explicit rejection for out-of-scope work; make accepted tasks pollable.
- Method: at the top of `handleSendMessage()` (before the queue branch), run
  `validateTaskScope(textOf(msg), meta)`. If out of scope, return a JSON-RPC
  result with an explicit rejection, e.g.
  `{ id: taskId, status: { state: "TASK_STATE_REJECTED" }, reason }`, and do NOT
  persist as queued. If in scope, persist an `A2ATask` (`status:"discovered"`,
  `peerId`/`peerUrl` from `meta` when present) before returning
  `TASK_STATE_SUBMITTED`. Do not disturb the handshake / `list-open-tasks` /
  `negotiate` / `completed` branches.
- Reference: `artifacts/api-server/src/routes/a2a.ts`.

Step 6 — Add `runCronTick()`.
- Goal: one iteration of the pipeline for serverless.
- Method: create `lib/src/workers/tick.ts` exporting
  `runCronTick(): Promise<CronTickResult>`. It performs, in order:
  (a) `discoverPeers()`; (b) acquisition pass — for each online peer
  `pollPeerTasks()` then `acquireTask()`; (c) local pass — for each inbound
  `A2ATask` with status `discovered`/`negotiating`, evaluate/accept and
  `executeAndSettle()`; (d) settlement pass — `executeAndSettle()` for
  `accepted` tasks; (e) finalize stale `open` negotiations (mark `expired` after
  `MAX_BARGAIN_ROUNDS`); (f) heartbeat — mark stale peers offline. Add a
  module-level in-flight guard so overlapping ticks cannot double-process. Return
  a summary (`{ discovered, acquired, executed, settled, rejected, errors }`).
  Export from `lib/src/index.ts`.
- Reference: new `lib/src/workers/tick.ts`, reusing `discovery.ts`, `pipeline.ts`,
  `manager.ts` loop bodies, `storage/index.ts`, `storage/wallet.ts`.

Step 7 — Add the cron route.
- Goal: `GET|POST /api/cron-tick` (and `/api/cron/tick`) triggers one tick.
- Method: create `artifacts/api-server/src/routes/cron.ts` exporting `cronRouter`
  with handlers for `/cron-tick` and `/cron/tick`. Auth: if
  `config.cron.secret` is set, require it via `Authorization: Bearer <secret>`
  (Vercel Cron's scheme) OR `?secret=` OR `x-cron-secret` header; otherwise 401.
  If unset, allow and log a warning. Call `runCronTick()` and return its summary
  as JSON (200). Wrap in try/catch → 500 `{ok:false,error}` (never crash). Mount
  in `app.ts` via `app.use("/api", cronRouter)` (JSON body parser already applies
  globally). Annotate handler params explicitly.
- Reference: new `artifacts/api-server/src/routes/cron.ts`,
  `artifacts/api-server/src/app.ts`.

Step 8 — Configure both triggers (Vercel native cron + external pinger).
- Goal: drive the tick from Vercel's own scheduler AND allow external pingers
  such as cron-job.org. **Decision: include both.**
- Method: add a `crons` array to `vercel.json`, e.g.
  `[{ "path": "/api/cron-tick", "schedule": "*/5 * * * *" }]`; set `CRON_SECRET`
  in Vercel env so Vercel's scheduler sends the bearer token automatically. The
  same endpoint accepts external pingers via `Authorization: Bearer <secret>`,
  `?secret=<secret>`, or the `x-cron-secret` header. Document that the Hobby plan
  limits cron frequency (daily on Hobby; finer schedules need Pro) — external
  pingers are the workaround.
- Reference: `vercel.json`.

Step 9 — Update docs and tests.
- Goal: keep repo memory and coverage correct.
- Method: update `AGENTS.md` (scope the "zero manual trigger" invariant to
  long-lived hosts; document the tick, `CRON_SECRET`, scope validator, and the
  new `performTask`); update `README.md` (HTTP surface table + serverless
  section). Add a unit test for `validateTaskScope` and `performTask` fallback in
  `tests/core.test.js`; add an integration test hitting `GET /api/cron-tick`
  (200 with secret, 401 without) in `tests/integration.test.js`.
- Reference: `AGENTS.md`, `README.md`, `tests/*.js`.

## Confirmed decisions
- **State persistence: Option A** — best-effort in-memory/`/tmp` state. No shared
  backend, no new dependencies. `runCronTick()` is structured so a future shared
  `Store` drops in without changing its signature.
- **Scope validator: deterministic denylist** in `lib/src/a2a/scope.ts` (fast,
  free, unit-testable). No LLM call.
- **Triggers: both** — Vercel native `crons` in `vercel.json` AND support for
  external pingers (cron-job.org) via the same `/api/cron-tick` endpoint.

## Build order (dependencies)
1. Step 1 (config `CRON_SECRET`) — unblocks Step 7.
2. Steps 2 & 3 (Agent Card, `performTask`) — independent.
3. Steps 4 & 5 (scope validator → enforce in `handleSendMessage` + persist
   inbound tasks) — Step 5 depends on Step 4.
4. Step 6 (`runCronTick`) — depends on Step 5's persisted tasks to be useful.
5. Step 7 (cron route) — depends on Steps 1 & 6.
6. Step 8 (`vercel.json` crons), Step 9 (docs/tests).

# 5. TESTING AND VALIDATION

Success looks like:
- `npm run typecheck` passes (strict; no unused/any).
- `npm test` passes: existing `core.test.js` and `integration.test.js` still
  green (they run with `GEMINI_API_KEY=""`, so `performTask()` must return its
  fallback string and the two-node pipeline must still settle).
- New unit tests: `validateTaskScope("post this to twitter")` →
  `inScope:false`; `validateTaskScope("summarize this JSON")` → `inScope:true`.
- New integration tests: `GET /api/cron-tick` returns 200 with the summary when
  `CRON_SECRET` matches (or is unset) and 401 when it is set and wrong; the
  response is JSON and the server does not crash.
- Live verification after redeploy:
  - `curl -s https://<deployment>/.well-known/agent-card.json | jq .skills` shows
    the corrected descriptions.
  - `curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://<deployment>/api/cron-tick | jq .`
    returns a tick summary.
  - Posting an out-of-scope task via `POST /a2a` (SendMessage with
    `parts:[{text:"scrape twitter and post a tweet"}]`) returns
    `TASK_STATE_REJECTED`, and an in-scope task returns `TASK_STATE_SUBMITTED`
    and appears in `GET /api/admin/tasks`.

Verification commands:
- `npm run build && npm run typecheck && npm test`
- `curl -s https://<deployment>/.well-known/agent-card.json | jq .`
- `curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://<deployment>/api/cron-tick | jq .`
