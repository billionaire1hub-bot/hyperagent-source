import { createLogger } from "../logger";
import { backoffDelay, sleep } from "../retry";

export interface LoopOptions {
  /** Fixed interval between successful iterations, ms. */
  intervalMs: number;
  /** First backoff after an error, ms. */
  errorBackoffMs: number;
  /** Maximum backoff after repeated errors, ms. */
  maxBackoffMs: number;
  /** Run one iteration immediately on start (default true). */
  runImmediately?: boolean;
}

/** Snapshot of a loop's health, exposed via the admin status endpoint. */
export interface LoopStatus {
  name: string;
  running: boolean;
  iterations: number;
  consecutiveErrors: number;
  lastError: string | null;
  lastRunAt: string | null;
}

/**
 * A self-healing infinite loop.
 *
 * Guarantees a background worker can never terminate the process: iteration
 * errors are caught, logged and retried with capped exponential backoff, while
 * healthy iterations run on a fixed interval. `stop()` is only for tests.
 */
export class ResilientLoop {
  private readonly log;
  private running = false;
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;
  private consecutiveErrors = 0;
  private iterations = 0;
  private lastError: string | null = null;
  private lastRunAt: string | null = null;

  constructor(
    public readonly name: string,
    private readonly tick: (ctx: { iteration: number }) => Promise<void>,
    private readonly opts: LoopOptions,
  ) {
    this.log = createLogger(`worker:${name}`);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.log.info("worker started", { intervalMs: this.opts.intervalMs });
    if (this.opts.runImmediately ?? true) {
      void this.schedule(0);
    } else {
      void this.schedule(this.opts.intervalMs);
    }
  }

  private async schedule(delayMs: number): Promise<void> {
    if (this.stopping) return;
    this.timer = setTimeout(() => void this.runOnce(), delayMs);
    // Do not let a pending worker timer keep the process alive on shutdown.
    this.timer.unref?.();
  }

  private async runOnce(): Promise<void> {
    if (this.stopping) return;
    this.iterations++;
    this.lastRunAt = new Date().toISOString();
    try {
      await this.tick({ iteration: this.iterations });
      this.consecutiveErrors = 0;
      this.lastError = null;
      void this.schedule(this.opts.intervalMs);
    } catch (err) {
      this.consecutiveErrors++;
      this.lastError = (err as Error)?.message ?? String(err);
      const delay = Math.min(
        this.opts.maxBackoffMs,
        backoffDelay(this.consecutiveErrors, this.opts.errorBackoffMs, this.opts.maxBackoffMs),
      );
      this.log.error("iteration failed; backing off", {
        error: this.lastError,
        consecutiveErrors: this.consecutiveErrors,
        retryInMs: delay,
      });
      void this.schedule(delay);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Give any in-flight iteration a moment to observe the stop flag.
    await sleep(0);
  }

  status(): LoopStatus {
    return {
      name: this.name,
      running: this.running,
      iterations: this.iterations,
      consecutiveErrors: this.consecutiveErrors,
      lastError: this.lastError,
      lastRunAt: this.lastRunAt,
    };
  }
}
