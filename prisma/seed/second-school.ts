import type { PrismaClient } from "../../src/generated/prisma/client";
import { toSchoolSlug } from "../../src/server/schools";
import { generateLessonOccurrences } from "../../src/server/scheduling/generate-lessons";
import { creditExpiry } from "../../src/server/scheduling/replacements";
import { fromIsoDate } from "../../src/server/scheduling/time";
import { BASE_TERM_START, baseDate, seedDate } from "./clock";
import { LESSON_GENERATION_END } from "./data";
import { seedId } from "./ids";

// A second, deliberately small school. Nothing in the demo UI needs it: it
// exists so the e2e permission suite (e2e/permissions/) has another tenant
// whose data must never show up in, or be changed from, the demo school —
// and the other way round. Every name is distinct from the demo school's so
// a leak is easy to spot in page text.

export const SECOND_SCHOOL = {
  name: "Northbridge Language Academy",
  timezone: "Europe/Vienna",
};

export const SECOND_EMAIL_DOMAIN = "northbridge.test";

/** One sign-in per role in the second school (password: DEMO_PASSWORD). */
export const SECOND_LOGINS = {
  admin: `admin@${SECOND_EMAIL_DOMAIN}`,
  teacher: `bruno.berger@${SECOND_EMAIL_DOMAIN}`,
  student: `bianca.bauer@${SECOND_EMAIL_DOMAIN}`,
} as const;

/** Display names, also asserted on in e2e leak checks. */
export const SECOND_NAMES = {
  admin: "Norbert Northbridge",
  teacher: "Bruno Berger",
  student: "Bianca Bauer",
  level: "Northbridge Starter",
  course: "Northbridge German N1",
  room: "Northbridge Hall",
  group: "Northbridge Evening",
  term: "Northbridge Fall Term",
  holiday: "Northbridge Founders Day",
  teacherNote: "NORTHBRIDGE-INTERNAL-NOTE: Bianca needs a level check.",
  lessonLog: "Northbridge lesson log: Dativ und Akkusativ",
  homework: "Northbridge homework: Arbeitsbuch S. 12",
  absenceReason: "NORTHBRIDGE-ABSENCE: Bianca at the dentist",
  availabilityNote: "Northbridge staff meeting",
} as const;

const TERM = {
  startDate: seedDate(BASE_TERM_START),
  endDate: seedDate("2027-01-29"),
};
const h = (hours: number) => hours * 60;

export async function seedSecondSchool(db: PrismaClient, passwordHash: string) {
  const slug = toSchoolSlug(SECOND_SCHOOL.name);
  const school = await db.school.upsert({
    where: { slug },
    update: { name: SECOND_SCHOOL.name, timezone: SECOND_SCHOOL.timezone },
    create: { id: seedId("school", slug), slug, ...SECOND_SCHOOL },
  });
  const schoolId = school.id;
  const id = (...parts: string[]) => seedId(slug, ...parts);

  async function person(
    key: keyof typeof SECOND_LOGINS,
    role: "ADMIN" | "TEACHER" | "STUDENT",
  ) {
    const email = SECOND_LOGINS[key];
    const data = {
      name: SECOND_NAMES[key],
      email,
      passwordHash,
      deletedAt: null,
    };
    const user = await db.user.upsert({
      where: { email },
      update: data,
      create: { id: id("user", key), ...data },
    });
    await db.membership.upsert({
      where: { schoolId_userId: { schoolId, userId: user.id } },
      update: { role },
      create: { id: id("membership", key), schoolId, userId: user.id, role },
    });
    return user;
  }

  await person("admin", "ADMIN");
  const teacherUser = await person("teacher", "TEACHER");
  const studentUser = await person("student", "STUDENT");

  const level = await db.level.upsert({
    where: { schoolId_code: { schoolId, code: "N1" } },
    update: { name: SECOND_NAMES.level, rank: 1, archivedAt: null },
    create: {
      id: id("level", "N1"),
      schoolId,
      code: "N1",
      name: SECOND_NAMES.level,
      rank: 1,
    },
  });
  const course = await db.course.upsert({
    where: { schoolId_name: { schoolId, name: SECOND_NAMES.course } },
    update: { levelId: level.id },
    create: {
      id: id("course", "n1"),
      schoolId,
      name: SECOND_NAMES.course,
      levelId: level.id,
    },
  });

  const teacher = await db.teacherProfile.upsert({
    where: { schoolId_userId: { schoolId, userId: teacherUser.id } },
    update: {},
    create: {
      id: id("teacher", "berger"),
      schoolId,
      userId: teacherUser.id,
      color: "#9333ea",
    },
  });
  const availabilityId = id("availability", "berger-friday");
  const availability = {
    schoolId,
    teacherId: teacher.id,
    kind: "WEEKLY_UNAVAILABLE" as const,
    weekday: 5,
    startMinute: 0,
    endMinute: h(24),
    note: SECOND_NAMES.availabilityNote,
  };
  await db.teacherAvailability.upsert({
    where: { id: availabilityId },
    update: availability,
    create: { id: availabilityId, ...availability },
  });

  const student = await db.studentProfile.upsert({
    where: { schoolId_userId: { schoolId, userId: studentUser.id } },
    update: { levelId: level.id },
    create: {
      id: id("student", "bauer"),
      schoolId,
      userId: studentUser.id,
      levelId: level.id,
    },
  });

  const roomData = {
    kind: "PHYSICAL" as const,
    capacity: 12,
    archivedAt: null,
  };
  const room = await db.room.upsert({
    where: { schoolId_name: { schoolId, name: SECOND_NAMES.room } },
    update: roomData,
    create: {
      id: id("room", "hall"),
      schoolId,
      name: SECOND_NAMES.room,
      ...roomData,
    },
  });

  const termData = {
    startDate: fromIsoDate(TERM.startDate),
    endDate: fromIsoDate(TERM.endDate),
    timetablePublishedAt: new Date(`${seedDate("2026-09-01")}T08:00:00Z`),
  };
  const term = await db.term.upsert({
    where: { schoolId_name: { schoolId, name: SECOND_NAMES.term } },
    update: termData,
    create: {
      id: id("term", "autumn"),
      schoolId,
      name: SECOND_NAMES.term,
      ...termData,
    },
  });
  const holiday = {
    key: "founders-day",
    name: SECOND_NAMES.holiday,
    startDate: seedDate("2026-10-23"),
    endDate: seedDate("2026-10-23"),
  };
  const holidayData = {
    schoolId,
    termId: term.id,
    name: holiday.name,
    startDate: fromIsoDate(holiday.startDate),
    endDate: fromIsoDate(holiday.endDate),
  };
  await db.holiday.upsert({
    where: { id: id("holiday", holiday.key) },
    update: holidayData,
    create: { id: id("holiday", holiday.key), ...holidayData },
  });

  const groupData = {
    type: "GROUP" as const,
    capacity: 10,
    levelId: level.id,
    courseId: course.id,
    deletedAt: null,
  };
  const group = await db.group.upsert({
    where: { schoolId_name: { schoolId, name: SECOND_NAMES.group } },
    update: groupData,
    create: {
      id: id("group", "evening"),
      schoolId,
      name: SECOND_NAMES.group,
      ...groupData,
    },
  });
  await db.groupMembership.upsert({
    where: { groupId_studentId: { groupId: group.id, studentId: student.id } },
    update: { leftAt: null },
    create: {
      id: id("enrolment", group.id, student.id),
      schoolId,
      groupId: group.id,
      studentId: student.id,
      joinedAt: fromIsoDate(TERM.startDate),
    },
  });

  // Same weekdays and times as some demo-school lessons, so a teacher or
  // room id that leaked across schools would also show up as a conflict.
  const slots = [2, 4].map((weekday) => ({
    id: id("slot", "evening", String(weekday)),
    groupId: group.id,
    teacherId: teacher.id,
    roomId: room.id,
    weekday,
    startMinute: h(18),
    endMinute: h(18) + 90,
    validFrom: null,
    validUntil: null,
  }));
  for (const { id: slotId, ...data } of slots) {
    await db.timetableSlot.upsert({
      where: { id: slotId },
      update: { termId: term.id, ...data },
      create: { id: slotId, schoolId, termId: term.id, ...data },
    });
  }

  const occurrences = generateLessonOccurrences({
    slots,
    term: TERM,
    holidays: [holiday],
    timeZone: SECOND_SCHOOL.timezone,
    range: { endDate: LESSON_GENERATION_END },
  });
  const lessonIds: string[] = [];
  for (const o of occurrences) {
    const lessonId = id("lesson", o.timetableSlotId, baseDate(o.date));
    const data = {
      groupId: o.groupId,
      teacherId: o.teacherId,
      roomId: o.roomId,
      startsAt: o.startsAt,
      endsAt: o.endsAt,
      status: "SCHEDULED" as const,
    };
    await db.lesson.upsert({
      where: { id: lessonId },
      update: data,
      create: {
        id: lessonId,
        schoolId,
        termId: term.id,
        timetableSlotId: o.timetableSlotId,
        occurrenceDate: fromIsoDate(o.date),
        ...data,
      },
    });
    lessonIds.push(lessonId);
  }

  const noteId = id("teacher-note", "bauer");
  const note = {
    schoolId,
    authorId: teacher.id,
    studentId: student.id,
    groupId: group.id,
    body: SECOND_NAMES.teacherNote,
  };
  await db.teacherNote.upsert({
    where: { id: noteId },
    update: note,
    create: { id: noteId, ...note },
  });

  const log = {
    authorId: teacher.id,
    updatedById: teacher.id,
    content: SECOND_NAMES.lessonLog,
    homework: SECOND_NAMES.homework,
  };
  await db.lessonLog.upsert({
    where: { schoolId_lessonId: { schoolId, lessonId: lessonIds[0] } },
    update: log,
    create: {
      id: id("lesson-log", lessonIds[0]),
      schoolId,
      lessonId: lessonIds[0],
      ...log,
    },
  });

  // A cancellation with its makeup credit (Phase 3), so absences and
  // credits have rows in both schools. A week before BASE_TODAY: the credit
  // (30 days) is still available on every day of the seed week. An expired
  // one would flip to EXPIRED whenever a school B list loads (CARM-85).
  const absenceIndex = occurrences.findIndex(
    (o) => o.date === seedDate("2026-10-06"),
  );
  const absenceLesson = occurrences[absenceIndex];
  const absenceId = id("absence", "bauer");
  await db.absenceReport.upsert({
    where: { id: absenceId },
    update: {},
    create: {
      id: absenceId,
      schoolId,
      lessonId: lessonIds[absenceIndex],
      studentId: student.id,
      reportedById: student.userId,
      reason: SECOND_NAMES.absenceReason,
      createdAt: new Date(absenceLesson.startsAt.getTime() - 2 * 86_400_000),
    },
  });
  await db.makeupCredit.upsert({
    where: { id: id("makeup-credit", "bauer") },
    update: {},
    create: {
      id: id("makeup-credit", "bauer"),
      schoolId,
      studentId: student.id,
      sourceLessonId: lessonIds[absenceIndex],
      absenceReportId: absenceId,
      expiresAt: creditExpiry(
        absenceLesson.startsAt,
        30,
        SECOND_SCHOOL.timezone,
      ).expiresAt,
    },
  });

  // A replacement booking (CARM-43), so bookings have rows in both schools
  // for the permission suite. School B has a single group, so it books
  // another of that group's lessons: fixture data, not a real-world case.
  const bookedId = id("absence", "bauer-booked");
  await db.absenceReport.upsert({
    where: { id: bookedId },
    update: {},
    create: {
      id: bookedId,
      schoolId,
      lessonId: lessonIds[2],
      studentId: student.id,
      reportedById: student.userId,
      createdAt: new Date(occurrences[2].startsAt.getTime() - 2 * 86_400_000),
    },
  });
  const bookedCredit = id("makeup-credit", "bauer-booked");
  await db.makeupCredit.upsert({
    where: { id: bookedCredit },
    update: {},
    create: {
      id: bookedCredit,
      schoolId,
      studentId: student.id,
      sourceLessonId: lessonIds[2],
      absenceReportId: bookedId,
      status: "USED",
      usedAt: new Date(occurrences[2].startsAt.getTime() - 2 * 86_400_000),
      expiresAt: creditExpiry(
        occurrences[2].startsAt,
        30,
        SECOND_SCHOOL.timezone,
      ).expiresAt,
    },
  });
  const replacementId = id("replacement", "bauer");
  await db.replacementRequest.upsert({
    where: { id: replacementId },
    update: {},
    create: {
      id: replacementId,
      schoolId,
      studentId: student.id,
      originalLessonId: lessonIds[2],
      targetLessonId: lessonIds[3],
      makeupCreditId: bookedCredit,
    },
  });

  console.log(
    `Seeded "${school.name}" (permission tests): 1 teacher, 1 student, 1 group, ` +
      `${slots.length} slots, ${lessonIds.length} lessons.`,
  );
}
