/**
 * Fixed-window limiter for failed sign-ins, keyed by email and by client IP.
 * Known v1 limits:
 * - In-memory, so it is per server process — enough for a single-instance
 *   deployment; move to Postgres/Redis before running several instances.
 * - The IP key comes from the first `X-Forwarded-For` entry, which the client
 *   controls unless a trusted proxy overwrites it; behind a real proxy, key
 *   on the address that proxy appends instead.
 * - The per-email limit lets anyone lock a known account out for the window
 *   (10 failures → 15 minutes). Accepted for v1; revisit with per-IP+email
 *   keys or progressive delays.
 */
export class FailedAttemptLimiter {
  private readonly attempts = new Map<
    string,
    { count: number; resetAt: number }
  >();

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  isLimited(keys: string[]): boolean {
    const now = this.now();
    return keys.some((key) => {
      const entry = this.attempts.get(key);
      return !!entry && entry.resetAt > now && entry.count >= this.maxFailures;
    });
  }

  recordFailure(keys: string[]): void {
    const now = this.now();
    for (const key of keys) {
      const entry = this.attempts.get(key);
      if (!entry || entry.resetAt <= now) {
        this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
      } else {
        entry.count += 1;
      }
    }
    if (this.attempts.size > 10_000) this.prune(now);
  }

  reset(keys: string[]): void {
    for (const key of keys) this.attempts.delete(key);
  }

  private prune(now: number) {
    for (const [key, entry] of this.attempts) {
      if (entry.resetAt <= now) this.attempts.delete(key);
    }
  }
}
