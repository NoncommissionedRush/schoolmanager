/**
 * Auth.js re-issues the session cookie on every response the proxy handles.
 * Background requests — link prefetches, client-side (RSC) navigations,
 * server actions — can still be in flight when the user signs out; one that
 * lands afterwards would set the cookie again. So only document navigations
 * refresh the cookie. Sign-out also revokes the session server-side
 * (src/server/auth/session-store.ts) in case anything else races it.
 *
 * Next.js hides its RSC/prefetch headers from the proxy, so this goes by the
 * browser's Fetch Metadata instead.
 */
export function refreshesSessionCookie(headers: Headers): boolean {
  const mode = headers.get("sec-fetch-mode");
  // No Fetch Metadata (old browser, curl): keep Auth.js's default.
  return mode === null || mode === "navigate";
}

const SESSION_COOKIE = /^\s*(__Secure-)?authjs\.session-token(\.\d+)?=/;

/** Removes Auth.js session-token `Set-Cookie` headers (incl. chunks). */
export function withoutSessionCookies(response: Response): Response {
  const cookies = response.headers.getSetCookie();
  if (!cookies.some((cookie) => SESSION_COOKIE.test(cookie))) return response;
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  for (const cookie of cookies) {
    if (!SESSION_COOKIE.test(cookie)) headers.append("set-cookie", cookie);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
