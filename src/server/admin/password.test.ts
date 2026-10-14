import { describe, expect, it } from "vitest";

import { generatePassword, PASSWORD_ALPHABET } from "./password";

describe("generatePassword", () => {
  it("makes 12 characters without ambiguous ones (§5.4)", () => {
    for (let i = 0; i < 50; i++) {
      const password = generatePassword();
      expect(password).toHaveLength(12);
      expect(password).not.toMatch(/[0O1lI]/);
      expect([...password].every((c) => PASSWORD_ALPHABET.includes(c))).toBe(
        true,
      );
    }
  });

  it("uses the random source it is given", () => {
    expect(generatePassword(4, () => 0)).toBe("aaaa");
  });

  it("does not repeat itself", () => {
    const passwords = new Set(
      Array.from({ length: 100 }, () => generatePassword()),
    );
    expect(passwords.size).toBe(100);
  });
});
