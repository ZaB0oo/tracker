import { describe, expect, it } from "vitest";
import { RateLimiter, RetryableError } from "../osu/rateLimiter.js";

/** Virtual clock: time only advances via sleep(). */
function virtualClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

describe("RateLimiter", () => {
  it("never exceeds 60 req/min (interval >= 1000ms)", async () => {
    const clock = virtualClock();
    const rl = new RateLimiter(60, 3, clock.now, clock.sleep);
    const starts: number[] = [];
    await Promise.all(
      Array.from({ length: 10 }, () =>
        rl.schedule(async () => starts.push(clock.now()))
      )
    );
    expect(starts).toHaveLength(10);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(1000);
    }
    // sliding 60s window: never more than 60 starts
    expect(starts[starts.length - 1]).toBeGreaterThanOrEqual(9 * 1000);
  });

  it("high priority goes before the low queue", async () => {
    const clock = virtualClock();
    const rl = new RateLimiter(60, 3, clock.now, clock.sleep);
    const order: string[] = [];
    const jobs = [
      rl.schedule(async () => order.push("low1"), "low"),
      rl.schedule(async () => order.push("low2"), "low"),
      rl.schedule(async () => order.push("high1"), "high"),
    ];
    await Promise.all(jobs);
    // low1 starts immediately (empty queue), but high1 jumps ahead of low2
    expect(order.indexOf("high1")).toBeLessThan(order.indexOf("low2"));
  });

  it("retries on RetryableError with backoff, then succeeds", async () => {
    const clock = virtualClock();
    const rl = new RateLimiter(60, 5, clock.now, clock.sleep);
    let attempts = 0;
    const result = await rl.schedule(async () => {
      attempts++;
      if (attempts < 3) throw new RetryableError("boom");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("respecte Retry-After d'un 429", async () => {
    const clock = virtualClock();
    const rl = new RateLimiter(60, 5, clock.now, clock.sleep);
    let attempts = 0;
    let secondStart = 0;
    await rl.schedule(async () => {
      attempts++;
      if (attempts === 1) throw new RetryableError("429", 30_000);
      secondStart = clock.now();
    });
    expect(secondStart).toBeGreaterThanOrEqual(30_000);
  });

  it("gives up after maxRetries", async () => {
    const clock = virtualClock();
    const rl = new RateLimiter(60, 2, clock.now, clock.sleep);
    await expect(
      rl.schedule(async () => {
        throw new RetryableError("permanent");
      })
    ).rejects.toThrow("permanent");
  });

  it("non-retryable errors surface immediately", async () => {
    const clock = virtualClock();
    const rl = new RateLimiter(60, 5, clock.now, clock.sleep);
    let attempts = 0;
    await expect(
      rl.schedule(async () => {
        attempts++;
        throw new Error("fatal");
      })
    ).rejects.toThrow("fatal");
    expect(attempts).toBe(1);
  });
});
