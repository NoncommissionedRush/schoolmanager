import NextAuth from "next-auth";
import { NextResponse } from "next/server";

import { authConfig } from "@/auth.config";
import { routeDecision } from "@/server/auth/roles";

const { auth } = NextAuth(authConfig);

/**
 * Coarse route protection from the session token: signed-out users go to
 * /login, each role area (`/admin`, `/teacher`, `/student`) answers 403 to
 * other roles. Pages and server actions re-check the membership in the
 * database (src/server/auth/session.ts).
 *
 * The role here is the one the token was issued with. After an admin changes
 * a user's role, the proxy keeps answering 403 on the new area (and lets the
 * old one through to pages, which then deny it) until the user signs in
 * again. That is safe — the database decides — just stale until re-login.
 */
export default auth((request) => {
  const { pathname, search } = request.nextUrl;
  const role = request.auth?.identity?.role ?? null;
  const hasSessionCookie = request.cookies
    .getAll()
    .some((cookie) => cookie.name.includes("authjs.session-token"));

  const decision = routeDecision({
    pathname,
    search,
    role,
    sessionExpired: !role && hasSessionCookie,
  });
  switch (decision.kind) {
    case "redirect":
      return NextResponse.redirect(new URL(decision.to, request.nextUrl));
    case "forbidden":
      return NextResponse.rewrite(new URL("/forbidden", request.nextUrl), {
        status: 403,
      });
    case "next":
      return NextResponse.next();
  }
});

export const config = {
  // Everything except Auth.js/API routes, Next internals and static files.
  matcher: ["/((?!api|logout|_next/static|_next/image|favicon.ico).*)"],
};
