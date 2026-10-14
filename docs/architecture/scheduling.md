# Scheduling

How timetable slots are checked for conflicts, how they change over a term,
and how dated lessons follow them. The data model is in
[data-model.md](data-model.md).

## Where things live

| Path                              | What                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/scheduling/`          | Pure domain logic. No Prisma, no Next.js; deterministic; unit- and property-tested                                              |
| `· types.ts`                      | Plain-data inputs (`SchedulingContext`, `SlotInfo`, `LessonInfo`, …)                                                            |
| `· conflict-types.ts`             | `CONFLICT_TYPES`, severities, `Conflict` shape, `decideSave` (override rule)                                                    |
| `· conflicts.ts`                  | `buildCalendar`, `checkSlot`, `checkLesson`, `checkTimetable`                                                                   |
| `· availability.ts`               | Teacher (un)availability rules for one date and time window                                                                     |
| `· generate-lessons.ts`           | Slot → dated lesson occurrences (term, validity range, holidays, DST)                                                           |
| `· lesson-sync.ts`                | `planLessonSync` (reconcile lessons with slots/holidays), `planSlotEdit` (update/split), `planSlotCarryOver` (split successors) |
| `· time.ts`                       | Calendar dates, minutes, time-zone conversion                                                                                   |
| `· testing/`                      | Fixtures and the realistic-data generator used by the tests                                                                     |
| `src/server/timetable/service.ts` | Database service the editor's server actions call; one transaction per action                                                   |
| `messages/en-GB/scheduling.json`  | Conflict messages, severity labels, cancel reasons, service errors                                                              |

## Conflicts

`checkSlot(calendar, slot)` checks a new or edited weekly slot;
`checkLesson(calendar, lesson)` a single dated lesson (moved, substitute,
ad-hoc); `checkTimetable(calendar, termId)` every slot of a term.
`buildCalendar(context)` indexes everything once, so the generator can check
thousands of candidates cheaply.

**What a slot is compared against.** Every date the slot would produce a
lesson on (its weekday, inside the term and its `validFrom`/`validUntil`,
minus holidays) is compared with every booking on that date:

- an existing lesson, where and with whom it actually takes place — the
  teacher is `substituteTeacherId ?? teacherId`, the time is the lesson's
  own (it may have been moved), CANCELLED lessons occupy nothing;
- a slot occurrence that has no lesson row yet (draft terms, dates not
  generated yet).

Times are compared as real instants, so a clash across a DST switch is
judged correctly. Back-to-back lessons (one ends 10:30, the next starts
10:30) do not clash. A slot being edited is never compared with itself.

**Shape.** Each conflict has a `type`, a `severity`, a stable `key` (type +
what it clashes with, e.g. `TEACHER_DOUBLE_BOOKED:slot:<id>`), the affected
`dates`, ICU `params` for its message and `refs` (ids to link or highlight).
A clash with the same slot on several dates is one conflict listing all the
dates. Output is sorted (blocking first, then by type and key) and does not
depend on input order.

### Types and severities

Blocking conflicts cannot be saved, not even by an admin. Overridable ones
can, once the admin acknowledges each of them; the override is recorded in
the audit log. Message: `scheduling.conflicts.<TYPE>`. Every double-booking
message also gets `otherGroup`, `otherTime` (`HH:MM–HH:MM`), `dateCount` and
`firstDate` (`YYYY-MM-DD`; reformat it for display).

| Type                          | Severity    | When                                                                                   | Params                                    |
| ----------------------------- | ----------- | -------------------------------------------------------------------------------------- | ----------------------------------------- |
| `INVALID_TIME`                | blocking    | Weekday not 1–7, start ≥ end, outside 00:00–24:00                                      | —                                         |
| `OUTSIDE_TERM`                | blocking    | Slot dates (or lesson date) outside the term, or `validFrom > validUntil`              | `term`, `termStart`, `termEnd`            |
| `GROUP_ARCHIVED`              | blocking    | The group is archived (`deletedAt`)                                                    | `group`                                   |
| `ROOM_ARCHIVED`               | blocking    | The room is archived (`archivedAt`) and the slot or lesson is not already in it        | `room`                                    |
| `TEACHER_DOUBLE_BOOKED`       | blocking    | The (effective) teacher already teaches then                                           | `teacher` + double-booking params         |
| `ROOM_DOUBLE_BOOKED`          | blocking    | A **physical** room is already used then                                               | `room` + double-booking params            |
| `GROUP_DOUBLE_BOOKED`         | blocking    | The group already has a lesson then                                                    | `group` + double-booking params           |
| `STUDENT_DOUBLE_BOOKED`       | overridable | A student attending this lesson also attends the other one (see notes)                 | `studentCount`, `students` + d.-b. params |
| `ONLINE_ROOM_SHARED`          | overridable | An **online** room is already used then (often a shared link or licence)               | `room` + double-booking params            |
| `ROOM_CAPACITY_EXCEEDED`      | overridable | Seats taken > room capacity (online rooms without capacity never; see notes)           | `room`, `capacity`, `studentCount`        |
| `GROUP_OVER_CAPACITY`         | overridable | Enrolled students > the group's own capacity                                           | `group`, `capacity`, `studentCount`       |
| `ONE_ON_ONE_STUDENT_COUNT`    | overridable | A 1-on-1 group does not have exactly one enrolled student                              | `group`, `studentCount`                   |
| `TEACHER_UNAVAILABLE_WEEKLY`  | overridable | A weekly unavailability overlaps (minus dates lifted by a `DATE_AVAILABLE` exception)  | `teacher`, `allDay` (yes/no), `time`      |
| `TEACHER_UNAVAILABLE_ON_DATE` | overridable | A one-off unavailability overlaps                                                      | `teacher`, `allDay`, `time`, `firstDate`  |
| `LESSON_ON_HOLIDAY`           | overridable | A single lesson on a holiday (slots simply skip holidays)                              | `holiday`, `firstDate`                    |
| `OUTSIDE_SCHOOL_DAYS`         | overridable | Weekday not in `School.teachingWeekdays` (default Mon–Sat)                             | `weekday` (1–7)                           |
| `OUTSIDE_SCHOOL_HOURS`        | overridable | Outside `School.dayStartMinute`–`dayEndMinute` (default 07:00–21:00)                   | `time`, `schoolHours`                     |
| `NO_OCCURRENCES`              | overridable | The slot would never produce a lesson (all its days are holidays or outside its dates) | `term`                                    |

Notes:

- Archived rooms: a slot or lesson that is **already** in an archived room
  (the stored slot's room; for a lesson, its own or its slot's) is not
  blocked, so its other fields can still be edited, lessons keep being
  generated and the term can be published. It is still checked for clashes
  like any other. Only new slots and lessons, and moves into the room, are
  blocked. Archived levels need no check: a slot gets its level from its group.
- Group size is the number of **currently enrolled** students
  (`GroupMembership.leftAt` null), not `Group.capacity`.
- Who attends (CARM-46): a stored lesson is attended by its group's
  enrolled students minus those with an absence report on it, plus its
  active replacement students (`SchedulingContext.absences` and
  `.replacements`, both optional). `ROOM_CAPACITY_EXCEEDED` on a lesson
  counts these seats (`seatsTaken`, replacements.md §5), and
  `STUDENT_DOUBLE_BOOKED` compares attendees on both sides, so an absent
  student never clashes and a replacement student does. A weekly slot, a
  slot occurrence without a lesson row and a new ad-hoc lesson have no
  absences or replacements: enrolled students. `GROUP_OVER_CAPACITY` and
  `ONE_ON_ONE_STUDENT_COUNT` always count enrolment. Restoring a cancelled
  1-on-1 by deleting its absence checks with that absence left out.
- Availability: a `DATE_AVAILABLE` exception lifts weekly rules on that date
  if it is whole-day or covers the whole lesson; it never lifts a
  `DATE_UNAVAILABLE` rule on the same date.
- Teacher unavailability is overridable because the teacher may agree to
  come in, and a date exception is usually handled with a substitute.

### Saving with an override

The editor shows `validateSlot` results live. To save, it sends the keys of
the overridable conflicts the admin acknowledged. `saveSlot` recomputes the
conflicts inside the transaction and saves only if there is no blocking
conflict and every overridable one is acknowledged (`decideSave`); otherwise
it returns `BLOCKING_CONFLICTS` or `UNACKNOWLEDGED_CONFLICTS` with the fresh
list, so a clash created meanwhile by someone else is never overridden
blindly. The audit entry (`timetable_slot.created` / `.updated`) records the
actor, every overridden conflict (type, key, dates, params) and the
admin's optional `reason`.

All timetable writes of a school take one Postgres advisory lock
(`pg_advisory_xact_lock`), so two admins cannot both pass the check and
double-book the same teacher.

## Slot lifecycle

`TimetableSlot.validFrom` / `validUntil` (inclusive `date`s, null = term
start / end) say when a slot is in effect. Lessons are generated only on
dates in that range.

**Why a range, not `archivedAt`.** Lessons copy group, teacher, room and
times from their slot, and the slot id plus `occurrenceDate` is what keeps
regeneration idempotent. A range keeps past lessons pointing at the template
they were made from, lets the checker compare only the dates on which two
slots both exist (a slot that ended in October does not clash with one
starting in November), and gives the Phase 4 generator "the timetable as of
date X" for free.

**Draft term** (not published, no lessons): editing rewrites the slot in
place; deleting removes it.

**Published term:** every change has an effective date (default today; never
in the past).

| Action                    | What happens                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Create** slot           | `validFrom` = effective date; lessons are generated from then on.                                                                                                                                                                                                                                                                                                                                 |
| **Edit** slot from date D | Its lessons from D on are reconciled away (below). If the slot then has no lessons at all, it is updated in place; otherwise it is **split**: the old slot ends on D − 1 and a new slot with the changes starts on D. Lessons of the new template are generated from D; absences, cancelled 1-on-1s and bookings move to the successor in the same week first (replacements.md §5 _Slot splits_). |
| **End** slot after date L | `validUntil` = L; later lessons are reconciled away; earlier ones stay. A slot ended before it ever took effect, with no lessons left, is deleted.                                                                                                                                                                                                                                                |
| **Delete** slot           | Only if none of its lessons must be kept (`SLOT_HAS_LESSONS` otherwise — end it instead).                                                                                                                                                                                                                                                                                                         |

**Reconciling lessons away.** A SCHEDULED lesson that is no longer wanted is
**deleted** if it is untouched — exactly what its slot generates and nothing
refers to it — and **cancelled** (`cancelReason` `TIMETABLE_CHANGED` or
`HOLIDAY`) if it has a lesson log, teacher notes, absence
reports, replacements or makeup credits, a substitute, or was moved or
re-roomed by hand. Nothing is lost silently; cancelled lessons stay visible
to whoever relied on them. COMPLETED and CANCELLED lessons, lessons before
the effective date and lessons that already started are never touched.

Edge case: when a slot with history is edited from before its first lesson,
the old slot is kept with an empty range (`validUntil < validFrom`, never in
effect) because its cancelled lessons still refer to it. That is why there is
no `valid_from <= valid_until` CHECK.

## Lesson generation

`planLessonSync` is the single, idempotent reconcile step: for a term (or a
few slots) from a date on, it creates missing occurrences, deletes untouched
unwanted lessons and cancels touched ones. Applying its plan and planning
again yields an empty plan. A cancelled lesson is never re-created
automatically (the `(timetable_slot_id, occurrence_date)` row exists).

| Service call                          | Reconciles                                                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `publishTerm(termId)`                 | Refused while any slot has a blocking conflict. Sets `timetablePublishedAt`, generates lessons from max(term start, today). Re-run = regenerate. |
| `regenerateLessons(termId)`           | All slots of a published term from today. Call it after changing a published term's dates.                                                       |
| `saveSlot` / `endSlot` / `deleteSlot` | The affected slot(s) only.                                                                                                                       |
| `saveHoliday` / `deleteHoliday`       | Every published term the holiday touches (its term, or every overlapping term for a school-wide one), from today.                                |

Holidays that apply to a term are its own plus the school-wide ones
(`Holiday.termId` null); every caller uses `holidaysOfTerm`.

## Deleting terms and holidays

- **Term:** only while it has **no lessons**, i.e. before publishing
  (`TERM_HAS_LESSONS` otherwise). Its slots and its own holidays are deleted
  with it (`ON DELETE CASCADE`); school-wide holidays stay. The lessons FK to
  terms is `RESTRICT`, so the database refuses to drop a term with history
  even outside the service. (Before this change, `holidays → terms` was
  `RESTRICT`, which blocked deleting any term that had holidays.)
- **Holiday:** always allowed. In published terms, lessons on its days come
  back from today on.

## Service API (`src/server/timetable/service.ts`)

Every function takes the school-scoped client (`getSchoolScopedDb()`) after
`requireRole("ADMIN")`; writes also take the actor (`{ userId }`) for the
audit log and an optional `now` (tests). Refusals throw `SchedulingError`
with a `code` translated by `scheduling.errors.<code>`; conflicts are
returned, not thrown.

| Function            | Purpose                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `validateSlot`      | Conflicts of a new or edited slot (live display)                     |
| `saveSlot`          | Create/edit with override acknowledgement; audited                   |
| `endSlot`           | End a slot after a date                                              |
| `deleteSlot`        | Delete a slot without history                                        |
| `validateLesson`    | Conflicts of a single lesson change (moves, substitutes; Phases 2–5) |
| `checkTerm`         | Conflicts of every slot in a term (editor overview)                  |
| `publishTerm`       | Publish and generate lessons                                         |
| `regenerateLessons` | Reconcile a published term's lessons                                 |
| `saveHoliday`       | Create/update a holiday and reconcile lessons                        |
| `deleteHoliday`     | Delete a holiday and reconcile lessons                               |
| `deleteTerm`        | Delete a term without lessons                                        |

Audit actions: `timetable_slot.created|updated|ended|deleted`,
`timetable.published`, `lessons.regenerated`, `holiday.created|updated|deleted`,
`term.deleted`.

## Tests

- `src/server/scheduling/*.test.ts`: every conflict type, availability
  exceptions, DST, lesson sync and slot edits.
- `conflicts.property.test.ts`: five seeded realistic schools (20 teachers,
  60 groups incl. 1-on-1s, 15 rooms incl. online, ~330 students, availability
  rules, holidays). The checker must match a brute-force pairwise comparison
  of all generated lessons, report clashes on both sides, be independent of
  input order, give the same answer before and after lessons are generated,
  produce a clash-free timetable when used for greedy placement, and keep
  lessons consistent through slot ends and holiday changes.
- `replacements.property.test.ts` (CARM-46): three seeded realistic schools
  with a clash-free timetable. A random sequence of absences, bookings,
  student cancellations, rejections, room moves and 1-on-1 reschedules,
  each applied only when the rules allow it, must keep: no lesson over its
  room size, no credit backing two things, no student in two overlapping
  lessons, every active booking clean under `reviewReplacement`, every
  `rescheduleOptions` time passing `checkReschedule` and `checkLesson` with
  no conflicts, and the same answers for shuffled inputs.
- `src/server/timetable/split.db.test.ts`: slot-split carry-over against
  Postgres (absences, credits, bookings moved or released, cancelled
  1-on-1 successors), opt-in like the next one.
- `src/server/timetable/service.db.test.ts`: the service against Postgres.
  Opt-in (not in CI yet): point `SCHEDULING_TEST_DATABASE_URL` at a migrated
  scratch database. It creates and removes its own school; if the demo seed is
  present it also checks the demo timetable has no blocking conflicts.
