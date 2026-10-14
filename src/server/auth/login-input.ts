import { normalizeEmail } from "./credentials";

export type LoginFieldErrors = {
  email?: "required" | "email";
  password?: "required";
};

export type LoginInput = { email: string; password: string };

// Deliberately loose: the server only needs "looks like an address".
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validates the login form; returns null when the fields are fine. */
export function validateLoginInput(input: {
  email: unknown;
  password: unknown;
}): { input: LoginInput; errors: LoginFieldErrors | null } {
  const email = normalizeEmail(
    typeof input.email === "string" ? input.email : "",
  );
  const password = typeof input.password === "string" ? input.password : "";
  const errors: LoginFieldErrors = {};
  if (!email) errors.email = "required";
  else if (!EMAIL_PATTERN.test(email)) errors.email = "email";
  if (!password) errors.password = "required";
  return {
    input: { email, password },
    errors: Object.keys(errors).length > 0 ? errors : null,
  };
}
