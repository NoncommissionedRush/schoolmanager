import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "./password";

describe("password hashing", () => {
  it("verifies the original password only", async () => {
    const hash = await hashPassword("correct horse");
    expect(hash).not.toContain("correct horse");
    await expect(verifyPassword("correct horse", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong horse", hash)).resolves.toBe(false);
  });
});
