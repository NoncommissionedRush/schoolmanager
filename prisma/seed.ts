import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client";
import { hashPassword } from "../src/server/auth/password";
import { toSchoolSlug } from "../src/server/schools";
import { generateLessonOccurrences } from "../src/server/timetable/generate-lessons";
import { fromIsoDate } from "../src/server/timetable/time";
import {
  ADMIN,
  COURSES,
  DEMO_PASSWORD,
  DEMO_TODAY,
  EMAIL_DOMAIN,
  GROUPS,
  HOLIDAYS,
  LESSON_GENERATION_END,
  LESSON_LOG_TOPICS,
  LEVELS,
  ROOMS,
  SCHOOL,
  STUDENTS,
  TEACHER_AVAILABILITY,
  TEACHERS,
  TERM,
} from "./seed/data";
import { seedId } from "./seed/ids";

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
  for (const level of LEVELS) {
    const row = await db.level.upsert({
      where: { schoolId_code: { schoolId, code: level.code } },
      update: { name: level.name, rank: level.rank },
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
  for (const room of ROOMS) {
    const data = {
      name: room.name,
      kind: room.kind,
      capacity: room.capacity,
      meetingUrl: room.meetingUrl,
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
      termId: term.id,
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
      };
      const { id: slotId, ...data } = slot;
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
      status:
        o.date < DEMO_TODAY ? ("COMPLETED" as const) : ("SCHEDULED" as const),
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

  // --- Recent history: attendance, lesson logs, homework, notes -----------
  const recent = lessons.filter(
    (l) => l.date >= "2026-09-30" && l.date < DEMO_TODAY,
  );
  for (const [i, lesson] of recent.entries()) {
    const members = membersByGroup.get(lesson.groupId) ?? [];
    for (const [j, studentId] of members.entries()) {
      const roll = (i + j * 7) % 13;
      const status = roll === 0 ? "ABSENT" : roll === 1 ? "LATE" : "PRESENT";
      await db.attendance.upsert({
        where: { lessonId_studentId: { lessonId: lesson.id, studentId } },
        update: { status },
        create: {
          id: id("attendance", lesson.id, studentId),
          schoolId,
          lessonId: lesson.id,
          studentId,
          status,
        },
      });
    }
    const content = LESSON_LOG_TOPICS[i % LESSON_LOG_TOPICS.length];
    await db.lessonLog.upsert({
      where: { schoolId_lessonId: { schoolId, lessonId: lesson.id } },
      update: { content, authorId: lesson.teacherId },
      create: {
        id: id("lesson-log", lesson.id),
        schoolId,
        lessonId: lesson.id,
        authorId: lesson.teacherId,
        content,
      },
    });
  }

  const homework = [
    {
      group: "a1-morning",
      set: "2026-10-12",
      due: "2026-10-14",
      title: "Workbook p. 18, ex. 1–4",
    },
    {
      group: "a2-evening",
      set: "2026-10-12",
      due: "2026-10-14",
      title: "Write 10 sentences about your weekend",
    },
    {
      group: "b1-online",
      set: "2026-10-13",
      due: "2026-10-15",
      title: "Listening: podcast episode 3 + questions",
    },
    {
      group: "b2-business",
      set: "2026-10-12",
      due: "2026-10-19",
      title: "Draft a formal complaint email",
    },
    {
      group: "c1-evening",
      set: "2026-10-12",
      due: "2026-10-19",
      title: "Essay: Remote work — pros and cons (250 words)",
    },
  ];
  for (const hw of homework) {
    const setIn = lessonOf(hw.group, hw.set);
    const dueIn = lessonOf(hw.group, hw.due);
    const rowId = id("assignment", hw.group, hw.set);
    const data = {
      schoolId,
      groupId: setIn.groupId,
      lessonId: setIn.id,
      dueLessonId: dueIn.id,
      dueDate: fromIsoDate(hw.due),
      authorId: setIn.teacherId,
      title: hw.title,
    };
    await db.assignment.upsert({
      where: { id: rowId },
      update: data,
      create: { id: rowId, ...data },
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
      group: "b1-evening",
      lesson: "2026-10-12",
      body: "Ran out of time on the reading task; repeat next lesson.",
    },
  ];
  for (const note of notes) {
    const rowId = id("teacher-note", note.key);
    const data = {
      schoolId,
      authorId: teacherIds.get(note.teacher)!,
      studentId: note.student ? studentId(note.student) : null,
      groupId: note.group ? groupIds.get(note.group)! : null,
      lessonId:
        note.group && note.lesson ? lessonOf(note.group, note.lesson).id : null,
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
        reportedAt: new Date(`${a.date}T06:00:00Z`),
      },
    });
    if (a.date < DEMO_TODAY) {
      await db.attendance.upsert({
        where: { lessonId_studentId: { lessonId: lesson.id, studentId: sId } },
        update: { status: "EXCUSED" },
        create: {
          id: id("attendance", lesson.id, sId),
          schoolId,
          lessonId: lesson.id,
          studentId: sId,
          status: "EXCUSED",
        },
      });
    }
    const credit = await db.makeupCredit.upsert({
      where: {
        studentId_sourceLessonId: { studentId: sId, sourceLessonId: lesson.id },
      },
      update: { status: a.replacement ? "USED" : "AVAILABLE" },
      create: {
        id: id("makeup-credit", a.key),
        schoolId,
        studentId: sId,
        sourceLessonId: lesson.id,
        absenceReportId: report.id,
        status: a.replacement ? "USED" : "AVAILABLE",
        expiresAt: fromIsoDate(TERM.endDate),
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
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
