import { describe, expect, it } from "vitest";

import { validateLoginInput } from "./login-input";

describe("validateLoginInput", () => {
  it("normalizes valid input", () => {
    expect(validateLoginInput({ email: " A@B.Test ", password: "pw" })).toEqual(
      { input: { email: "a@b.test", password: "pw" }, errors: null },
    );
  });

  it("requires both fields", () => {
    expect(validateLoginInput({ email: "", password: null }).errors).toEqual({
      email: "required",
      password: "required",
    });
  });

  it("rejects malformed emails", () => {
    expect(
      validateLoginInput({ email: "not-an-email", password: "pw" }).errors,
    ).toEqual({ email: "email" });
  });
});
