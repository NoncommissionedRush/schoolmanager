import { expect, test } from "@playwright/test";

import { crossSchoolCases } from "./action-cases";
import {
  LOGINS,
  SCHOOL_A,
  type SchoolIds,
  schoolIds,
  signedIn,
} from "./fixtures";
import { callAction, pagesIn } from "../server-actions";

// CARM-32: admin actions called with ids that aren't UUIDs refuse cleanly
// (not found) instead of failing in Postgres with a 500. Every admin action
// from the cross-school cases runs once, with all of the target's ids
// replaced by junk.

const MALFORMED = "nonsense";

test("an admin's malformed ids are refused as not found", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const own = await schoolIds(SCHOOL_A);
  const junk = Object.fromEntries(
    Object.keys(own).map((key) => [key, MALFORMED]),
  ) as SchoolIds;
  const page = await signedIn(browser, LOGINS.A.admin, "admin");
  // In dev every route compiles on first request (a no-op on a build).
  for (const path of pagesIn("src/app/admin")) await page.request.get(path);

  for (const c of crossSchoolCases(junk, own)) {
    const { status, result } = await callAction(page, c.action, c.args);
    expect(status, c.name).toBe(200);
    expect(result?.ok, c.name).toBe(false);
    if (c.args[0] === MALFORMED) {
      // The malformed id is the action's own argument: not found.
      expect(result?.formError, c.name).toMatchObject({
        key: expect.stringMatching(
          /^(common\.error\.notFound|scheduling\.errors\.NOT_FOUND)$/,
        ),
      });
    } else {
      // It sits in a form or a slot payload: refused by that validation.
      expect(result?.fieldErrors ?? result?.formError, c.name).toBeTruthy();
    }
  }
});
