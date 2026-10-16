import "server-only";

import { cacheLife, cacheTag } from "next/cache";

import { db } from "@/lib/db";
import { scopeToSchool } from "@/server/db/school-scope";

import { countNeedsCover } from "./service";

/** Cache tag of a school's needs-cover count. */
export const needsCoverTag = (schoolId: string) => `needs-cover:${schoolId}`;

/**
 * The needs-cover count (`countNeedsCover`) for the admin dashboard and the
 * tab label, cached per school for a minute: it loads 8 weeks of the
 * timetable. Substitute and availability actions expire it right away
 * (`updateTag(needsCoverTag(…))`); other changes (timetable, archiving)
 * show within a minute. The _Needs cover_ list itself is never cached.
 *
 * Callers pass the viewer's school id from `requireRole`/`adminContext`.
 */
export async function cachedNeedsCoverCount(schoolId: string): Promise<number> {
  "use cache";
  cacheTag(needsCoverTag(schoolId));
  cacheLife({ stale: 60, revalidate: 60, expire: 300 });
  return countNeedsCover(scopeToSchool(db, schoolId), new Date());
}
