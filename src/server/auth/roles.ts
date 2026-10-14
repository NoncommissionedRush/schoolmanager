import type { Role } from "@/generated/prisma/enums";

export type { Role };

/** Each role has its own area of the app; `/admin/*` is admin-only etc. */
export const ROLE_HOME: Record<Role, string> = {
  ADMIN: "/admin",
  TEACHER: "/teacher",
  STUDENT: "/student",
};

export const LOGIN_PATH = "/login";

const ROLE_AREAS = Object.entries(ROLE_HOME) as [Role, string][];

/** The role whose area `pathname` belongs to, or null for shared pages. */
export function areaRole(pathname: string): Role | null {
  for (const [role, home] of ROLE_AREAS) {
    if (pathname === home || pathname.startsWith(`${home}/`)) return role;
  }
  return null;
}

/**
 * Validates a post-login return path: only same-origin absolute paths, never
 * protocol-relative (`//evil.test`) or back-slash tricks, and never `/login`.
 */
export function safeCallbackPath(
  value: string | null | undefined,
): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return null;
  if (value.includes("\\")) return null;
  if (value === LOGIN_PATH || value.startsWith(`${LOGIN_PATH}?`)) return null;
  return value;
}

/** Where a signed-in user goes after login: the callback if their role may open it. */
export function postLoginPath(
  role: Role,
  callbackUrl: string | null | undefined,
): string {
  const path = safeCallbackPath(callbackUrl);
  if (!path) return ROLE_HOME[role];
  const area = areaRole(new URL(path, "http://x").pathname);
  return area === null || area === role ? path : ROLE_HOME[role];
}

export type RouteDecision =
  { kind: "next" } | { kind: "redirect"; to: string } | { kind: "forbidden" };

/**
 * Coarse, per-request route protection (run in `src/proxy.ts`). Pages and
 * server actions still verify the membership against the database — this
 * only decides from the session token.
 */
export function routeDecision({
  pathname,
  search,
  role,
  sessionExpired,
}: {
  pathname: string;
  search: string;
  /** Role from the session token; null when signed out. */
  role: Role | null;
  /** A session cookie was sent but is no longer valid. */
  sessionExpired: boolean;
}): RouteDecision {
  const params = new URLSearchParams(search);

  if (pathname === LOGIN_PATH) {
    return role
      ? { kind: "redirect", to: postLoginPath(role, params.get("callbackUrl")) }
      : { kind: "next" };
  }

  if (!role) {
    const login = new URLSearchParams();
    if (pathname !== "/") login.set("callbackUrl", pathname + search);
    else if (params.get("callbackUrl"))
      login.set("callbackUrl", params.get("callbackUrl")!);
    if (sessionExpired) login.set("reason", "expired");
    const query = login.toString();
    return {
      kind: "redirect",
      to: query ? `${LOGIN_PATH}?${query}` : LOGIN_PATH,
    };
  }

  if (pathname === "/") {
    return {
      kind: "redirect",
      to: postLoginPath(role, params.get("callbackUrl")),
    };
  }

  const area = areaRole(pathname);
  if (area !== null && area !== role) return { kind: "forbidden" };
  return { kind: "next" };
}
