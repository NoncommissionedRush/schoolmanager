import type { NextAuthConfig } from "next-auth";
import type {} from "next-auth/jwt";

import type { SessionIdentity } from "@/server/auth/credentials";
import { LOGIN_PATH, type Role } from "@/server/auth/roles";

declare module "next-auth" {
  interface User {
    schoolId?: string;
    role?: Role;
  }
  interface Session {
    /** Who is signed in and in which school; verified against the DB per request. */
    identity?: SessionIdentity;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    schoolId?: string;
    role?: Role;
  }
}

/**
 * Auth.js options shared by the proxy and the server. Providers live in
 * `src/auth.ts`, so the proxy stays free of database and bcrypt imports.
 * Sessions are stateless JWT cookies (required by the credentials
 * provider); OAuth or magic-link providers can be added in `src/auth.ts`
 * together with `@auth/prisma-adapter` (the `accounts` and
 * `verification_tokens` tables already exist).
 */
export const authConfig = {
  pages: { signIn: LOGIN_PATH },
  session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60 },
  trustHost: true,
  providers: [],
  callbacks: {
    jwt({ token, user }) {
      if (user?.id && user.schoolId && user.role) {
        token.userId = user.id;
        token.schoolId = user.schoolId;
        token.role = user.role;
      }
      return token;
    },
    session({ session, token }) {
      if (token.userId && token.schoolId && token.role) {
        session.identity = {
          userId: token.userId,
          schoolId: token.schoolId,
          role: token.role,
        };
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
