import { config } from "../config";
import { createLogger } from "../logger";
import { ResilientLoop } from "./resilientLoop";
import { discoverPeers, pollPeerTasks } from "../a2a/discovery";
import { acquireTask, executeAndSettle } from "./pipeline";
import { store } from "../storage";

const log = createLogger("workers");

/** Result of one full autonomous pipeline pass. */
export interface CycleResult {
  discovered: number;
  online: number;
  peersPolled: number;
  tasksAcquired: number;
  tasksSettled: number;
  errors: number;
  /** True when the tick hit its wall-clock budget and deferred remaining work. */
  budgetExceeded?: boolean;
}

/**
 * Phase 1 + 2: find active agents globally and handshake with them.
 */
export async function runDiscovery(): Promise<{ discovered: number; online: number }> {
  return discoverPeers();
}

/**
 * Phase 2 + 3: poll online peers for tasks, value them, negotiate, accept.
 * One bad peer never stops the others.
 */
export async function runAcquisition(): Promise<{ peersPolled: number; acquired: number; errors: number }> {
  const peers = await store.peers.find((p) => p.status === "online");
  let acquired = 0;
  let errors = 0;
  for (const peer of peers) {
    try {
      const remoteTasks = await pollPeerTasks(peer);
      for (const remote of remoteTasks) {
        const result = await acquireTask(peer, remote);
        if (result?.accepted) {
          acquired++;
          log.info("task acquired", { taskId: result.task.id });
        }
      }
    } catch (err) {
      // One bad peer must not stop the others.
      errors++;
      log.warn("peer acquisition failed", {
        peer: peer.id,
        error: (err as Error).message,
      });
    }
  }
  return { peersPolled: peers.length, acquired, errors };
}

/** Phase 4: execute accepted tasks and settle earnings via Whop. */
export async function runSettlement(opts: { deadline?: number } = {}): Promise<{
  settled: number;
  errors: number;
  deferred: number;
}> {
  const accepted = await store.tasks.find((t) => t.status === "accepted");
  let settled = 0;
  let errors = 0;
  let deferred = 0;
  for (const task of accepted) {
    // Defer remaining work when the wall-clock budget is spent; the task stays
    // `accepted` and the next tick picks it up.
    if (opts.deadline && Date.now() >= opts.deadline) {
      deferred = accepted.length - settled - errors;
      log.warn("settlement budget reached; deferring remaining tasks", { deferred });
      break;
    }
    try {
      await executeAndSettle(task);
      settled++;
    } catch (err) {
      errors++;
      log.error("settlement failed", {
        taskId: task.id,
        error: (err as Error).message,
      });
    }
  }
  return { settled, errors, deferred };
}

/** Heartbeat: mark stale online peers offline. */
export async function runMaintenance(): Promise<void> {
  const peers = await store.peers.all();
  const cutoff = Date.now() - config.a2a.discoveryIntervalMs * 10;
  for (const peer of peers) {
    if (new Date(peer.lastSeen).getTime() < cutoff && peer.status === "online") {
      await store.peers.update(peer.id, { status: "offline" });
    }
  }
}

/**
 * Run one full autonomous pass: discover -> acquire/negotiate -> settle ->
 * maintain. This is the exact body the background loops run, exposed so a
 * serverless platform (Vercel Cron) can drive it with a scheduled HTTP request
 * instead of an in-process loop. Never throws — each phase is isolated so a
 * failure in one does not abort the others.
 */
export async function runPipelineCycle(opts: { deadline?: number } = {}): Promise<CycleResult> {
  const result: CycleResult = {
    discovered: 0,
    online: 0,
    peersPolled: 0,
    tasksAcquired: 0,
    tasksSettled: 0,
    errors: 0,
  };

  try {
    const discovery = await runDiscovery();
    result.discovered = discovery.discovered;
    result.online = discovery.online;
  } catch (err) {
    result.errors++;
    log.error("discovery phase failed", { error: (err as Error).message });
  }

  try {
    const acquisition = await runAcquisition();
    result.peersPolled = acquisition.peersPolled;
    result.tasksAcquired = acquisition.acquired;
    result.errors += acquisition.errors;
  } catch (err) {
    result.errors++;
    log.error("acquisition phase failed", { error: (err as Error).message });
  }

  try {
    const settlement = await runSettlement({ deadline: opts.deadline });
    result.tasksSettled = settlement.settled;
    result.errors += settlement.errors;
    if (settlement.deferred > 0) result.budgetExceeded = true;
  } catch (err) {
    result.errors++;
    log.error("settlement phase failed", { error: (err as Error).message });
  }

  try {
    await runMaintenance();
  } catch (err) {
    result.errors++;
    log.warn("maintenance phase failed", { error: (err as Error).message });
  }

  return result;
}

/**
 * Owns every background loop for the node and starts them on process boot.
 *
 * This is the "zero manual trigger" entry point (requirement 4): nothing here
 * is exposed as an HTTP endpoint to kick off; it runs continuously.
 *
 * Together the loops implement the end-to-end acquisition pipeline
 * (requirement 3), always on:
 *   Phase 1  Discovery            -> discoveryLoop (poll registries + seeds)
 *   Phase 2  Outreach & handshake -> discoveryLoop (handshake) + acquisitionLoop
 *   Phase 3  Evaluation & pricing -> acquisitionLoop -> acquireTask -> evaluateOffer
 *   Phase 4  Bargaining & settle  -> acquireTask (runBargain) + settlementLoop
 *
 * On a serverless host there is no long-lived process to hold these loops, so
 * `start()` is skipped and `runPipelineCycle()` is driven by a cron tick instead.
 */
export class WorkerManager {
  private loops: ResilientLoop[] = [];
  private started = false;

  /** Phase 1 + 2: find active agents globally and handshake with them. */
  private discoveryLoop(): ResilientLoop {
    return new ResilientLoop("discovery", async () => void (await runDiscovery()), {
      intervalMs: config.a2a.discoveryIntervalMs,
      errorBackoffMs: config.workers.errorBackoffMs,
      maxBackoffMs: config.workers.maxBackoffMs,
    });
  }

  /** Phase 2 + 3: poll online peers for tasks, value them, negotiate, accept. */
  private acquisitionLoop(): ResilientLoop {
    return new ResilientLoop("acquisition", async () => void (await runAcquisition()), {
      intervalMs: config.a2a.discoveryIntervalMs,
      errorBackoffMs: config.workers.errorBackoffMs,
      maxBackoffMs: config.workers.maxBackoffMs,
    });
  }

  /** Phase 4: execute accepted tasks and settle earnings via Whop. */
  private settlementLoop(): ResilientLoop {
    return new ResilientLoop("settlement", async () => void (await runSettlement()), {
      intervalMs: config.workers.settlementIntervalMs,
      errorBackoffMs: config.workers.errorBackoffMs,
      maxBackoffMs: config.workers.maxBackoffMs,
    });
  }

  /** Heartbeat: keep peer liveness fresh and prune stale peers. */
  private heartbeatLoop(): ResilientLoop {
    return new ResilientLoop("heartbeat", async () => runMaintenance(), {
      intervalMs: config.a2a.discoveryIntervalMs * 5,
      errorBackoffMs: config.workers.errorBackoffMs,
      maxBackoffMs: config.workers.maxBackoffMs,
      runImmediately: false,
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.loops = [
      this.discoveryLoop(),
      this.acquisitionLoop(),
      this.settlementLoop(),
      this.heartbeatLoop(),
    ];
    for (const loop of this.loops) loop.start();
    log.info("all background workers started", {
      loops: this.loops.map((l) => l.name),
    });
  }

  async stop(): Promise<void> {
    await Promise.all(this.loops.map((l) => l.stop()));
    this.started = false;
  }

  status() {
    return {
      started: this.started,
      loops: this.loops.map((l) => l.status()),
    };
  }
}

export const workerManager = new WorkerManager();
