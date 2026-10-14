import { describe, expect, it } from "vitest";

import { FailedAttemptLimiter } from "./rate-limit";

describe("FailedAttemptLimiter", () => {
  it("limits after the maximum number of failures within the window", () => {
    let now = 0;
    const limiter = new FailedAttemptLimiter(3, 1000, () => now);
    for (let i = 0; i < 2; i++) limiter.recordFailure(["a"]);
    expect(limiter.isLimited(["a"])).toBe(false);
    limiter.recordFailure(["a"]);
    expect(limiter.isLimited(["a"])).toBe(true);
    expect(limiter.isLimited(["b"])).toBe(false);
    expect(limiter.isLimited(["b", "a"])).toBe(true);

    now = 1000;
    expect(limiter.isLimited(["a"])).toBe(false);
  });

  it("starts over after a reset", () => {
    const limiter = new FailedAttemptLimiter(1, 1000, () => 0);
    limiter.recordFailure(["a"]);
    expect(limiter.isLimited(["a"])).toBe(true);
    limiter.reset(["a"]);
    expect(limiter.isLimited(["a"])).toBe(false);
  });
});
