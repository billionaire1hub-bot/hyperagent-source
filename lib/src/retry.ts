/** Retry / backoff helpers so background loops degrade gracefully instead of dying. */

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onError?: (err: unknown, attempt: number) => void;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with full jitter, capped at maxDelayMs. */
export function backoffDelay(
  attempt: number,
  baseDelayMs = 1000,
  maxDelayMs = 60000,
): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.random() * exp * 0.25;
  return Math.round(exp - jitter);
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  const base = opts.baseDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 60000;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      opts.onError?.(err, attempt);
      if (attempt > retries) break;
      await sleep(backoffDelay(attempt, base, max));
    }
  }
  throw lastErr;
}

/** fetch() with an AbortController-based timeout. Works on Node >=18. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 10000,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
