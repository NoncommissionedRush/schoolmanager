// Loads the plain facts the rating rules need (phase5-rules.md §4.1): a
// student's attendance, their ended lessons in some terms, and which
// teachers can still be rated. Shared by the student and admin services;
// reads no ratings itself.

import { ACTIVE_REPLACEMENT } from "@/server/replacements/release";
import { toIsoDate } from "@/server/scheduling";
import type { Tx } from "@/server/timetable/service";
import { membershipLessonWhere } from "@/server/timetable/views";

import type { RatingLesson, RatingTerm, StudentAttendance } from "./rules";

export type StudentFacts = StudentAttendance & { studentId: string };

/** The student's profile id and attendance facts, or null without a profile. */
export async function loadStudentFacts(
  db: Tx,
  userId: string,
): Promise<StudentFacts | null> {
  const profile = await db.studentProfile.findFirst({
    where: { userId },
    select: {
      id: true,
      groupMemberships: {
        select: { groupId: true, joinedAt: true, leftAt: true },
      },
      replacementRequests: {
        where: { status: { in: [...ACTIVE_REPLACEMENT] } },
        select: { targetLessonId: true },
      },
      absenceReports: { select: { lessonId: true } },
    },
  });
  if (!profile) return null;
  return {
    studentId: profile.id,
    memberships: profile.groupMemberships,
    replacementLessonIds: new Set(
      profile.replacementRequests.map((r) => r.targetLessonId),
    ),
    absentLessonIds: new Set(profile.absenceReports.map((a) => a.lessonId)),
  };
}

export type RatingLessonRow = RatingLesson & { groupName: string };

/**
 * Ended, not cancelled lessons of `termIds` the student could have attended
 * (member of the group, or booked into it); `attendedLessons` applies the
 * exact rule.
 */
export async function loadEndedLessons(
  db: Tx,
  student: StudentFacts,
  termIds: readonly string[],
  now: Date,
): Promise<RatingLessonRow[]> {
  if (termIds.length === 0) return [];
  const booked = [...student.replacementLessonIds];
  const rows = await db.lesson.findMany({
    where: {
      termId: { in: [...termIds] },
      endsAt: { lte: now },
      status: { not: "CANCELLED" },
      term: { timetablePublishedAt: { not: null } },
      OR: [
        membershipLessonWhere(student.memberships),
        ...(booked.length > 0 ? [{ id: { in: booked } }] : []),
      ],
    },
    select: {
      id: true,
      termId: true,
      groupId: true,
      teacherId: true,
      substituteTeacherId: true,
      startsAt: true,
      endsAt: true,
      status: true,
      group: { select: { name: true } },
    },
  });
  return rows.map(({ group, ...row }) => ({ ...row, groupName: group.name }));
}

export type TermRow = RatingTerm & { name: string };

/** Published terms, oldest first. */
export async function loadPublishedTerms(db: Tx): Promise<TermRow[]> {
  const rows = await db.term.findMany({
    where: { timetablePublishedAt: { not: null } },
    select: { id: true, name: true, startDate: true, endDate: true },
    orderBy: [{ startDate: "asc" }, { id: "asc" }],
  });
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    startDate: toIsoDate(t.startDate),
    endDate: toIsoDate(t.endDate),
  }));
}

export type TeacherRow = { id: string; name: string; active: boolean };

/**
 * Teachers by profile id: name, and `active` = not deleted and still a
 * `TEACHER` member of the school (archived teachers can't be rated).
 */
export async function loadTeachers(
  db: Tx,
  ids?: readonly string[],
): Promise<Map<string, TeacherRow>> {
  const profiles = await db.teacherProfile.findMany({
    where: ids ? { id: { in: [...ids] } } : {},
    select: {
      id: true,
      userId: true,
      user: { select: { name: true, deletedAt: true } },
    },
  });
  const teachers = new Set(
    (
      await db.membership.findMany({
        where: {
          role: "TEACHER",
          userId: { in: profiles.map((p) => p.userId) },
        },
        select: { userId: true },
      })
    ).map((m) => m.userId),
  );
  return new Map(
    profiles.map((p) => [
      p.id,
      {
        id: p.id,
        name: p.user.name,
        active: !p.user.deletedAt && teachers.has(p.userId),
      },
    ]),
  );
}
