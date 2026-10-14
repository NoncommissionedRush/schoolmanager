"use server";

import { AuthError, CredentialsSignin } from "next-auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { signIn } from "@/auth";
import {
  validateLoginInput,
  type LoginFieldErrors,
} from "@/server/auth/login-input";
import { FailedAttemptLimiter } from "@/server/auth/rate-limit";
import { LOGIN_PATH, postLoginPath } from "@/server/auth/roles";
import { findCredentialUser } from "@/server/auth/users";

export type LoginState = {
  email?: string;
  fieldErrors?: LoginFieldErrors;
  error?: "invalid" | "disabled" | "rateLimited" | "server";
};

// Failed attempts per account and, more generously, per client address.
const emailLimiter = new FailedAttemptLimiter(10);
const ipLimiter = new FailedAttemptLimiter(100);

export async function login(
  _previous: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const { input, errors } = validateLoginInput({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (errors) return { email: input.email, fieldErrors: errors };

  const ip =
    (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const emailKey = [input.email];
  const ipKey = [ip];
  if (emailLimiter.isLimited(emailKey) || ipLimiter.isLimited(ipKey)) {
    return { email: input.email, error: "rateLimited" };
  }

  try {
    await signIn("credentials", { ...input, redirect: false });
  } catch (error) {
    if (error instanceof CredentialsSignin) {
      emailLimiter.recordFailure(emailKey);
      ipLimiter.recordFailure(ipKey);
      return {
        email: input.email,
        error: error.code === "disabled" ? "disabled" : "invalid",
      };
    }
    if (error instanceof AuthError) {
      console.error("Sign-in failed", error);
      return { email: input.email, error: "server" };
    }
    throw error;
  }
  emailLimiter.reset(emailKey);

  // `auth()` can't see the cookie `signIn` just set (it reads the request),
  // so look up the role the session was issued for. Go to the callback if
  // the role may open it, else to the role's dashboard.
  const role = (await findCredentialUser(input.email))?.memberships[0]?.role;
  redirect(
    role
      ? postLoginPath(role, formData.get("callbackUrl")?.toString())
      : LOGIN_PATH,
  );
}
