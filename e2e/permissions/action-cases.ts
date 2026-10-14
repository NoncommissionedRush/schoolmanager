import type { SchoolIds } from "./fixtures";
import { FormFields } from "../server-actions";

// Every admin server action, called with ids from `target` by an admin of
// `own`'s school. Forms are valid, so the only reason left to refuse is the
// id. Arguments that must reference the admin's own school (e.g. a level to
// put a group in) come from `own`, so validation can't refuse first.

const PEOPLE = "src/app/admin/_people/actions.ts";
const TEACHERS = "src/app/admin/teachers/actions.ts";
const STUDENTS = "src/app/admin/students/actions.ts";
const GROUPS = "src/app/admin/groups/actions.ts";
const COURSES = "src/app/admin/groups/course-actions.ts";
const LEVELS = "src/app/admin/levels/actions.ts";
const ROOMS = "src/app/admin/settings/rooms/actions.ts";
const TERMS = "src/app/admin/settings/terms/actions.ts";
const TIMETABLE = "src/app/admin/timetable/actions.ts";
const LESSONS = "src/app/admin/lessons/actions.ts";
const ABSENCES = "src/app/admin/absences/actions.ts";

export type ActionCase = {
  name: string;
  action: readonly [file: string, exportName: string];
  args: unknown[];
  /**
   * How the refusal shows: not found (the default), or — when the foreign
   * id is a form choice — a field error on that field.
   */
  refusedOn?: string;
};

const form = (fields: Record<string, string>) => new FormFields(fields);
const DATE = "2026-10-20";

export function crossSchoolCases(
  target: SchoolIds,
  own: SchoolIds,
): ActionCase[] {
  const slot = (ids: Partial<SchoolIds>) => ({
    termId: ids.term ?? target.term,
    groupId: ids.group ?? target.group,
    teacherId: ids.teacher ?? target.teacher,
    roomId: ids.room ?? target.room,
    weekday: 2,
    startMinute: 18 * 60,
    endMinute: 18 * 60 + 90,
  });
  return [
    // People
    {
      name: "set a password",
      action: [PEOPLE, "setPasswordAction"],
      args: [
        target.studentUser,
        null,
        form({ password: "Cross-school-password-123" }),
      ],
    },
    {
      name: "archive a teacher",
      action: [PEOPLE, "archivePersonAction"],
      args: [target.teacherUser],
    },
    {
      name: "archive a student",
      action: [PEOPLE, "archivePersonAction"],
      args: [target.studentUser],
    },
    {
      name: "archive an admin",
      action: [PEOPLE, "archivePersonAction"],
      args: [target.adminUser],
    },
    {
      name: "restore a person",
      action: [PEOPLE, "restorePersonAction"],
      args: [target.studentUser],
    },
    {
      name: "edit a teacher",
      action: [TEACHERS, "updateTeacherAction"],
      args: [
        target.teacher,
        null,
        form({
          name: "Cross School",
          email: "cross.teacher@example.test",
          color: "blue",
        }),
      ],
    },
    {
      name: "edit a student",
      action: [STUDENTS, "updateStudentAction"],
      args: [
        target.student,
        null,
        form({ name: "Cross School", email: "cross.student@example.test" }),
      ],
    },
    // Teacher availability
    {
      name: "add weekly unavailability",
      action: [TEACHERS, "saveWeeklyAction"],
      args: [
        target.teacher,
        null,
        null,
        form({ weekdays: "3", from: "08:00", to: "10:00" }),
      ],
    },
    {
      name: "replace weekly unavailability",
      action: [TEACHERS, "saveWeeklyAction"],
      args: [
        own.teacher,
        target.availability,
        null,
        form({ weekdays: "3", from: "08:00", to: "10:00" }),
      ],
    },
    {
      name: "add a date exception",
      action: [TEACHERS, "saveExceptionAction"],
      args: [
        target.teacher,
        null,
        form({ kind: "DATE_UNAVAILABLE", date: DATE, wholeDay: "on" }),
      ],
    },
    {
      name: "delete availability",
      action: [TEACHERS, "deleteAvailabilityAction"],
      args: [target.teacher, target.availability],
    },
    {
      name: "delete availability via own teacher",
      action: [TEACHERS, "deleteAvailabilityAction"],
      args: [own.teacher, target.availability],
    },
    // Groups & memberships
    {
      name: "edit a group",
      action: [GROUPS, "saveGroupAction"],
      args: [
        target.group,
        null,
        form({
          type: "GROUP",
          name: "Cross School",
          levelId: own.level,
          capacity: "10",
        }),
      ],
    },
    {
      name: "create a group with their level",
      action: [GROUPS, "saveGroupAction"],
      args: [
        null,
        null,
        form({
          type: "GROUP",
          name: "Cross School",
          levelId: target.level,
          capacity: "10",
        }),
      ],
      refusedOn: "levelId",
    },
    {
      name: "archive a group",
      action: [GROUPS, "archiveGroupAction"],
      args: [target.group],
    },
    {
      name: "restore a group",
      action: [GROUPS, "restoreGroupAction"],
      args: [target.group],
    },
    {
      name: "add own student to their group",
      action: [GROUPS, "addMembersAction"],
      args: [
        target.group,
        null,
        form({ studentIds: own.student, startDate: DATE }),
      ],
    },
    {
      name: "add their student to own group",
      action: [GROUPS, "addMembersAction"],
      args: [
        own.group,
        null,
        form({ studentIds: target.student, startDate: DATE }),
      ],
    },
    {
      name: "add their student to a group",
      action: [GROUPS, "addToGroupAction"],
      args: [
        target.student,
        null,
        form({ groupId: own.group, startDate: DATE }),
      ],
    },
    {
      name: "add own student to their group (student page)",
      action: [GROUPS, "addToGroupAction"],
      args: [
        own.student,
        null,
        form({ groupId: target.group, startDate: DATE }),
      ],
    },
    {
      name: "remove a group member",
      action: [GROUPS, "removeMemberAction"],
      args: [target.groupMembership, null, form({ date: DATE })],
    },
    // Courses & levels
    {
      name: "edit a course",
      action: [COURSES, "saveCourseAction"],
      args: [
        target.course,
        null,
        form({ name: "Cross School", levelId: own.level }),
      ],
    },
    {
      name: "create a course with their level",
      action: [COURSES, "saveCourseAction"],
      args: [null, null, form({ name: "Cross School", levelId: target.level })],
      refusedOn: "levelId",
    },
    {
      name: "delete a course",
      action: [COURSES, "deleteCourseAction"],
      args: [target.course],
    },
    {
      name: "edit a level",
      action: [LEVELS, "saveLevelAction"],
      args: [target.level, null, form({ code: "XS", name: "Cross School" })],
    },
    {
      name: "reorder a level",
      action: [LEVELS, "moveLevelAction"],
      args: [target.level, "down"],
    },
    {
      name: "archive a level",
      action: [LEVELS, "archiveLevelAction"],
      args: [target.level],
    },
    {
      name: "restore a level",
      action: [LEVELS, "restoreLevelAction"],
      args: [target.level],
    },
    {
      name: "delete a level",
      action: [LEVELS, "deleteLevelAction"],
      args: [target.level],
    },
    // Rooms
    {
      name: "edit a room",
      action: [ROOMS, "saveRoomAction"],
      args: [
        target.room,
        null,
        form({ name: "Cross School", kind: "PHYSICAL", capacity: "5" }),
      ],
    },
    {
      name: "archive a room",
      action: [ROOMS, "archiveRoomAction"],
      args: [target.room],
    },
    {
      name: "restore a room",
      action: [ROOMS, "restoreRoomAction"],
      args: [target.room],
    },
    {
      name: "delete a room",
      action: [ROOMS, "deleteRoomAction"],
      args: [target.room],
    },
    // Terms & holidays
    {
      name: "edit a term",
      action: [TERMS, "saveTermAction"],
      args: [
        target.term,
        null,
        form({
          name: "Cross School",
          startDate: "2026-09-14",
          endDate: "2027-01-29",
        }),
      ],
    },
    {
      name: "delete a term",
      action: [TERMS, "deleteTermAction"],
      args: [target.term],
    },
    {
      name: "edit a holiday",
      action: [TERMS, "saveHolidayAction"],
      args: [
        target.holiday,
        true,
        null,
        form({
          name: "Cross School",
          startDate: DATE,
          endDate: DATE,
          scope: "school",
        }),
      ],
    },
    {
      name: "add a holiday to their term",
      action: [TERMS, "saveHolidayAction"],
      args: [
        null,
        true,
        null,
        form({
          name: "Cross School",
          startDate: DATE,
          endDate: DATE,
          scope: "term",
          termId: target.term,
        }),
      ],
    },
    {
      name: "delete a holiday",
      action: [TERMS, "deleteHolidayAction"],
      args: [target.holiday, true],
    },
    // Timetable
    {
      name: "check a slot in their term",
      action: [TIMETABLE, "validateSlotAction"],
      args: [{ slotId: target.slot, slot: slot({}) }],
    },
    {
      name: "check a slot with their teacher in own term",
      action: [TIMETABLE, "validateSlotAction"],
      args: [
        { slot: slot({ term: own.term, group: own.group, room: own.room }) },
      ],
    },
    {
      name: "save a slot in their term",
      action: [TIMETABLE, "saveSlotAction"],
      args: [{ slot: slot({}), acknowledgedConflictKeys: [] }],
    },
    {
      name: "move their slot",
      action: [TIMETABLE, "saveSlotAction"],
      args: [
        {
          slotId: target.slot,
          slot: slot({
            term: own.term,
            group: own.group,
            teacher: own.teacher,
            room: own.room,
          }),
          acknowledgedConflictKeys: [],
        },
      ],
    },
    {
      name: "save a slot with their group in own term",
      action: [TIMETABLE, "saveSlotAction"],
      args: [
        {
          slot: slot({ term: own.term, teacher: own.teacher, room: own.room }),
          acknowledgedConflictKeys: [],
        },
      ],
    },
    {
      name: "end a slot",
      action: [TIMETABLE, "endSlotAction"],
      args: [{ slotId: target.slot, lastDate: DATE }],
    },
    {
      name: "delete a slot",
      action: [TIMETABLE, "deleteSlotAction"],
      args: [target.slot],
    },
    {
      name: "publish a term",
      action: [TIMETABLE, "publishTermAction"],
      args: [target.term],
    },
    {
      name: "regenerate lessons",
      action: [TIMETABLE, "regenerateLessonsAction"],
      args: [target.term],
    },
    // Lessons (read-only; CARM-36)
    {
      name: "load earlier internal notes",
      action: [LESSONS, "loadEarlierNotesAction"],
      args: [target.lesson, 0],
    },
    // Absences (CARM-42)
    {
      name: "list a student's lessons to report an absence",
      action: [ABSENCES, "loadReportableLessonsAction"],
      args: [target.student],
    },
    {
      name: "report an absence for their student",
      action: [ABSENCES, "reportAbsenceAction"],
      args: [
        { studentId: target.student, lessonId: target.lesson, reason: null },
      ],
    },
    {
      name: "report an absence for own student on their lesson",
      action: [ABSENCES, "reportAbsenceAction"],
      args: [{ studentId: own.student, lessonId: target.lesson, reason: null }],
    },
    {
      name: "delete an absence",
      action: [ABSENCES, "deleteAbsenceAction"],
      args: [target.absence, []],
    },
    // Replacement review and 1-on-1 reschedule (CARM-43)
    {
      name: "approve a replacement",
      action: [ABSENCES, "approveReplacementsAction"],
      args: [[target.replacement]],
    },
    {
      name: "reject a replacement",
      action: [ABSENCES, "rejectReplacementAction"],
      args: [{ bookingId: target.replacement, note: "Cross-school" }],
    },
    {
      name: "override a replacement, keeping it",
      action: [ABSENCES, "overrideReplacementAction"],
      args: [
        {
          bookingId: target.replacement,
          targetLessonId: null,
          acknowledgedKeys: [],
          note: "Cross-school",
        },
      ],
    },
    {
      name: "override their own replacement into their lesson",
      action: [ABSENCES, "overrideReplacementAction"],
      args: [
        {
          bookingId: own.replacement,
          targetLessonId: target.lesson,
          acknowledgedKeys: [],
          note: "Cross-school",
        },
      ],
    },
    {
      name: "list lessons to override a replacement into",
      action: [ABSENCES, "loadOverrideOptionsAction"],
      args: [target.replacement, true],
    },
    {
      name: "reschedule a lesson",
      action: [ABSENCES, "rescheduleLessonAction"],
      args: [
        {
          lessonId: target.lesson,
          date: DATE,
          startMinute: 18 * 60,
          durationMinutes: 45,
          roomId: null,
          acknowledgedKeys: [],
          note: null,
        },
      ],
    },
    {
      name: "reschedule a lesson into their room",
      action: [ABSENCES, "rescheduleLessonAction"],
      args: [
        {
          lessonId: own.lesson,
          date: DATE,
          startMinute: 18 * 60,
          durationMinutes: 45,
          roomId: target.room,
          acknowledgedKeys: [],
          note: null,
        },
      ],
    },
    {
      name: "cancel a rescheduled lesson",
      action: [ABSENCES, "cancelRescheduledLessonAction"],
      args: [target.lesson],
    },
    // Spending a student's credit for them (CARM-47)
    {
      name: "list lessons to book with their student's credit",
      action: [ABSENCES, "loadAdminBookingOptionsAction"],
      args: [target.credit, true],
    },
    {
      name: "book a replacement with their student's credit",
      action: [ABSENCES, "bookReplacementForStudentAction"],
      args: [
        {
          creditId: target.credit,
          targetLessonId: own.lesson,
          acknowledgedKeys: [],
          note: null,
        },
      ],
    },
    {
      name: "book own student into their lesson",
      action: [ABSENCES, "bookReplacementForStudentAction"],
      args: [
        {
          creditId: own.credit,
          targetLessonId: target.lesson,
          acknowledgedKeys: [],
          note: null,
        },
      ],
    },
    {
      name: "book a 1-on-1 with their student's credit",
      action: [ABSENCES, "rescheduleFromCreditAction"],
      args: [
        {
          creditId: target.credit,
          date: DATE,
          startMinute: 18 * 60,
          durationMinutes: 45,
          roomId: null,
          acknowledgedKeys: [],
          note: null,
        },
      ],
    },
    {
      name: "book a 1-on-1 with own student's credit in their room",
      action: [ABSENCES, "rescheduleFromCreditAction"],
      args: [
        {
          creditId: own.credit,
          date: DATE,
          startMinute: 18 * 60,
          durationMinutes: 45,
          roomId: target.room,
          acknowledgedKeys: [],
          note: null,
        },
      ],
    },
  ];
}

const TEACHER_LESSONS = "src/app/teacher/lessons/actions.ts";

/**
 * Every teacher lesson action (CARM-35), aimed at `target`'s lesson, note
 * and student. Inputs are valid, so a refusal can only come from who is
 * asking or what they aim at. The coverage test in lesson-records.spec.ts
 * fails until every action under src/app/teacher/ is listed.
 */
export function teacherLessonCases(target: {
  lesson: string;
  teacherNote: string;
  student: string;
}): ActionCase[] {
  return [
    {
      name: "save the lesson log and homework",
      action: [TEACHER_LESSONS, "saveLessonLogAction"],
      args: [
        {
          lessonId: target.lesson,
          content: "Leaked lesson log",
          homework: "Leaked homework",
          expectedUpdatedAt: null,
        },
      ],
    },
    {
      name: "add a note about the lesson",
      action: [TEACHER_LESSONS, "createNoteAction"],
      args: [{ lessonId: target.lesson, about: "lesson", body: "Leak" }],
    },
    {
      name: "add a note about a student",
      action: [TEACHER_LESSONS, "createNoteAction"],
      args: [
        {
          lessonId: target.lesson,
          about: `student:${target.student}`,
          body: "Leak",
        },
      ],
    },
    {
      name: "edit a note",
      action: [TEACHER_LESSONS, "updateNoteAction"],
      args: [{ noteId: target.teacherNote, body: "Leak" }],
    },
    {
      name: "delete a note",
      action: [TEACHER_LESSONS, "deleteNoteAction"],
      args: [target.teacherNote],
    },
    {
      name: "load earlier notes",
      action: [TEACHER_LESSONS, "loadEarlierNotesAction"],
      args: [target.lesson, 0],
    },
  ];
}
