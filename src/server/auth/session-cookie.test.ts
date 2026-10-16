import { describe, expect, it } from "vitest";

import {
  refreshesSessionCookie,
  withoutSessionCookies,
} from "./session-cookie";

describe("refreshesSessionCookie", () => {
  it("refreshes on document navigations", () => {
    expect(
      refreshesSessionCookie(new Headers({ "sec-fetch-mode": "navigate" })),
    ).toBe(true);
  });

  it("skips fetches: prefetches, RSC navigations, server actions", () => {
    for (const mode of ["cors", "same-origin", "no-cors"]) {
      expect(
        refreshesSessionCookie(new Headers({ "sec-fetch-mode": mode })),
      ).toBe(false);
    }
  });

  it("keeps the default for clients without Fetch Metadata", () => {
    expect(refreshesSessionCookie(new Headers())).toBe(true);
  });
});

describe("withoutSessionCookies", () => {
  const response = (...cookies: string[]) => {
    const headers = new Headers({ "x-middleware-next": "1" });
    for (const cookie of cookies) headers.append("set-cookie", cookie);
    return new Response(null, { status: 200, headers });
  };

  it("drops session-token cookies, chunked and secure ones included", () => {
    const result = withoutSessionCookies(
      response(
        "authjs.session-token=abc; Path=/; HttpOnly",
        "__Secure-authjs.session-token.0=part; Path=/; Secure",
        "authjs.callback-url=%2F; Path=/",
      ),
    );
    expect(result.headers.getSetCookie()).toEqual([
      "authjs.callback-url=%2F; Path=/",
    ]);
    expect(result.headers.get("x-middleware-next")).toBe("1");
    expect(result.status).toBe(200);
  });

  it("returns the response untouched without a session cookie", () => {
    const original = response("authjs.csrf-token=x; Path=/");
    expect(withoutSessionCookies(original)).toBe(original);
  });
});
