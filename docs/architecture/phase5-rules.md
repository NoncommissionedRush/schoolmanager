# Notifications, substitutes, ratings & iCal (rules, CARM-64)

**Status: Phase 5, stage 1.** This page defines the rules stage 2
(CARM-65: notifications and substitutes) and stage 3 (CARM-66: ratings and
iCal) build, and the schema they need. The screens are specified in
`docs/design/` by CARM-63; where the two disagree, raise it on the issue
rather than picking one. §9 lists the points the spec has to agree on.

Owner decisions this builds on (CARM-45 / CARM-62, 2026-10-15):

- **Notifications** are in-app only in v1. The design allows email later,
  but nothing calls an external mail service now.
- **Ratings:** students rate their teacher. Only admins see the ratings.
- **Substitutes:** the system suggests eligible substitutes and the admin
  confirms one.

Earlier decisions that still apply: one school per user (multi-school-users.md),
no attendance tracking (`docs/design/lessons.md` §1), `TeacherNote`s never
reach students, every tenant table has `school_id`, every UI string goes
through next-intl.

Terms used below, as in [replacements.md](replacements.md): _now_ is the
server time of the request; a lesson _has started_ when `startsAt ≤ now`
and _has ended_ when `endsAt ≤ now`; two lessons _overlap_ when their
`[startsAt, endsAt)` intervals intersect. Also:

- The **effective teacher** of a lesson is `substituteTeacherId ?? teacherId`,
  exactly as the conflict checker uses it (scheduling.md). The **regular
  teacher** is `teacherId`.
- The **attendees** of a lesson are `attendeesOf(calendar, lessonId, group)`
  (`conflicts.ts`): the group's members on the lesson date minus those with
  an absence report on it, plus its active replacement students.
- A **visible** lesson is one in a published term (`Term.timetablePublishedAt`
  set). Draft terms have no lessons; nothing in this page fires for them.

## 1. Where things live

| Path                                     | What                                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/server/scheduling/substitutes.ts`   | Pure: `checkSubstitute`, `suggestSubstitutes`, `teachingMinutes`, `lessonsNeedingCover` (§3), built on `checkLesson` |
| `src/server/notifications/rules.ts`      | Pure: `recipientsFor(event, facts)`, `coalesce`, retention cut-offs (§2). No Prisma, no Next.js                      |
| `src/server/notifications/service.ts`    | `notify(tx, events)` inside the caller's transaction, inbox reads, mark read                                         |
| `src/server/notifications/channels.ts`   | The `NotificationChannel` interface and the channel registry (§2.6); v1 registers none                               |
| `src/server/substitutes/service.ts`      | Database service: load, suggest, assign, change, remove. One transaction per action under the timetable lock         |
| `src/server/ratings/`                    | Pure rules (`rules.ts`: `canRate`, `ratingWindow`) and the service. **Admin read functions live in `admin.ts`**      |
| `src/server/calendar-feed/`              | Token issue / reset, `buildFeed` (pure: lessons → iCalendar text), the token-only route's loader                     |
| `src/app/api/calendar/[token]/route.ts`  | Public `GET` route, authenticated only by the token (§5)                                                             |
| `messages/en-GB/notifications.json` etc. | `notifications.types.<TYPE>.<audience>`, `substitutes.reasons.<CODE>`, `ratings.*`, `calendarFeed.*`                 |

The pure files follow the scheduling module's contract: plain-data inputs,
deterministic and sorted output, no `Date.now()` or `Math.random()` (the
service passes `now`), every rule covered by a unit test, every reason code
returned (not just the first) so the UI can explain.

## 2. Notifications

### 2.1 Principles

1. **Written in the same transaction as the change.** A service that
   changes something calls `notify(tx, events)` before commit. A rolled-back
   action notifies nobody; a committed one always has its notifications.
   There is no queue and no background job in v1.
2. **The row is the in-app notification.** A `Notification` row per
   recipient is the inbox entry. Other channels (email later) are deliveries
   of that row (§2.6).
3. **Stored as type + params, rendered at read time.** No text is stored.
   The inbox renders `notifications.types.<TYPE>.<audience>` with the
   stored ICU params, so a second language later needs no data migration.
   Params snapshot display names (group, teacher) at creation, so the text
   still reads correctly after a rename or deletion.
4. **Nobody is notified of their own action** (the actor is removed from
   every recipient list), and **nobody is told something they can't read**
   (§2.4).
5. **Only for lessons that haven't ended.** Changes to past lessons (e.g. a
   substitute recorded after the fact, §3.5) notify nobody except where §2.2
   says so.

### 2.2 Events and recipients

`audience` selects the message variant: `teacher` (effective teacher),
`regular` (the regular teacher of a covered lesson), `substitute`,
`student`, `admin`. "Teachers" = the effective teacher plus, when
different, the regular teacher (audience `regular`).

Every lesson event's params also carry `lessonType` (`GROUP` /
`ONE_ON_ONE`), so the 1-on-1 student copy can say "your lesson" instead of
the group name (an ICU `select`, no extra type).

| Type                         | Fired by                                                                                                                                                                                                                                          | Recipients (minus the actor)                                                                                    | Params                                                                                                                                | Link                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `LESSON_CANCELLED`           | A single not-ended lesson becomes `CANCELLED` by an admin action, with `cancelReason` other than `STUDENT_CANCELLED` / `RESCHEDULED`                                                                                                              | Teachers; attendees (audience `student`)                                                                        | `group`, `startsAt`, `endsAt`, `reason` (`cancelReason`)                                                                              | lesson                       |
| `LESSON_MOVED`               | A single not-ended `SCHEDULED` lesson changes `startsAt`, `endsAt` or `roomId`, or a 1-on-1 is rescheduled (old lesson → new one; by the student → teachers only). One type: the copy uses the "now in {room}" variant when only the room changed | Teachers; attendees                                                                                             | `group`, `oldStartsAt`, `oldEndsAt`, `startsAt`, `endsAt`, `oldRoom`, `room`                                                          | lesson (new one)             |
| `SUBSTITUTE_ASSIGNED`        | §3.5 assign, or change (to the new substitute)                                                                                                                                                                                                    | New substitute (`substitute`); regular teacher (`regular`); attendees (`student`)                               | `group`, `startsAt`, `endsAt`, `room`, `substitute`, `teacher` (regular)                                                              | lesson                       |
| `SUBSTITUTE_REMOVED`         | §3.5 remove, or change (to the previous substitute)                                                                                                                                                                                               | Previous substitute (`substitute`); on remove also regular teacher (`regular`) and attendees (`student`)        | `group`, `startsAt`, `endsAt`, `substitute`, `teacher`                                                                                | lesson / timetable           |
| `ABSENCE_REPORTED`           | `AbsenceReport` created (replacements.md §3)                                                                                                                                                                                                      | Effective teacher; the student when an admin reported it                                                        | `group`, `startsAt`, `student` (teacher only), `withCredit` (yes/no)                                                                  | lesson                       |
| `REPLACEMENT_BOOKED`         | `ReplacementRequest` created                                                                                                                                                                                                                      | Effective teacher of the target lesson; the student when an admin booked it                                     | `group`, `startsAt`, `student` (teacher only), `fromGroup`                                                                            | target lesson                |
| `REPLACEMENT_ENDED`          | An active booking becomes `CANCELLED` or `REJECTED`, or an Override moves it to another target (outcome `moved`, to the old target's teacher only)                                                                                                | Effective teacher of the target; the student unless they did it (not for `moved`)                               | `group`, `startsAt`, `student` (teacher only), `outcome` (cancelled/rejected/moved), `creditBack`, `note` (review note, student only) | target lesson                |
| `REPLACEMENT_MOVED`          | An admin Override moves an active booking to another target lesson (replacements.md _Admin review_). Approve, and Override that keeps the target, change nothing for anyone and notify nobody                                                     | The student; the new target's effective teacher gets `REPLACEMENT_BOOKED`                                       | `fromGroup`, `oldStartsAt`, `group`, `startsAt`, `note`                                                                               | new target lesson            |
| `REPLACEMENT_REVIEW_PENDING` | A student books a replacement (it is `AUTO_APPROVED` and enters the admin review queue)                                                                                                                                                           | Every admin of the school (audience `admin`)                                                                    | `count` (bookings since the item was last read, §2.5)                                                                                 | admin review queue           |
| `TIMETABLE_PUBLISHED`        | `publishTerm` the first time for a term (`timetablePublishedAt` was null)                                                                                                                                                                         | Every non-archived teacher with a slot in the term; every student enrolled in a group with a slot in the term   | `term`, `termStart`, `termEnd`, `firstStartsAt` (the recipient's first lesson, null if none)                                          | timetable at `firstStartsAt` |
| `TIMETABLE_CHANGED`          | A **bulk** action changes recipients' not-ended lessons (§2.3): `saveSlot`, `endSlot`, `deleteSlot`, `saveHoliday`, `deleteHoliday`, `regenerateLessons`, re-publish, `applyDraft` (FILL / REPLAN_FROM / teacher-only change)                     | Per recipient: whoever is effective teacher, regular teacher or attendee of an affected lesson, before or after | `term`, `added`, `cancelled`, `moved`, `teacherChanged`, `firstDate`, `lastDate`                                                      | timetable at `firstDate`     |
| `CALENDAR_FEED_REVOKED`      | An admin revokes a user's calendar link (§5.1; owner decision 2026-10-16)                                                                                                                                                                         | The user                                                                                                        | —                                                                                                                                     | calendar subscription page   |

Not notified in v1 (deliberately):

- **"Needs cover"** (§3.7). Only admins record unavailability and archive
  teachers, so the actor is always an admin and the dashboard's _Needs
  attention_ card and the _Needs cover_ tab count already show it.
- **Rating open** (§4). It would be a time-based event and there is no
  scheduler; the student's home card and _Rate your teachers_ page are the
  prompt.
- Makeup credit expiry (no scheduler; the credits card shows days left).

Admins get one type only, `REPLACEMENT_REVIEW_PENDING`, because those
bookings are created by students, not by an admin.

Students only get notifications for lessons they are an attendee of at the
time of the event; a student who left the group or reported an absence is
not told the lesson moved. A replacement student whose booking is released
because the target was cancelled gets `REPLACEMENT_ENDED` (outcome
`cancelled`, `creditBack` per replacements.md §4), not `LESSON_CANCELLED`.

### 2.3 Single and bulk changes

- A service action that changes **one** lesson (admin cancel / move,
  reschedule, substitute) emits per-lesson events.
- An action that can change **many** (the timetable editor, holidays,
  publish, the generator's apply) never sends one notification per lesson.
  It collects, per recipient, the counts of their affected not-ended lessons
  in published terms — `added` (created), `cancelled` (deleted or cancelled),
  `moved` (time or room changed), `teacherChanged` (effective teacher
  changed) — and the first and last affected date, and emits one
  `TIMETABLE_CHANGED` per recipient with a non-zero count. A recipient
  counts on both sides: the old and the new teacher of a teacher change both
  get one.
- `planLessonSync`, `planSlotEdit` and `planGroupTeacherChange` already
  return the lesson plans, so the counts are computed from the plan, not by
  diffing the database. A pure helper `summarizeLessonChanges(before, after)`
  in `rules.ts` does the counting; it is unit-tested against those plans.
- First publish sends `TIMETABLE_PUBLISHED` only (no `TIMETABLE_CHANGED`).

### 2.4 What a notification may contain

The payload follows the reader's existing read rules:

- **Students** never get another student's name, a `TeacherNote`, an
  absence reason or anything from §4 ratings. `student` params are only set
  for teacher audiences.
- **Teachers** get a student's name only where their roster already shows
  it (absences and replacements in their own lesson). Absence reasons are
  not copied into the notification; the lesson page shows them.
- **Links** are stored as `{ kind: "lesson", lessonId }`,
  `{ kind: "timetable", date }`, `{ kind: "replacementReview" }` or
  `{ kind: "calendarFeed" }` and resolved per role at read time
  (`/teacher/lessons/[id]`, `/student/lessons/[id]`, `/admin/lessons/[id]`,
  the role's timetable week). Opening one re-runs the page's normal access
  check, so a substitute removed since sees the usual 404 ("no longer
  available"). Notifications hold no FK to lessons, so they never block a
  lesson deletion.

### 2.5 Deduplication, coalescing and retention

- **No double notifications: the conditional write is the guarantee.**
  Every action that notifies changes state under the timetable lock with a
  conditional write (§3.5 for substitutes; absences, bookings and the editor
  as in replacements.md §8 and scheduling.md). A retried or double-submitted
  action therefore changes nothing the second time (`IS_CURRENT`,
  `LESSON_CHANGED`, an empty sync plan, …) and emits no events. Stage 2's
  db tests prove it this way: run the action twice, expect one
  notification per recipient.
- **`sourceKey` only de-duplicates within one transaction.** It is
  `<audit log id>:<type>:<subject>` (e.g. `…:SUBSTITUTE_ASSIGNED:lesson:<id>`)
  and protects against one action emitting the same event twice for a
  recipient (e.g. a person who is both regular teacher and attendee of the
  plan, or two plans of one action touching the same lesson). `notify`
  first drops duplicate `(recipient, sourceKey)` events in memory, **then**
  coalesces, so counts are never added twice inside an action. The unique
  index on `(school_id, recipient_id, source_key)` with `ON CONFLICT DO
NOTHING` is the backstop for the same thing. It is not a cross-request
  idempotency key; the audit id differs per run.
- **Coalescing while unread.** Each notification also has a `coalesceKey`:

  | Type(s)                                      | `coalesceKey`            | On a new event with the same key, while the old one is unread                                                                                                  |
  | -------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `LESSON_MOVED`                               | `lesson:<id>:moved`      | Replace params with the newest, keep the **oldest** `old*` values                                                                                              |
  | `SUBSTITUTE_ASSIGNED` / `SUBSTITUTE_REMOVED` | `lesson:<id>:substitute` | Replace type and params with the newest; if the result says nothing changed for this recipient (e.g. assigned then removed for the same substitute), delete it |
  | `TIMETABLE_CHANGED`                          | `term:<id>:changed`      | Add the counts, widen `firstDate`–`lastDate`                                                                                                                   |
  | `REPLACEMENT_REVIEW_PENDING`                 | `replacements:review`    | Add 1 to `count`. So an admin has at most one unread item about the review queue                                                                               |
  | everything else                              | null                     | No coalescing                                                                                                                                                  |

  A partial unique index on `(school_id, recipient_id, coalesce_key) WHERE
read_at IS NULL AND coalesce_key IS NOT NULL` makes this an upsert; the
  coalesced row moves to the top (`createdAt` = now) and takes the newest
  event's `sourceKey`. A replay of the older event can't reach this row:
  across requests the conditional write emits nothing (above), and within
  a request the in-memory de-duplication runs before coalescing. A read notification is
  never changed; a new one is created. `LESSON_CANCELLED` deletes an unread
  `lesson:<id>:moved` / `:substitute` row of the same recipient (the
  cancellation supersedes them).

- **No mark as unread** in v1 (CARM-63 design): `readAt` only ever goes
  from null to a time, so the unread-coalesce index never sees a row come
  back.
- **Retention.** Every notification, read or unread, is deleted
  `NOTIFICATION_RETENTION_DAYS` (90) days after `createdAt` (`rules.ts`;
  the inbox caption reads the same constant). Without a scheduler
  the purge runs when a user opens their inbox (their own rows only, one
  indexed `DELETE`) and in a new `pnpm notifications:purge` script. Deliveries cascade.
  Deleting a user deletes their notifications. Because the purge is lazy,
  **every read filters `created_at > now − NOTIFICATION_RETENTION_DAYS`**
  (list, popover, unread count, mark all read). An expired row that hasn't
  been purged yet is invisible everywhere, so the badge never drops when the
  inbox is opened.

### 2.6 Channels (email later without schema changes)

```ts
interface NotificationChannel {
  id: "EMAIL"; // NotificationChannel enum minus IN_APP
  /** Whether this recipient gets this type on this channel (preferences later). */
  wants(n: StoredNotification, recipient: Recipient): boolean;
  /** Called after commit with a PENDING delivery; returns SENT / FAILED. */
  deliver(n: StoredNotification, recipient: Recipient): Promise<DeliveryResult>;
}
```

- `IN_APP` is implicit: the row is the inbox. No delivery row for it.
- For every other **registered** channel whose `wants` is true, `notify`
  writes a `NotificationDelivery` row (`PENDING`) in the same transaction
  (outbox). After commit the dispatcher calls `deliver` and records
  `SENT` / `FAILED` with `attempts` and `lastError`.
- **v1 registers no channel**, so no delivery rows are written and nothing
  calls out. Adding email = implement the channel, render the same i18n
  keys, register it, plus a retry runner for `PENDING` / `FAILED` rows. The
  enum already has `EMAIL`; no table changes. (Per-user opt-outs would be a
  new table; out of scope until the owner asks for them.)

### 2.7 Inbox API and access

| Function                                    | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `listNotifications({ cursor, unreadOnly })` | Own rows only (`school_id` + `recipient_id` = viewer), newest first, 20 per page (the popover asks for 8), keyset on `(created_at, id)`, only rows inside the retention window (§2.5). Runs the purge first. Each item comes with `href` resolved for the viewer's role, or `null` when the target is gone or no longer readable by the viewer ("No longer available"): one batched access query per page, same rules as the lesson pages. |
| `unreadCount()`                             | Own unread rows inside the retention window (§2.5), counted up to 100 (`LIMIT`); the badge format (`9+`) is the UI's. Read on every layout render, one indexed count.                                                                                                                                                                                                                                                                      |
| `markRead(id)`                              | Own row only; another user's or school's id is `NOT_FOUND` (not 403). Idempotent. `markRead` returns the item's `href`.                                                                                                                                                                                                                                                                                                                    |
| `markAllRead({ upTo })`                     | Own unread rows with `(created_at, id) ≤ upTo` (the newest row the client has shown), so a notification arriving meanwhile stays unread.                                                                                                                                                                                                                                                                                                   |

All roles, any signed-in member. Every action re-reads the `Membership`
(as every request does), validates input with zod and goes through
`getSchoolScopedDb()`.

## 3. Substitutes

### 3.1 What a substitute is

A substitute is **one dated lesson** taught by someone other than its
regular teacher. It is stored as today: `Lesson.substituteTeacherId`. Nothing
else on the lesson changes — not `teacherId`, time, room, slot or status.
There is no separate substitution table; history is the audit log (§3.8).

Slot-level changes ("from next week Eva teaches this group") are not
substitutes: they are a teacher change in the editor or the generator
(scheduling.md _Change teacher_).

### 3.2 Which lessons can get one

`SUBSTITUTE_LESSON_REASONS` (any one refuses):

| Code                 | When                                                             |
| -------------------- | ---------------------------------------------------------------- |
| `LESSON_CANCELLED`   | `status` is `CANCELLED`                                          |
| `TERM_NOT_PUBLISHED` | The term is a draft (no lesson rows exist then anyway)           |
| `TOO_LATE_TO_RECORD` | The lesson ended more than `SUBSTITUTE_RECORD_DAYS` (7) days ago |

So an admin can arrange cover before the lesson, at the last minute, and
**record after the fact** for up to 7 days (the regular teacher was ill and
someone stood in; the hours must be right, §3.6). Group and 1-on-1 lessons
follow the same rules.

### 3.3 Who is eligible

For lesson _L_ (group _g_, level _ℓ_) and teacher _t_, `checkSubstitute`
returns every reason that applies:

| #   | Code                  | Severity    | Rule                                                                                                                                             | From                          |
| --- | --------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| 1   | `IS_REGULAR_TEACHER`  | refused     | _t_ = `L.teacherId` (to undo cover, remove the substitute)                                                                                       | —                             |
| 2   | `IS_CURRENT`          | refused     | _t_ = `L.substituteTeacherId`                                                                                                                    | —                             |
| 3   | `ARCHIVED`            | refused     | `User.deletedAt` set, or no `TEACHER` membership                                                                                                 | generator §3.1 rule 1         |
| 4   | `BUSY`                | blocking    | `checkLesson({...L, substituteTeacherId: t})` reports `TEACHER_DOUBLE_BOOKED`                                                                    | `checkLesson`, `rule3Reasons` |
| 5   | `UNAVAILABLE_WEEKLY`  | overridable | … reports `TEACHER_UNAVAILABLE_WEEKLY`                                                                                                           | `checkLesson`, `rule3Reasons` |
| 6   | `UNAVAILABLE_ON_DATE` | overridable | … reports `TEACHER_UNAVAILABLE_ON_DATE`                                                                                                          | `checkLesson`                 |
| 7   | `LEVEL_NOT_TAUGHT`    | overridable | _t_ has no `TeacherLevel` row for _ℓ_ — **including a teacher with no rows at all** (stricter than the editor warning, same as generator rule 2) | generator §3.1 rule 2         |
| 8   | `OVER_MAX_HOURS`      | overridable | `teachingMinutes(t, week of L) + minutes(L) > maxMinutesPerWeek` (§3.4)                                                                          | generator §2.3 / rule 5       |

- **Eligible** (what the owner calls "suggested") = no reason at all.
- **Pick anyway**: a teacher with only overridable reasons can be confirmed
  after the admin acknowledges each (keys `sub:<teacherId>|<code>` or the
  conflict key), exactly like the editor's override (`decideSave`).
  Refused and blocking reasons can't be overridden.
- Only teacher-typed conflicts count. Conflicts that are properties of the
  lesson itself (room capacity, holiday, school hours, student clashes) are
  not the substitute's problem and never block cover; `checkSubstitute`
  filters `checkLesson`'s output to `TEACHER_CONFLICT_TYPES`.
- **Reuse, not copy.** Rules 4–6 are `checkLesson` with the candidate as
  substitute; the context is `loadSchedulingContext` for _L_'s term (which
  includes the lessons, slots, availability and `teacherLevels` that the
  editor uses). The mapping to `BUSY` / `UNAVAILABLE_WEEKLY` reasons and
  their params is the generator's `rule3Reasons` (moved to a shared
  `teacher-reasons.ts` and extended with `UNAVAILABLE_ON_DATE`); the
  reason shape is the generator's `TeacherReason`, so the UI renders both
  with the same component and message keys.
- One-off unavailability is a reason here (unlike the generator, §3.1
  there): cover is for one date, so that date is exactly what matters.

### 3.4 Teaching minutes

`teachingMinutes(lessons, teacherId, range)` (pure, `substitutes.ts`) is
the **one** definition of "minutes a teacher teaches" for Phase 5:

> Σ (`endsAt − startsAt`) over lessons with effective teacher = `teacherId`,
> `status ≠ CANCELLED`, starting in `range`.

- For the max-hours rule, `range` is the ISO week (Monday 00:00 to next
  Monday 00:00, school time zone) containing `L.startsAt`, and the lesson
  being covered is excluded from the sum before adding it. A teacher who
  is the regular teacher of a covered lesson does not count it.
- In a week without substitutes or moved lessons this equals the
  generator's weekly slot minutes (generator §2.3); a property test checks
  that on the realistic fixtures (§7).
- The same function gives the **payroll-relevant hours** (§3.6), so the
  number the admin sees when picking a substitute and the number on a later
  report can't disagree.

### 3.5 Assign, change, remove

All three run in one transaction holding the school's timetable lock
(`lockTimetable`, as every timetable write), re-load the lesson and the
context, re-run the checks and write only if nothing changed meanwhile:
the update is `WHERE id = $id AND substitute_teacher_id IS NOT DISTINCT
FROM $expected AND starts_at = $expectedStart` and must affect one row;
otherwise `LESSON_CHANGED` with the fresh lesson and reasons.

| Action                       | Checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Writes                       | Notifies (§2.2)                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| **Assign** _t_ (none before) | §3.2, then §3.3 for _t_ with acknowledgements                                                                                                                                                                                                                                                                                                                                                                                                                             | `substituteTeacherId = t`    | `SUBSTITUTE_ASSIGNED` (not ended only)                                        |
| **Change** _s_ → _t_         | As assign                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `substituteTeacherId = t`    | `SUBSTITUTE_REMOVED` to _s_; `SUBSTITUTE_ASSIGNED` to _t_, regular, attendees |
| **Remove** _s_               | All of §3.2 (`LESSON_CANCELLED`, `TERM_NOT_PUBLISHED`, `TOO_LATE_TO_RECORD`), as for assign; an **archived** regular teacher (§3.3 rule 3) refuses (`REGULAR_TEACHER_ARCHIVED`; change the substitute instead, or change the slot's teacher); then `checkLesson({...L, substituteTeacherId: null})` for the **regular** teacher: `TEACHER_DOUBLE_BOOKED` refuses (`REGULAR_TEACHER_BUSY`; pick another substitute instead), other teacher-typed conflicts are overridable | `substituteTeacherId = null` | `SUBSTITUTE_REMOVED`                                                          |

- A lesson that has **started** keeps the same actions (for the record);
  only students are no longer notified once it started, and nobody once it
  ended. Recording after the end starts from the admin lesson page (the
  _Needs cover_ list only holds lessons that haven't started).
- The sheet's "who will be notified" line comes from the server
  (`notifyPreview: { teachers: [{ id, name, audience }], studentCount }`,
  computed by the same `recipientsFor` the action uses), so the preview and
  the actual notifications can't disagree.
- An optional admin `reason` (≤ 300 characters) goes to the audit log only.
- Admin-only: `requireRole("ADMIN")` on every action and on
  `suggestSubstitutes`; the lesson id is looked up through
  `getSchoolScopedDb()`, so another school's id is `NOT_FOUND`.

### 3.6 How it interacts with the rest

| Area                        | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conflict checker            | Unchanged: it already checks the effective teacher everywhere. A substitute occupies their own time; the regular teacher of a covered lesson is free then.                                                                                                                                                                                                                                                                                                                             |
| Timetables & dashboards     | Unchanged queries (`teacherId = me OR substituteTeacherId = me`, `week.ts` `TeacherRole`): the substitute sees the lesson as `substituting`, the regular teacher as `covered`. Dashboard counts ("lessons this week") count lessons where the viewer is the **effective** teacher.                                                                                                                                                                                                     |
| Lesson log, homework, notes | Unchanged (lessons.md §2): regular teacher and substitute both have full rights on that lesson; `LessonLog.authorId` / `updatedById` record who wrote. A removed substitute loses access with the row.                                                                                                                                                                                                                                                                                 |
| Attendance                  | Not tracked (owner decision). The roster (`buildRoster`) is shown to the effective teacher and the regular teacher, unchanged.                                                                                                                                                                                                                                                                                                                                                         |
| Student absences            | Independent of the teacher. `ABSENCE_REPORTED` goes to the effective teacher at the time of the report; a later substitute sees the absence on the roster.                                                                                                                                                                                                                                                                                                                             |
| Replacements                | Eligibility is by group level and seats, not by teacher: unaffected. Booking screens already show `substituteTeacher ?? teacher`. `REPLACEMENT_*` notifications go to the effective teacher.                                                                                                                                                                                                                                                                                           |
| 1-on-1 reschedule           | The new ad-hoc lesson starts **without** a substitute (`createRescheduled` in `src/server/replacements/reschedule.ts` creates it without a substitute, so the column defaults to null): cover was arranged for the old date. The old lesson is cancelled `RESCHEDULED` and keeps its substitute for history. The regular teacher and the student get `LESSON_MOVED` (old → new time); a substitute of the old lesson gets `SUBSTITUTE_REMOVED` instead.                                |
| Lesson moved (admin)        | The substitute stays. The move is checked with `checkLesson`, which checks the effective teacher, i.e. the substitute: busy blocks the move, unavailability / max hours need acknowledgement. The move dialog offers "remove substitute" as the alternative (then the regular teacher is checked). A move never silently drops a substitute. No separate "check substitute" flag: if the substitute is away at the new time, the lesson is in _Needs cover_ (§3.7, `who: SUBSTITUTE`). |
| Lesson cancelled            | `substituteTeacherId` stays for history; cancelled lessons occupy nothing and count no minutes. Restoring a cancelled 1-on-1 (absence delete, replacements.md §3) runs `checkLesson` with the substitute.                                                                                                                                                                                                                                                                              |
| Editor slot edit / split    | Unchanged: a lesson with a substitute counts as touched and is cancelled `TIMETABLE_CHANGED`, not deleted; the successor lesson has no substitute. The substitute is in the `TIMETABLE_CHANGED` counts (`cancelled`). The admin re-arranges cover on the new lesson.                                                                                                                                                                                                                   |
| Teacher-only change         | Unchanged (`planGroupTeacherChange`): the substitute stays, and is cleared if they are the new regular teacher.                                                                                                                                                                                                                                                                                                                                                                        |
| Teacher archived            | A teacher with future lessons as effective teacher (regular or substitute) appears in the "needs cover" list (§3.7). Profiles are never hard-deleted (`onDelete: Restrict`).                                                                                                                                                                                                                                                                                                           |
| Max hours                   | Substitute minutes count toward the substitute's week (§3.4) and not the regular teacher's.                                                                                                                                                                                                                                                                                                                                                                                            |
| Payroll-relevant hours      | `teachingMinutes` over ended, non-cancelled lessons: the **effective** teacher's. Not in scope until Phase 6 reports, but no other definition may be introduced.                                                                                                                                                                                                                                                                                                                       |

### 3.7 Suggestions and "needs cover"

`suggestSubstitutes(calendar, lesson, teachers, history)` returns **every**
non-archived teacher of the school except the regular one, each with its
reasons (§3.3) and rank facts, sorted:

1. Eligible first, then pick-anyway (only overridable reasons, fewest
   first), then blocked/refused; archived teachers are left out.
2. Within each band, by these keys in order (all integers, so the order is
   exactly reproducible):

   | Key                 | Prefer | Meaning                                                                                                                    | Why                            |
   | ------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
   | `knowsGroup`        | yes    | _t_ was effective teacher of a non-cancelled ended lesson of _g_ in this or the previous term                              | Continuity for the students    |
   | `sameDay`           | yes    | _t_ already teaches (effectively) on _L_'s local date, with a lesson ending ≤ 90 min before or starting ≤ 90 min after _L_ | No extra trip, no long gap     |
   | `weekMinutesAfter`  | fewer  | `teachingMinutes(week) + minutes(L)`                                                                                       | Even workload (generator §3.3) |
   | `termSubstitutions` | fewer  | Lessons of this term _t_ already substitutes (not cancelled)                                                               | Share the cover                |
   | name, then id       | —      | Stable tie-break                                                                                                           | Determinism                    |

3. Each entry: `{ teacherId, name, band, rank, reasons[], hints[],
facts: { knowsGroup, sameDay, weekMinutesBefore, weekMinutesAfter,
maxMinutes, termSubstitutions } }`, so the UI shows why someone is
   suggested ("Taught B1 Evening · already in on Tuesday · 12 of 20 h this
   week") as well as why not. `band` is `SUGGESTED` (no reason),
   `WITH_WARNING` (only overridable reasons) or `NOT_POSSIBLE` (a blocking
   reason, i.e. `BUSY`). `rank` numbers the `SUGGESTED` band from 1.
4. `hints` (only in `SUGGESTED`, at most two, in this order, codes for
   `substitutes.hint.*`): `KNOWS_GROUP` (`knowsGroup`), `SAME_DAY`
   (`sameDay`), `FEWEST_HOURS` (the lowest `weekMinutesAfter` in the band,
   ties included). They explain the order; no score is returned.
5. The **current substitute** is returned first with `current: true` and its
   reasons (so the admin sees whether they are still fine); it can't be
   assigned again (`IS_CURRENT`): the sheet offers _Remove_ for it. The
   regular teacher and archived teachers are never returned.

**Needs cover** (`lessonsNeedingCover(calendar, from, to)`; the admin's
tab uses now → now + `NEEDS_COVER_DAYS` (56, i.e. 8 weeks)): not-cancelled,
not-started lessons whose **effective** teacher has
`TEACHER_UNAVAILABLE_ON_DATE` or `TEACHER_DOUBLE_BOOKED` on them
(`checkLesson`), or is archived. Each entry is `{ lessonId, who: REGULAR |
SUBSTITUTE, reasons: (UNAVAILABLE_ON_DATE | DOUBLE_BOOKED | ARCHIVED)[] }`,
so a covered lesson whose substitute is now away or archived comes back
with `who: SUBSTITUTE` ("Substitute away" / "Substitute archived"). Weekly
unavailability is left out on purpose: it is known when the slot is planned
and was already acknowledged in the editor, so it would sit in the list
forever.

That is how a teacher's sick day reaches the substitute flow: the admin
records it as a `DATE_UNAVAILABLE` rule (teacher availability) and the
affected lessons appear here, each with _Find substitute_. The _Cover a
teacher_ dialog's "Also mark {teacher} as away" (ticked by default; owner decision 2026-10-16) writes
one `DATE_UNAVAILABLE` row per date through the existing availability
service (same validation, same audit), in its own transaction before the
list loads. Nothing is assigned automatically. One substitute for several
lessons at once is not in v1 (owner decision 2026-10-16): each lesson is
assigned on its own.

### 3.8 Audit

`lesson.substitute_assigned`, `lesson.substitute_changed`,
`lesson.substitute_removed`, with `{ lessonId, from, to, reason,
overridden: [{ code, key, params }], recordedAfterEnd: boolean }`.

## 4. Ratings

### 4.1 Who can rate whom, and when

A student _s_ may rate teacher _t_ for term _T_ when all hold
(`canRate`, pure; returns every failing reason):

| Code              | Rule                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `NOT_A_STUDENT`   | _s_ has a `STUDENT` membership in the school and is not deleted                                                            |
| `TEACHER_UNKNOWN` | _t_ is a teacher of the same school (archived teachers can't be rated)                                                     |
| `TOO_FEW_LESSONS` | _s_ **attended** ≥ `RATING_MIN_LESSONS` (3) lessons of _T_ whose effective teacher was _t_                                 |
| `NOT_OPEN_YET`    | now is before `ratingOpensAt(T)` = start of the local day `T.startDate + ⌊(T.endDate − T.startDate) / 2⌋` days (half-term) |
| `WINDOW_CLOSED`   | now is at or after `ratingClosesAt(T)` = start of the local day `RATING_GRACE_DAYS` (14) after `T.endDate`                 |

**Attended** (there is no attendance record; owner decision): the lesson
has ended, is not `CANCELLED`, and _s_ was an attendee — a member of the
group on the lesson date with no absence report on it, or held an active
replacement into it. This is the `attendeesOf` rule applied to ended
lessons; a pure `attendedLessons(student, lessons, …)` in `ratings/rules.ts`
uses it. A substitute who covered three of a student's lessons in a term can
be rated like anyone else; a one-off cover can't. "Attended" means
**ended**, not just started.

The student's list (_Rate your teachers_) shows every teacher for whom only
`NOT_OPEN_YET` fails, with `opensAt` ("You can rate {teacher} from
{date}"), and every teacher they can rate or have rated, with `editableUntil`
= `ratingClosesAt(T)`. The UI never computes these dates itself.

### 4.2 The rating

- **One rating per student, teacher and term** (unique). Re-rating in a
  later term is a new row, so admins can see change over time.
- **Scale:** `score` integer 1–5 (stars), required. `comment` optional, ≤
  1,000 characters, trimmed, empty = null.
- **Editing:** the student can change their own rating while the window
  is open (§4.1); after it closes it is read-only for them. Every write
  re-checks `canRate`. **No delete** in v1 (owner decision 2026-10-16, CARM-63 §11 Q4);
  allowing it later is one action, no schema change.
- **Admins can't edit** a rating. They can **hide** one (`hiddenAt`,
  `hiddenById`, e.g. abusive comment): hidden ratings are excluded from
  averages and shown collapsed; audited as `rating.hidden` / `.unhidden`.

### 4.3 Who sees what

- **Teachers never see ratings** — not their own, not anyone's, not
  aggregates, not even whether someone rated them. Same for students
  (except their own rating, §4.2). This is the anonymity towards the
  teacher, and it is total.
- **Admins of the school** see all ratings with the student's name (for
  follow-up and abuse handling), per teacher and term: average (hidden ones
  excluded), count, distribution 1–5, and the list with comments. With
  fewer than 3 visible ratings the average is shown as "—" and the count
  as "too few to average".
- The student's form says who reads it (UX copy): "Only the school office
  sees your rating. Your teacher never does."

### 4.4 Server-side enforcement

- `src/server/ratings/admin.ts` holds every function that reads other
  people's ratings. Each starts with `requireRole("ADMIN")` and uses
  `getSchoolScopedDb()`. **Allow-list:** only files under
  `src/app/admin/**` and `src/server/ratings/**` may import `admin.ts`; a
  unit test (like the teacher-notes import guard) scans every other file
  in `src/` (pages, API routes, shared components, other services) and
  fails if one does.
- `src/server/ratings/student.ts` reads and writes only
  `studentId = viewer's StudentProfile`, returns a student DTO (score,
  comment, editable until), and never returns aggregates.
- Rating ids are never sent to teachers or students other than the author;
  a guessed id is `NOT_FOUND`.
- No notification, dashboard count, iCal field or teacher DTO contains
  rating data (§2.4, §5.3). The Phase 5 permission suite (CARM-67) covers
  every page, action and route.

### 4.5 Audit

`rating.created`, `rating.updated`, `rating.hidden`, `rating.unhidden`. Audit `data` carries ids and the score
change only, **not the comment** (the audit log is admin-readable anyway,
but keep comments in one place).

## 5. iCal subscription

### 5.1 Token

- One **active** feed per user (teachers and students; admins have no feed
  in v1). Row `CalendarFeed { schoolId, userId, salt, tokenHash, createdAt,
revokedAt, lastUsedAt }`.
- `token = base64url(HMAC-SHA256(ICAL_TOKEN_SECRET, salt))` (256 bits).
  `salt` is 32 random bytes per row; `tokenHash = sha256(token)` is unique
  and is what the route looks up. So:
  - the server can show the same link again (it recomputes the token from
    `salt`), which _Copy link_ needs;
  - a database dump alone can't produce working links (needs the secret);
  - changing `ICAL_TOKEN_SECRET` invalidates every link (documented in the
    README; `.env.example` gets the variable).
- **Created on request** (_Create my calendar link_), never by opening the
  page, so unused links don't exist and a `GET` has no side effect.
  **Reset** = set `revokedAt` on the active row and create a new one, in one
  transaction; the old link stops working at once. Audit
  `calendar_feed.created`, `calendar_feed.reset` (no token in the audit).
- **Admin revoke** (owner decision 2026-10-16, CARM-63 §11 Q6): from the
  user's admin page an admin sets `revokedAt` on the active row and creates
  **no** new one (the admin must never see a user's link); the user gets
  `CALENDAR_FEED_REVOKED` and creates a new link themselves. Audit
  `calendar_feed.revoked`.
- A partial unique index allows one row with `revoked_at IS NULL` per
  `(school_id, user_id)`.

### 5.2 Route and authentication

`GET /api/calendar/<token>.ics`, no session:

1. Look up `tokenHash` (constant-time compare is not needed for a hash
   lookup; the token itself is never logged). Any failure — unknown token,
   revoked, user deleted, no `TEACHER`/`STUDENT` membership in **the feed
   row's school** — returns **404** with an empty body, never 401/403, so
   nothing is revealed.
2. Every query uses the feed row's `schoolId` and `userId`, with the role
   read from the membership **now** (a student who became a teacher gets the
   teacher feed).
3. `lastUsedAt` is updated at most once an hour (no write per poll).
4. Response: `text/calendar; charset=utf-8`, `Cache-Control: private,
max-age=900`, `ETag` = sha256 of the body; `If-None-Match` → 304.

### 5.3 Contents

Window: lessons starting from **30 days ago to 180 days ahead**, in
published terms (`FEED_PAST_DAYS`, `FEED_FUTURE_DAYS`). A fixed window, not
"to the end of next term", so the feed size is bounded however long terms
are; lessons only exist for published terms anyway. Per role:

| Role    | Lessons                                                                                                                           |
| ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Teacher | Effective teacher = me (regular or substituting); and lessons where I'm the regular teacher but someone covers (shown as covered) |
| Student | Lessons I'm a member of on the lesson date, plus lessons I hold an active replacement into                                        |

Per lesson, one `VEVENT`:

| Property            | Value                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `UID`               | `lesson-<lessonId>@schoolmanager` — stable, so a moved or cancelled lesson updates the same event                                                |
| `DTSTART` / `DTEND` | The lesson's instants in **UTC** (`…Z`). Lessons store instants, so no `VTIMEZONE` is needed and DST is already correct; clients show local time |
| `DTSTAMP`           | Response time (UTC)                                                                                                                              |
| `LAST-MODIFIED`     | `Lesson.updatedAt`                                                                                                                               |
| `SEQUENCE`          | Seconds from 2026-01-01T00:00Z to `Lesson.updatedAt` (increases on every change, fits a 32-bit int for decades)                                  |
| `SUMMARY`           | From i18n per case below (`calendarFeed.event.*`); for a 1-on-1 the student's feed uses the lesson type instead of their own name                |
| `LOCATION`          | Room name (online rooms too, without their link)                                                                                                 |
| `URL`               | The role's lesson page (it shows the meeting link after sign-in). Never the room's `meetingUrl`                                                  |
| `DESCRIPTION`       | Level, effective teacher's name, "Substitute for {regular}" when covered, link to the lesson page                                                |
| `STATUS`            | `CONFIRMED`, or `CANCELLED` (below)                                                                                                              |
| `TRANSP`            | `OPAQUE`, or `TRANSPARENT` (below)                                                                                                               |

Cases:

| Case                                                  | SUMMARY prefix (i18n `calendarFeed.*`)               | STATUS    | TRANSP      |
| ----------------------------------------------------- | ---------------------------------------------------- | --------- | ----------- |
| Normal                                                | `{group}`                                            | CONFIRMED | OPAQUE      |
| Substituted, student viewing                          | `{group} (substitute: {substitute})`                 | CONFIRMED | OPAQUE      |
| Substituted, substitute viewing                       | `Substituting: {group}`                              | CONFIRMED | OPAQUE      |
| Substituted, regular teacher viewing                  | `Covered by {substitute}: {group}`                   | CONFIRMED | TRANSPARENT |
| Cancelled (any reason)                                | `Cancelled: {group}`                                 | CANCELLED | TRANSPARENT |
| Student reported an absence (group lesson still runs) | `Not attending: {group}`                             | CONFIRMED | TRANSPARENT |
| Substitute removed / student left / replacement ended | The event disappears from the feed (clients drop it) |

Cancelled lessons stay in the feed (inside the window) so subscribed
clients mark the existing event cancelled instead of keeping a stale one.

**Never in a feed**, because a calendar URL is easy to leak (shared
calendars, forwarded links): other students' names, rosters, `TeacherNote`s,
absence reasons, ratings, lesson logs, homework, or an online room's
`meetingUrl` (a leaked feed would otherwise let anyone join every online
lesson in the window). Calendar header:
`X-WR-CALNAME` = "{school} — {user}" (i18n), `X-WR-TIMEZONE` = the school's
time zone (display hint only).

`buildFeed(lessons, viewer, messages, now)` is pure and returns the text;
CRLF line endings, 75-octet line folding and text escaping per RFC 5545 are
unit-tested, and one test parses the output with a real iCalendar parser
(`ical.js`, dev dependency).

## 6. Schema

Additive only; no existing column changes. Every new table carries
`school_id`, `@@unique([schoolId, id])`, and composite FKs to tenant
tables, so `src/server/data-model.test.ts` keeps passing. User references
are plain FKs, as elsewhere.

```prisma
enum NotificationType {
  LESSON_CANCELLED
  LESSON_MOVED
  SUBSTITUTE_ASSIGNED
  SUBSTITUTE_REMOVED
  ABSENCE_REPORTED
  REPLACEMENT_BOOKED
  REPLACEMENT_ENDED
  REPLACEMENT_MOVED
  REPLACEMENT_REVIEW_PENDING
  TIMETABLE_PUBLISHED
  TIMETABLE_CHANGED
  CALENDAR_FEED_REVOKED
}

/// Out-of-app channels; IN_APP is the Notification row itself and never
/// gets a delivery row (docs/architecture/phase5-rules.md §2.6).
enum NotificationChannel {
  IN_APP
  EMAIL
}

enum DeliveryStatus {
  PENDING
  SENT
  FAILED
  SKIPPED
}

/// One in-app notification for one user. Rendered at read time from
/// `type` + `params` (no stored text). No FK to the subject, so it never
/// blocks deleting a lesson. See phase5-rules.md §2.
model Notification {
  id          String           @id @default(uuid()) @db.Uuid
  schoolId    String           @map("school_id") @db.Uuid
  recipientId String           @map("recipient_id") @db.Uuid
  type        NotificationType
  /// teacher | regular | substitute | student | admin — selects the message variant.
  audience    String
  /// ICU params, display names snapshotted at creation.
  params      Json             @default("{}")
  /// { kind: "lesson", lessonId } | { kind: "timetable", date }.
  link        Json?
  /// `<audit log id>:<type>:<subject>`; de-duplicates within one action
  /// only (§2.5). Cross-request safety is the action's conditional write.
  sourceKey   String           @map("source_key")
  /// Merges unread notifications about the same subject (§2.5).
  coalesceKey String?          @map("coalesce_key")
  actorId     String?          @map("actor_id") @db.Uuid
  createdAt   DateTime         @default(now()) @map("created_at")
  readAt      DateTime?        @map("read_at")

  school     School                 @relation(fields: [schoolId], references: [id], onDelete: Cascade)
  recipient  User                   @relation("NotificationRecipient", fields: [recipientId], references: [id], onDelete: Cascade)
  actor      User?                  @relation("NotificationActor", fields: [actorId], references: [id], onDelete: SetNull)
  deliveries NotificationDelivery[]

  @@unique([schoolId, id])
  @@unique([schoolId, recipientId, sourceKey])
  /// Inbox page and unread count.
  @@index([schoolId, recipientId, createdAt(sort: Desc), id])
  @@index([schoolId, recipientId, readAt])
  @@map("notifications")
}
// Migration adds: CREATE UNIQUE INDEX notifications_unread_coalesce ON
// notifications (school_id, recipient_id, coalesce_key)
// WHERE read_at IS NULL AND coalesce_key IS NOT NULL;
// CHECK (audience IN ('teacher','regular','substitute','student','admin')).

/// A notification sent on an out-of-app channel (outbox). Unused in v1.
model NotificationDelivery {
  id             String              @id @default(uuid()) @db.Uuid
  schoolId       String              @map("school_id") @db.Uuid
  notificationId String              @map("notification_id") @db.Uuid
  channel        NotificationChannel
  status         DeliveryStatus      @default(PENDING)
  attempts       Int                 @default(0)
  lastError      String?             @map("last_error")
  sentAt         DateTime?           @map("sent_at")
  createdAt      DateTime            @default(now()) @map("created_at")
  updatedAt      DateTime            @updatedAt @map("updated_at")

  school       School       @relation(fields: [schoolId], references: [id], onDelete: Cascade)
  notification Notification @relation(fields: [schoolId, notificationId], references: [schoolId, id], onDelete: Cascade)

  @@unique([schoolId, id])
  @@unique([notificationId, channel])
  @@index([schoolId, status, createdAt])
  @@map("notification_deliveries")
}
// CHECK (channel <> 'IN_APP').

/// A student's rating of a teacher for a term. Admin-readable only
/// (phase5-rules.md §4); teachers never read this table.
model TeacherRating {
  id         String    @id @default(uuid()) @db.Uuid
  schoolId   String    @map("school_id") @db.Uuid
  studentId  String    @map("student_id") @db.Uuid
  teacherId  String    @map("teacher_id") @db.Uuid
  termId     String    @map("term_id") @db.Uuid
  /// 1–5 (CHECK).
  score      Int
  /// ≤ 1,000 characters (CHECK), null when empty.
  comment    String?
  hiddenAt   DateTime? @map("hidden_at")
  hiddenById String?   @map("hidden_by_id") @db.Uuid
  createdAt  DateTime  @default(now()) @map("created_at")
  updatedAt  DateTime  @updatedAt @map("updated_at")

  school   School         @relation(fields: [schoolId], references: [id], onDelete: Cascade)
  student  StudentProfile @relation(fields: [schoolId, studentId], references: [schoolId, id], onDelete: Cascade)
  teacher  TeacherProfile @relation(fields: [schoolId, teacherId], references: [schoolId, id], onDelete: Restrict)
  term     Term           @relation(fields: [schoolId, termId], references: [schoolId, id], onDelete: Restrict)
  hiddenBy User?          @relation(fields: [hiddenById], references: [id], onDelete: SetNull)

  @@unique([schoolId, id])
  @@unique([schoolId, studentId, teacherId, termId])
  @@index([schoolId, teacherId, termId])
  @@map("teacher_ratings")
}
// CHECK (score BETWEEN 1 AND 5), CHECK (char_length(comment) <= 1000),
// CHECK (hidden_by_id IS NULL OR hidden_at IS NOT NULL) (the admin may be
// deleted later, which nulls hidden_by_id).

/// A user's private iCal subscription (phase5-rules.md §5). The token is
/// HMAC(ICAL_TOKEN_SECRET, salt); only its hash is stored.
model CalendarFeed {
  id         String    @id @default(uuid()) @db.Uuid
  schoolId   String    @map("school_id") @db.Uuid
  userId     String    @map("user_id") @db.Uuid
  salt       Bytes
  tokenHash  String    @unique @map("token_hash")
  createdAt  DateTime  @default(now()) @map("created_at")
  revokedAt  DateTime? @map("revoked_at")
  lastUsedAt DateTime? @map("last_used_at")

  school School @relation(fields: [schoolId], references: [id], onDelete: Cascade)
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([schoolId, id])
  @@index([schoolId, userId])
  @@map("calendar_feeds")
}
// CREATE UNIQUE INDEX calendar_feeds_one_active ON calendar_feeds
// (school_id, user_id) WHERE revoked_at IS NULL;
```

Changes to existing models:

- `Lesson`: new index `@@index([schoolId, substituteTeacherId, startsAt])`
  (substitute timetables, `teachingMinutes`, feeds, "needs cover"). No
  column changes.
- Back-relations on `School`, `User`, `StudentProfile`, `TeacherProfile`,
  `Term` for the new models.
- `.env.example`: `ICAL_TOKEN_SECRET` (32+ random bytes); the app refuses to
  start the feed route without it.

`tokenHash` is globally unique (not per school) because the route looks it
up before it knows the school; it is a hash of a 256-bit secret, so that
reveals nothing. It is the only global lookup in this phase.

## 7. Tests stage 2 and 3 must add

Unit (pure, no database):

- `substitutes.test.ts`: every reason code of §3.2–§3.3 alone and
  combined; filtering out lesson-only conflicts; `IS_REGULAR_TEACHER` /
  `IS_CURRENT`; teacher with no level rows; one-off unavailability; max
  hours at exactly the limit (allowed) and one minute over; covered lesson
  not counted for the regular teacher; DST week boundaries; ranking keys
  one by one; hints; the current substitute's entry; output independent of
  input order; `lessonsNeedingCover` for regular and substitute, with weekly
  unavailability left out.
- `substitutes.property.test.ts` on the realistic fixtures (20 teachers,
  60 groups, 15 rooms; seeded): for random lessons, every eligible
  suggestion, applied, leaves `checkTimetable` / `checkLesson` with no new
  teacher conflict and no teacher over their maximum; `checkSubstitute`
  agrees with a brute-force overlap scan; `teachingMinutes` equals the
  generator's weekly minutes in weeks without substitutes or moves; a random
  sequence of assign / change / remove / move / reschedule keeps every
  teacher in at most one lesson at a time.
- `notifications/rules.test.ts`: recipients per event and audience, actor
  excluded, absent and departed students excluded, no `student` param for
  student audiences, coalescing table of §2.5, `summarizeLessonChanges` on
  `planLessonSync` / `planGroupTeacherChange` plans, retention cut-offs.
- `ratings/rules.test.ts`: `canRate` reasons, attended counting (absence,
  replacement, membership dates, cancelled, started but not ended), half-term
  opening and closing boundaries in the school time zone (odd and even term
  lengths).
- `calendar-feed/build.test.ts`: each case of §5.3, escaping and folding,
  stable UIDs, increasing `SEQUENCE`, nothing forbidden in the output for a
  fixture full of notes, reasons and other students.

Database (`*.db.test.ts`): notifications written in the action's
transaction and absent after a rollback; every notifying action run twice
gives one notification per recipient (second run is a no-op); one action
emitting a duplicate event per recipient stores one row and, for
`TIMETABLE_CHANGED`, counts it once; the
unread-coalesce index; substitute assign racing a lesson move (lock +
conditional update → `LESSON_CHANGED`); feed reset invalidates the old
token; feed of school A's token never returns school B's lessons.

The e2e permission cases are CARM-67's scope (its issue lists them).

## 8. Owner decisions (2026-10-16)

The owner accepted every default proposed here (CARM-64, 2026-10-16). Each
is still one constant or one rule to change later:

1. **Rating threshold and window**: 3 attended lessons with the teacher in
   the term; open from half-term until 14 days after the term ends; one
   rating per teacher per term, editable (not deletable) while open.
2. **Admins see who rated** (name next to the rating). The alternative —
   anonymous even to admins — makes abuse handling impossible; teachers see
   nothing either way.
3. **Students are notified of substitutes** (`SUBSTITUTE_ASSIGNED` /
   `_REMOVED`). Turning it off is one line in `recipientsFor`.
4. **Recording a substitute after the lesson**: allowed for 7 days, for
   correct hours, without notifying students.
5. **Pick anyway**: an admin may confirm a teacher who doesn't teach the
   level, is unavailable or over their maximum, after acknowledging each
   warning; a teacher who is busy then can never be picked.
6. **Cover a teacher** also marks the teacher as away on the covered dates
   (§3.7); the checkbox is ticked by default. One substitute for several
   lessons at once is not in v1.
7. **Calendar feeds**: no admin feed in v1; admins can revoke a user's link
   (`CALENDAR_FEED_REVOKED`, §5.1). Students can't delete a rating (§4.2).

## 9. Agreed with the design spec (CARM-63)

The spec's §11 assumptions, checked against this page. Where they differ,
this page is the rule and the spec follows.

| #   | Spec assumption                        | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Events, recipients, batching           | Confirmed with changes (§2.2): one `LESSON_MOVED` type for time and room (room-only copy variant); `ABSENCE_REPORTED` / `REPLACEMENT_*` go to the **effective** teacher only, not also the regular one; the spec's `replacementReviewed` is `REPLACEMENT_ENDED` (rejected) or `REPLACEMENT_MOVED`; `replacementNeedsReview` is `REPLACEMENT_REVIEW_PENDING` (coalesced while unread, not per day); **no** `needsCover` and **no** `ratingOpen` notification in v1; `calendarLinkReset` is `CALENDAR_FEED_REVOKED`, only with admin revoke. Student copy is also needed for `ABSENCE_REPORTED` / `REPLACEMENT_BOOKED` made by an admin and for `REPLACEMENT_ENDED` (cancelled, rejected). |
| A2  | Type + params + target, render on read | Confirmed (§2.1, §2.4). Lists return `href` or `null` per item.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| A3  | 90-day retention                       | Confirmed: every notification is deleted 90 days after it was created (§2.5). No mark as unread (dropped by the design, CARM-63 `aaa75a5`); the badge format is the UI's.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A4  | "Needs cover"                          | Corrected (§3.7): based on the **effective** teacher, so a covered lesson whose substitute is away or archived comes back; one-off unavailability, archived, or double-booked; 8 weeks ahead. No "check substitute" badge after a move.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| A5  | Picker groups and hints                | Confirmed with changes (§3.3, §3.7): one-off unavailability is a **warning**, not "not possible"; archived teachers aren't listed at all; the current substitute is listed first and marked current; hints are `KNOWS_GROUP`, `SAME_DAY`, `FEWEST_HOURS`; the "will be notified" line comes from the server.                                                                                                                                                                                                                                                                                                                                                                             |
| A6  | Started lessons, cancelled lessons     | Confirmed, plus: after the lesson **ended** nobody is notified, and the record window is 7 days after the end (also on _Past_ and the lesson page). Removing a substitute is refused when the regular teacher teaches another lesson then (`REGULAR_TEACHER_BUSY`) or is archived (`REGULAR_TEACHER_ARCHIVED`); the dialog needs both states.                                                                                                                                                                                                                                                                                                                                            |
| A7  | Rating eligibility                     | Confirmed with changes (§4.1, §4.2): lessons must have **ended**; window opens at half-term and closes **14 days after** term end (`editableUntil` from the server); no delete. Admins can **hide** a rating (abusive comment), which the admin detail page needs as a row action.                                                                                                                                                                                                                                                                                                                                                                                                       |
| A8  | Feed                                   | Corrected (§5): window is 30 days back to 180 days ahead; times are UTC instants (no `TZID`); event titles are the spec's §7.6 texts, plus `Not attending: {group}`; links are created on request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
