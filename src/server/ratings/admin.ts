import "server-only";

// Every function that reads other people's ratings (phase5-rules.md §4.4).
// Each starts with `requireRole("ADMIN")` (via `adminContext`) and queries
// through the school-scoped client. Only src/app/admin/** and
// src/server/ratings/** may import this file (ratings.test.ts).

import { adminContext } from "@/server/admin/context";

import {
  loadRatingsOverview,
  loadTeacherRatings,
  parseShown,
  type RatingsOverview,
  type TeacherRatingsDetail,
} from "./admin-data";

export type {
  AdminRating,
  AdminTerm,
  HiddenRating,
  RatingsOverview,
  RatingsOverviewRow,
  TeacherRatingsDetail,
} from "./admin-data";

/** `/admin/ratings`. */
export async function adminRatingsOverview(
  termId: string | undefined,
): Promise<RatingsOverview> {
  const { db } = await adminContext();
  return loadRatingsOverview(db, termId, new Date());
}

/** `/admin/ratings/[teacherId]`; null → 404. */
export async function adminTeacherRatings(
  teacherId: string,
  params: { term?: string; group?: string; shown?: string },
): Promise<TeacherRatingsDetail | null> {
  const { db } = await adminContext();
  return loadTeacherRatings(
    db,
    teacherId,
    {
      termId: params.term,
      groupId: params.group,
      shown: parseShown(params.shown),
    },
    new Date(),
  );
}
