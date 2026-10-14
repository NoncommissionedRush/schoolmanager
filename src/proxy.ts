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
