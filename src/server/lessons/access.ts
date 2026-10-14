import type { Prisma } from "@/generated/prisma/client";
import type { SchoolDb } from "@/server/timetable/service";

// Who may open which lesson (lessons.md §2). Every lesson query of the
// teacher pages and actions goes through `teacherLessonWhere`; the caller's
// `db` is already scoped to the school.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string) => UUID.test(value);

/**
 * Lessons a teacher may open: the ones they teach or substitute, in a
 * published term (like the weekly timetable). Anything else is "not found".
 */
export function teacherLessonWhere(teacherId: string): Prisma.LessonWhereInput {
  return {
    OR: [{ teacherId }, { substituteTeacherId: teacherId }],
    term: { timetablePublishedAt: { not: null } },
  };
}

/** The signed-in teacher's profile id in this school, or null. */
export async function teacherProfileId(
  db: SchoolDb,
  userId: string,
): Promise<string | null> {
  const profile = await db.teacherProfile.findFirst({
    where: { userId },
    select: { id: true },
  });
  return profile?.id ?? null;
}

/**
 * The lesson's group if `teacherId` may open it, otherwise null (also for
 * malformed ids, so they read as "not found", CARM-32).
 */
export async function findTeacherLessonGroup(
  db: SchoolDb,
  teacherId: string | null,
  lessonId: string,
): Promise<{ id: string; groupId: string } | null> {
  if (!teacherId || !isUuid(lessonId)) return null;
  return db.lesson.findFirst({
    where: { AND: [{ id: lessonId }, teacherLessonWhere(teacherId)] },
    select: { id: true, groupId: true },
  });
}
