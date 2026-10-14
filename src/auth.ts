import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { authConfig } from "@/auth.config";
import { verifyCredentials } from "@/server/auth/credentials";
import { verifyPassword } from "@/server/auth/password";
import { findCredentialUser } from "@/server/auth/users";

/** Thrown from `authorize`; `code` reaches the login action. */
class AccountDisabled extends CredentialsSignin {
  code = "disabled";
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(credentials) {
        const result = await verifyCredentials(
          {
            email: String(credentials.email ?? ""),
            password: String(credentials.password ?? ""),
          },
          { verifyPassword, findUserByEmail: findCredentialUser },
        );
        if (!result.ok) {
          if (result.reason === "disabled") throw new AccountDisabled();
          return null;
        }
        const { userId, schoolId, role } = result.identity;
        return { id: userId, schoolId, role };
      },
    }),
  ],
});
