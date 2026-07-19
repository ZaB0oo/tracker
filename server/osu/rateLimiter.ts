/**
 * Global rate limiter for the osu! API.
 *
 * - Max rate: `rpm` requests/minute, smoothed (min interval = 60000/rpm ms).
 *   Never any burst: this is the strict reading of the "60/min" terms of use.
 * - Two priority levels: "high" (polling of new scores) always goes before
 *   "low" (backfill).
 * - Backoff: on 429 we honor Retry-After (otherwise exponential backoff), on
 *   5xx/network exponential backoff with jitter, max `maxRetries` attempts.
 */

export type Priority = "high" | "low";

interface Job<T> {
  run: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

export class RetryableError extends Error {
  constructor(message: string, public retryAfterMs?: number) {
    super(message);
  }
}

export class RateLimiter {
  private high: Job<unknown>[] = [];
  private low: Job<unknown>[] = [];
  private running = false;
  private lastStart = 0;
  private penaltyUntil = 0;
  private _minIntervalMs: number;

  constructor(
    rpm: number,
    private maxRetries = 8,
    private now: () => number = Date.now,
    private sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms))
  ) {
    this._minIntervalMs = Math.ceil(60_000 / rpm);
  }

  get minIntervalMs(): number {
    return this._minIntervalMs;
  }

  /** Change the rate on the fly (UI setting). Capped at 60 req/min max. */
  setRpm(rpm: number): void {
    const clamped = Math.min(Math.max(rpm, 1), 60);
    this._minIntervalMs = Math.ceil(60_000 / clamped);
  }

  get queueSizes() {
    return { high: this.high.length, low: this.low.length };
  }

  schedule<T>(fn: () => Promise<T>, priority: Priority = "low"): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: Job<T> = { run: () => this.withRetries(fn), resolve, reject };
      (priority === "high" ? this.high : this.low).push(job as Job<unknown>);
      void this.pump();
    });
  }

  private async withRetries<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    // The loop runs INSIDE the job's slot: retries go back through the global rate.
    for (;;) {
      try {
        return await fn();
      } catch (e) {
        attempt++;
        if (!(e instanceof RetryableError) || attempt > this.maxRetries) throw e;
        const backoff =
          e.retryAfterMs ??
          Math.min(60_000, 1000 * 2 ** attempt) + Math.random() * 500;
        this.penaltyUntil = Math.max(this.penaltyUntil, this.now() + backoff);
        await this.waitForSlot();
      }
    }
  }

  private async waitForSlot(): Promise<void> {
    for (;;) {
      const now = this.now();
      const next = Math.max(this.lastStart + this.minIntervalMs, this.penaltyUntil);
      if (now >= next) {
        this.lastStart = now;
        return;
      }
      await this.sleep(next - now);
    }
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const job = this.high.shift() ?? this.low.shift();
        if (!job) break;
        await this.waitForSlot();
        try {
          job.resolve(await job.run());
        } catch (e) {
          job.reject(e);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
