import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client";
import { hashPassword } from "../src/server/auth/password";
import { toSchoolSlug } from "../src/server/schools";
import { generateLessonOccurrences } from "../src/server/scheduling/generate-lessons";
import { creditExpiry } from "../src/server/scheduling/replacements";
import { fromIsoDate } from "../src/server/scheduling/time";
import {
  ADMIN,
  COURSES,
  DEMO_PASSWORD,
  DEMO_TODAY,
  EMAIL_DOMAIN,
  GROUPS,
  HOLIDAYS,
  LESSON_GENERATION_END,
  LESSON_HOMEWORK,
  LESSON_LOG_TOPICS,
  ARCHIVED_AT,
  ARCHIVED_LEVELS,
  ARCHIVED_ROOMS,
  LEVELS,
  ROOMS,
  SCHOOL,
  STUDENTS,
  TEACHER_AVAILABILITY,
  TEACHERS,
  TERM,
} from "./seed/data";
import { seedId } from "./seed/ids";
import { seedSecondSchool } from "./seed/second-school";

// Idempotent demo seed: every row has a deterministic id (`seedId`) and is
// upserted, so re-running `pnpm db:seed` converges to the same state.

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const emailFor = (name: string) =>
  `${toSchoolSlug(name).replace(/-/g, ".")}@${EMAIL_DOMAIN}`;

// Every demo user shares one password, so hash it once.
const passwordHash = hashPassword(DEMO_PASSWORD);

async function upsertUser(key: string, name: string, email = emailFor(name)) {
  const data = {
    name,
    email,
    passwordHash: await passwordHash,
    deletedAt: null,
  };
  return db.user.upsert({
    where: { email },
    update: data,
    create: { id: seedId("user", key), ...data },
  });
}

async function main() {
  // --- School -------------------------------------------------------------
  const slug = toSchoolSlug(SCHOOL.name);
  const school = await db.school.upsert({
    where: { slug },
    update: { name: SCHOOL.name, timezone: SCHOOL.timezone },
    create: { id: seedId("school", slug), slug, ...SCHOOL },
  });
  const schoolId = school.id;
  // Ids are namespaced by school so a second demo school could be seeded.
  const id = (...parts: string[]) => seedId(slug, ...parts);

  // --- Levels & courses ---------------------------------------------------
  const levelIds = new Map<string, string>();
  const levels = [
    ...LEVELS.map((level) => ({ ...level, archivedAt: null })),
    ...ARCHIVED_LEVELS.map((level) => ({ ...level, archivedAt: ARCHIVED_AT })),
  ];
  for (const level of levels) {
    const row = await db.level.upsert({
      where: { schoolId_code: { schoolId, code: level.code } },
      update: {
        name: level.name,
        rank: level.rank,
        archivedAt: level.archivedAt,
      },
      create: { id: id("level", level.code), schoolId, ...level },
    });
    levelIds.set(level.code, row.id);
  }

  const courseIds = new Map<string, string>();
  for (const course of COURSES) {
    const data = { name: course.name, levelId: levelIds.get(course.level)! };
    const row = await db.course.upsert({
      where: { schoolId_name: { schoolId, name: course.name } },
      update: data,
      create: { id: id("course", course.key), schoolId, ...data },
    });
    courseIds.set(course.key, row.id);
  }

  // --- People -------------------------------------------------------------
  async function addMembership(
    userId: string,
    role: "ADMIN" | "TEACHER" | "STUDENT",
  ) {
    await db.membership.upsert({
      where: { schoolId_userId: { schoolId, userId } },
      update: { role },
      create: { id: id("membership", userId, role), schoolId, userId, role },
    });
  }

  const admin = await upsertUser(
    ADMIN.key,
    ADMIN.name,
    `admin@${EMAIL_DOMAIN}`,
  );
  await addMembership(admin.id, "ADMIN");

  const teacherIds = new Map<string, string>();
  for (const teacher of TEACHERS) {
    const user = await upsertUser(teacher.key, teacher.name);
    await addMembership(user.id, "TEACHER");
    const profile = await db.teacherProfile.upsert({
      where: { schoolId_userId: { schoolId, userId: user.id } },
      update: { color: teacher.color },
      create: {
        id: id("teacher", teacher.key),
        schoolId,
        userId: user.id,
        color: teacher.color,
      },
    });
    teacherIds.set(teacher.key, profile.id);
  }

  for (const a of TEACHER_AVAILABILITY) {
    const data = {
      schoolId,
      teacherId: teacherIds.get(a.teacher)!,
      kind: a.kind,
      weekday: a.weekday ?? null,
      date: a.date ? fromIsoDate(a.date) : null,
      startMinute: a.startMinute ?? null,
      endMinute: a.endMinute ?? null,
      note: a.note,
    };
    const rowId = id("availability", a.key);
    await db.teacherAvailability.upsert({
      where: { id: rowId },
      update: data,
      create: { id: rowId, ...data },
    });
  }

  const studentIds: string[] = [];
  const studentUserIds = new Map<string, string>();
  for (const student of STUDENTS) {
    const user = await upsertUser(`student:${student.name}`, student.name);
    await addMembership(user.id, "STUDENT");
    const levelId = levelIds.get(student.level)!;
    const profile = await db.studentProfile.upsert({
      where: { schoolId_userId: { schoolId, userId: user.id } },
      update: { levelId },
      create: {
        id: id("student", student.name),
        schoolId,
        userId: user.id,
        levelId,
      },
    });
    studentIds.push(profile.id);
    studentUserIds.set(profile.id, user.id);
  }

  // --- Rooms, term, holidays ----------------------------------------------
  const roomIds = new Map<string, string>();
  const rooms = [
    ...ROOMS.map((room) => ({ ...room, archivedAt: null })),
    ...ARCHIVED_ROOMS.map((room) => ({ ...room, archivedAt: ARCHIVED_AT })),
  ];
  for (const room of rooms) {
    const data = {
      name: room.name,
      kind: room.kind,
      capacity: room.capacity,
      meetingUrl: room.meetingUrl,
      archivedAt: room.archivedAt,
    };
    const row = await db.room.upsert({
      where: { schoolId_name: { schoolId, name: room.name } },
      update: data,
      create: { id: id("room", room.key), schoolId, ...data },
    });
    roomIds.set(room.key, row.id);
  }

  const termData = {
    name: TERM.name,
    startDate: fromIsoDate(TERM.startDate),
    endDate: fromIsoDate(TERM.endDate),
    timetablePublishedAt: new Date("2026-09-01T08:00:00Z"),
  };
  const term = await db.term.upsert({
    where: { schoolId_name: { schoolId, name: TERM.name } },
    update: termData,
    create: { id: id("term", TERM.key), schoolId, ...termData },
  });

  for (const holiday of HOLIDAYS) {
    const rowId = id("holiday", holiday.key);
    const data = {
      schoolId,
      termId: holiday.schoolWide ? null : term.id,
      name: holiday.name,
      startDate: fromIsoDate(holiday.startDate),
      endDate: fromIsoDate(holiday.endDate),
    };
    await db.holiday.upsert({
      where: { id: rowId },
      update: data,
      create: { id: rowId, ...data },
    });
  }

  // --- Groups & enrolments ------------------------------------------------
  const groupIds = new Map<string, string>();
  for (const group of GROUPS) {
    const data = {
      name: group.name,
      type: group.type,
      capacity: group.capacity,
      levelId: levelIds.get(group.level)!,
      courseId: courseIds.get(group.course)!,
      deletedAt: null,
    };
    const row = await db.group.upsert({
      where: { schoolId_name: { schoolId, name: group.name } },
      update: data,
      create: { id: id("group", group.key), schoolId, ...data },
    });
    groupIds.set(group.key, row.id);
  }

  // Students of each level are spread round-robin over that level's groups;
  // 1-on-1 students only attend their own 1-on-1.
  const membersByGroup = new Map<string, string[]>();
  const roundRobin = new Map<string, number>();
  STUDENTS.forEach((student, i) => {
    let groupKey = student.oneOnOne;
    if (!groupKey) {
      const options = GROUPS.filter(
        (g) => g.type === "GROUP" && g.level === student.level,
      );
      const n = roundRobin.get(student.level) ?? 0;
      roundRobin.set(student.level, n + 1);
      groupKey = options[n % options.length].key;
    }
    const groupId = groupIds.get(groupKey)!;
    membersByGroup.set(groupId, [
      ...(membersByGroup.get(groupId) ?? []),
      studentIds[i],
    ]);
  });
  const joinedAt = new Date(`${TERM.startDate}T00:00:00Z`);
  for (const [groupId, members] of membersByGroup) {
    for (const studentId of members) {
      await db.groupMembership.upsert({
        where: { groupId_studentId: { groupId, studentId } },
        update: { leftAt: null },
        create: {
          id: id("enrolment", groupId, studentId),
          schoolId,
          groupId,
          studentId,
          joinedAt,
        },
      });
    }
  }

  // --- Timetable (published) & generated lessons --------------------------
  const slots = [];
  for (const group of GROUPS) {
    for (const s of group.slots) {
      const slot = {
        id: id("slot", group.key, String(s.weekday), String(s.start)),
        groupId: groupIds.get(group.key)!,
        teacherId: teacherIds.get(group.teacher)!,
        roomId: roomIds.get(group.room)!,
        weekday: s.weekday,
        startMinute: s.start,
        endMinute: s.end,
        validFrom: s.validFrom ?? null,
        validUntil: s.validUntil ?? null,
      };
      const { id: slotId, ...fields } = slot;
      const data = {
        ...fields,
        validFrom: slot.validFrom ? fromIsoDate(slot.validFrom) : null,
        validUntil: slot.validUntil ? fromIsoDate(slot.validUntil) : null,
      };
      await db.timetableSlot.upsert({
        where: { id: slotId },
        update: { termId: term.id, ...data },
        create: { id: slotId, schoolId, termId: term.id, ...data },
      });
      slots.push(slot);
    }
  }

  const occurrences = generateLessonOccurrences({
    slots,
    term: { startDate: TERM.startDate, endDate: TERM.endDate },
    holidays: HOLIDAYS,
    timeZone: SCHOOL.timezone,
    range: { endDate: LESSON_GENERATION_END },
  });

  type SeededLesson = (typeof occurrences)[number] & { id: string };
  const lessons: SeededLesson[] = [];
  for (const o of occurrences) {
    const lessonId = id("lesson", o.timetableSlotId, o.date);
    const data = {
      groupId: o.groupId,
      teacherId: o.teacherId,
      roomId: o.roomId,
      startsAt: o.startsAt,
      endsAt: o.endsAt,
      // P2 doesn't use COMPLETED: lessons stay SCHEDULED or CANCELLED.
      status: "SCHEDULED" as const,
      substituteTeacherId: null,
      cancelReason: null,
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
    lessons.push({ ...o, id: lessonId });
  }

  const lessonOf = (groupKey: string, date: string) => {
    const groupId = groupIds.get(groupKey)!;
    const lesson = lessons.find(
      (l) => l.groupId === groupId && l.date === date,
    );
    if (!lesson) throw new Error(`No lesson for ${groupKey} on ${date}`);
    return lesson;
  };

  // Kováčová is at a conference on 2026-10-21: Smith substitutes.
  await db.lesson.update({
    where: { id: lessonOf("b1-evening", "2026-10-21").id },
    data: { substituteTeacherId: teacherIds.get("t-smith")! },
  });
  await db.lesson.update({
    where: { id: lessonOf("c1-evening", "2026-11-02").id },
    data: { status: "CANCELLED", cancelReason: "Teacher on sick leave" },
  });

  // --- History: lesson logs with homework, notes ---------------------------
  // Every sixth past lesson has no log yet, so teachers have something on
  // their "No log yet" list and dashboard.
  const past = lessons.filter((l) => l.date < DEMO_TODAY);
  for (const [i, lesson] of past.entries()) {
    const where = { schoolId_lessonId: { schoolId, lessonId: lesson.id } };
    if (i % 6 === 5) {
      await db.lessonLog.deleteMany({ where: { lessonId: lesson.id } });
      continue;
    }
    const data = {
      authorId: lesson.teacherId,
      updatedById: lesson.teacherId,
      content: LESSON_LOG_TOPICS[i % LESSON_LOG_TOPICS.length],
      homework: LESSON_HOMEWORK[i % LESSON_HOMEWORK.length],
    };
    await db.lessonLog.upsert({
      where,
      update: data,
      create: {
        id: id("lesson-log", lesson.id),
        schoolId,
        lessonId: lesson.id,
        ...data,
      },
    });
  }

  const studentId = (name: string) =>
    studentIds[STUDENTS.findIndex((s) => s.name === name)];
  const notes = [
    {
      key: "kollar",
      teacher: "t-novak",
      student: "Adam Kollár",
      body: "Struggles with listening; suggested graded podcasts. Consider moving to the evening group if mornings stay difficult.",
    },
    {
      key: "zuzana",
      teacher: "t-oconnor",
      student: "Zuzana Krajčí",
      body: "Very motivated, preparing for a job interview in December — focus on speaking.",
    },
    {
      key: "c1-group",
      teacher: "t-tothova",
      group: "c1-evening",
      body: "Group is ready for CAE practice tests after the autumn break.",
    },
    {
      key: "b1-lesson",
      teacher: "t-kovac",
      lessonOf: "b1-evening",
      lesson: "2026-10-12",
      body: "Ran out of time on the reading task; repeat next lesson.",
    },
    {
      key: "b1-student",
      teacher: "t-kovac",
      memberOf: "b1-evening",
      lessonOf: "b1-evening",
      lesson: "2026-10-07",
      body: "Needs extra time in written tasks; let them finish at home.",
    },
  ];
  for (const note of notes) {
    const rowId = id("teacher-note", note.key);
    const data = {
      schoolId,
      authorId: teacherIds.get(note.teacher)!,
      studentId: note.student
        ? studentId(note.student)
        : note.memberOf
          ? membersByGroup.get(groupIds.get(note.memberOf)!)![0]
          : null,
      groupId: note.group ? groupIds.get(note.group)! : null,
      // Notes written on a lesson page keep that lesson as their context.
      lessonId: note.lessonOf ? lessonOf(note.lessonOf, note.lesson).id : null,
      body: note.body,
    };
    await db.teacherNote.upsert({
      where: { id: rowId },
      update: data,
      create: { id: rowId, ...data },
    });
  }

  // --- Absences, makeup credits, replacements (Phase 3 demo) --------------
  const absences = [
    // Past absence, replacement overridden by the admin.
    {
      key: "kralova",
      student: "Andrea Kráľová",
      group: "b2-evening",
      date: "2026-10-06",
      reason: "Business trip",
      replacement: {
        group: "b2-late",
        date: "2026-10-08",
        status: "OVERRIDDEN" as const,
        note: "Moved to B2 Late on request; group was over capacity on Thursday.",
      },
    },
    // Upcoming absence, replacement auto-approved.
    {
      key: "kollar",
      student: "Adam Kollár",
      group: "a1-morning",
      date: "2026-10-19",
      reason: "Dentist appointment",
      replacement: {
        group: "a1-evening",
        date: "2026-10-19",
        status: "AUTO_APPROVED" as const,
      },
    },
    // Upcoming absence, credit not used yet.
    {
      key: "benko",
      student: "Igor Benko",
      group: "a2-morning",
      date: "2026-10-15",
      reason: "Sick",
    },
  ];
  for (const a of absences) {
    const sId = studentId(a.student);
    const lesson = lessonOf(a.group, a.date);
    const report = await db.absenceReport.upsert({
      where: { lessonId_studentId: { lessonId: lesson.id, studentId: sId } },
      update: { reason: a.reason },
      create: {
        id: id("absence", a.key),
        schoolId,
        lessonId: lesson.id,
        studentId: sId,
        reportedById: studentUserIds.get(sId)!,
        reason: a.reason,
        // Two days ahead: before the default 24-hour cutoff, so it earns a credit.
        createdAt: new Date(lesson.startsAt.getTime() - 2 * 86_400_000),
      },
    });
    const { expiresAt } = creditExpiry(lesson.startsAt, 30, SCHOOL.timezone);
    const credit = await db.makeupCredit.upsert({
      where: {
        studentId_sourceLessonId: { studentId: sId, sourceLessonId: lesson.id },
      },
      update: {
        status: a.replacement ? "USED" : "AVAILABLE",
        expiresAt,
        usedAt: a.replacement ? report.createdAt : null,
      },
      create: {
        id: id("makeup-credit", a.key),
        schoolId,
        studentId: sId,
        sourceLessonId: lesson.id,
        absenceReportId: report.id,
        status: a.replacement ? "USED" : "AVAILABLE",
        expiresAt,
        usedAt: a.replacement ? report.createdAt : null,
      },
    });
    if (a.replacement) {
      const r = a.replacement;
      const rowId = id("replacement", a.key);
      const reviewed = r.status !== "AUTO_APPROVED";
      const data = {
        schoolId,
        studentId: sId,
        originalLessonId: lesson.id,
        targetLessonId: lessonOf(r.group, r.date).id,
        makeupCreditId: credit.id,
        status: r.status,
        reviewedById: reviewed ? admin.id : null,
        reviewedAt: reviewed ? new Date(`${a.date}T09:00:00Z`) : null,
        reviewNote: "note" in r ? r.note : null,
      };
      await db.replacementRequest.upsert({
        where: { id: rowId },
        update: data,
        create: { id: rowId, ...data },
      });
    }
  }

  // A late cancellation the office took by phone: no credit (after the
  // 24-hour cutoff), "via office" on the teacher's Students card.
  {
    const lesson = lessonOf("b1-evening", "2026-10-21");
    const sId = membersByGroup.get(groupIds.get("b1-evening")!)![1];
    await db.absenceReport.upsert({
      where: { lessonId_studentId: { lessonId: lesson.id, studentId: sId } },
      update: {},
      create: {
        id: id("absence", "late-by-office"),
        schoolId,
        lessonId: lesson.id,
        studentId: sId,
        reportedById: admin.id,
        reason: "Phoned the office: ill",
        createdAt: new Date(lesson.startsAt.getTime() - 3 * 3_600_000),
      },
    });
  }

  // --- Audit log ------------------------------------------------------------
  const auditId = id("audit", "timetable-published", TERM.key);
  await db.auditLog.upsert({
    where: { id: auditId },
    update: {},
    create: {
      id: auditId,
      schoolId,
      actorId: admin.id,
      action: "timetable.published",
      entityType: "Term",
      entityId: term.id,
      data: { slots: slots.length, lessonsGenerated: lessons.length },
      createdAt: term.timetablePublishedAt!,
    },
  });

  console.log(
    `Seeded "${school.name}": ${TEACHERS.length} teachers, ${STUDENTS.length} students, ` +
      `${GROUPS.length} groups, ${slots.length} slots, ${lessons.length} lessons ` +
      `(${TERM.startDate} → ${LESSON_GENERATION_END}).`,
  );

  // A second tenant for the e2e permission suite (e2e/permissions/).
  await seedSecondSchool(db, await passwordHash);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
