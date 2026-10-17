# Reports (rules, CARM-71)

**Status: Phase 6, stage 1.** This page defines the rules that CARM-73
(reports with CSV export) builds: the exact definitions behind the
attendance and teacher-hours reports, their filters and limits, the CSV
format and the permissions. The screens are specified in
[`docs/design/reports.md`](../design/reports.md) (CARM-70). Where the two
disagree, this page is the rule for behaviour and the spec follows; §8
lists the points checked against it.

Owner decisions this builds on:

- 2026-10-16 (CARM-69): no parent accounts or logins; no multi-school UI
  (a user belongs to exactly one school, so there is no school switcher).
- 2026-10-17 (CARM-70): **payments are out of scope.** Prices, charges,
  balances, payments, refunds and the money reports (revenue, outstanding)
  are removed from this phase and come back later as their own, separately
  specified feature. Nothing in this page stores or shows money.

These earlier decisions still apply: one school per user
(multi-school-users.md), **no attendance tracking**
(`docs/design/lessons.md` §1), `TeacherNote`s never reach students, every
tenant table has `school_id`, and every UI string goes through next-intl.

Terms are used as in [phase5-rules.md](phase5-rules.md) and
[replacements.md](replacements.md):

- _now_ is the server time of the request.
- A lesson _has ended_ when `endsAt ≤ now`.
- The **effective teacher** is `substituteTeacherId ?? teacherId`; the
  **regular teacher** is `teacherId`.
- A **local date** is a date in `School.timezone`.
- A student is a **member** of group _g_ at instant _t_ when
  `isMemberAt(memberships, g, t)` holds (`src/server/timetable/week.ts`, the
  same rule ratings use).
- A **makeup** is a lesson a student gets in return for a missed one: a
  replacement booking into another group's lesson (replacements.md §6), or
  a credit-backed rescheduled 1-on-1 (replacements.md §7). §3.2 defines it
  exactly.

## 1. Where things live

| Path                                   | What                                                                                                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/reports/rules.ts`          | Pure: `isMakeupLesson`, `expectedFor`, `attendanceReport`, `teacherHoursReport`, `teacherHoursLessons`, `roundHalfUpDiv`, `minutesToHours` (§3, §4). Built on `teachingMinutes` |
| `src/server/reports/csv.ts`            | Pure `toCsv(columns, rows, messages)` with RFC 4180 quoting and the formula-injection guard (§5)                                                                                 |
| `src/server/reports/admin.ts`          | `loadReport(report, input)`: loads the rows and calls the pure builders. Admin only (§6). The page and the CSV route call this same function                                     |
| `src/app/api/admin/reports/[report]/…` | `GET …/<report>.csv`, admin only, same zod input and same loader as the page (§5)                                                                                                |
| `messages/en-GB/reports.json`          | `reports.*` (copy from the design spec §5), including `reports.csv.<report>.<column>` and the error codes                                                                        |

The pure files follow the scheduling module's contract. Inputs are plain
data and output is deterministic and sorted. There is no `Date.now()`, no
`Math.random()` and no floating-point arithmetic for counts, rates or hours:
the service passes `now` and the school's time zone. Every rule has a unit
test.

## 2. Common rules

- **Admin only, own school only** (§6). The page and the CSV call the same
  `loadReport(report, input)`.
- **Input** (zod): `report`, either `termId` (which sets `from` / `to` to
  the term's dates) or `from` / `to` (local dates, inclusive), plus the
  filters of §3 and §4. The page defaults to the current term. Lessons are
  selected by `startsAt ∈ [from 00:00, to + 1 00:00)` in the school's time
  zone, in published terms only.
- **Limits.**
  - The range covers at most `REPORT_MAX_RANGE_DAYS` (366) days, counted
    inclusively (`to − from + 1 ≤ 366`); otherwise `RANGE_TOO_LONG`.
  - `from ≤ to`; otherwise `INVALID_RANGE`.
  - A CSV with more than `REPORT_MAX_ROWS` (50,000) data rows is refused
    with `TOO_MANY_ROWS` and the row count, so the admin narrows the
    filters. A CSV is never silently truncated.
  - The page shows 50 rows per page (keyset on the sort key), with totals
    computed over all rows.
- **Ended lessons only.** Both reports count lessons with `endsAt ≤ now`.
  A range that reaches past today shows the lessons that have happened so
  far (`untilToday: true` in the result; the UI says "until today").
- **Current state.** Reports read the data as it is now. A later correction
  (a substitute recorded after the fact, an absence deleted by an admin)
  changes past figures. The result carries `asOf = now` for the "Data as
  of" footnote. There is no period closing.
- **Filter ids** (teacher, group, student, term) are looked up through
  `getSchoolScopedDb()`. Another school's id gives `NOT_FOUND`. Archived
  teachers, groups and students are valid filter values.
- **No term yet.** With no term in the school, `loadReport` returns
  `NO_TERM` (the spec's "Add a term first" state).

## 3. Attendance

### 3.1 What it is built from

There is no attendance record (owner decision), so "attended" means the
same as in ratings (phase5-rules.md §4.1): the student was **expected** at
the lesson and didn't report an absence for it. A student who simply
doesn't turn up without cancelling still counts as attended. The report
says so in its caption ("Based on reported absences. Attendance is not
taken in class.").

### 3.2 Expected lessons

For student _s_ and lesson _L_ of group _g_, `expectedFor(s, L)` holds when
**all** of the following are true:

| #   | Condition                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------- |
| 1   | _L_ is in a published term (`Term.timetablePublishedAt` set)                                               |
| 2   | _s_ is a **member** of _g_ at `L.startsAt` (`isMemberAt`)                                                  |
| 3   | `L.status ≠ CANCELLED`, **or** `L.cancelReason = STUDENT_CANCELLED` and _s_ has an `AbsenceReport` on _L_ |
| 4   | _L_ is not a makeup: `isMakeupLesson(L) = false`                                                           |

Rule 3 keeps a 1-on-1 the student cancelled themselves (the lesson is
cancelled so the teacher is free, replacements.md §3) as expected-and-absent,
not as "cancelled by the school".

`isMakeupLesson(L)` is pure and follows the reschedule chain (replacements.md
§7). With `P` = the lesson that `L.rescheduledFromId` points to:

- `L.rescheduledFromId` is null → **false**. This covers regular and ad-hoc
  lessons.
- `P.cancelReason = STUDENT_CANCELLED` → **true**. _L_ was bought with the
  credit the student earned by cancelling `P`. This includes the admin's
  _Book 1-on-1 with credit…_, whose chain starts at the credit's
  `STUDENT_CANCELLED` lesson.
- `P.cancelReason = RESCHEDULED` → `isMakeupLesson(P)`. An admin move (no
  credit) is the same lesson at a new time, so _L_ inherits _P_'s role.
- Anything else (the chain was rewritten by a slot split, replacements.md
  §5) → `isMakeupLesson(P)`.

The chain is followed on the loaded lessons. The unique `rescheduledFromId`
index and the `createdAt` order make it acyclic. The function stops after 50
steps with `CHAIN_TOO_LONG`, and a unit test asserts that this never
happens on the fixtures.

Case by case:

| Case                                                                                | Expected?                                                    | Absent?                |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------- |
| Group lesson, student comes (or doesn't turn up without cancelling)                 | Yes                                                          | No                     |
| Group lesson, absence before the cutoff (credit)                                    | Yes                                                          | Yes, with credit       |
| Group lesson, absence after the cutoff (no credit)                                  | Yes                                                          | Yes, late              |
| Replacement seat in another group's lesson                                          | No (not a member). Counts as a makeup attended (§3.3)        | —                      |
| 1-on-1 cancelled by the student before the cutoff (`STUDENT_CANCELLED`, credit)     | Yes (rule 3)                                                 | Yes, with credit       |
| 1-on-1 late cancel (stays `SCHEDULED`, absence, no credit)                          | Yes                                                          | Yes, late              |
| Credit-backed rescheduled 1-on-1                                                    | No (makeup). Counts as a makeup attended if it ran (§3.3)    | —                      |
| 1-on-1 moved by an admin (`RESCHEDULED` → new ad-hoc lesson)                        | The old lesson no, the new one yes. A moved makeup stays one | As for any lesson      |
| Lesson cancelled by the school (`HOLIDAY`, `TIMETABLE_CHANGED`, `SCHOOL_CANCELLED`) | No                                                           | —                      |
| Lesson with a substitute                                                            | Same as without one                                          | —                      |
| Student joined or left mid-term                                                     | Only lessons that start while they are a member              | —                      |
| Absence report deleted by an admin                                                  | Yes                                                          | No (current state, §2) |
| Lesson status `COMPLETED`                                                           | Treated like `SCHEDULED`                                     | —                      |

### 3.3 Columns

**Grain:** one row per (student, group) with at least one expected lesson,
or at least one makeup attended, in the range. Filters: `groupId?`,
`teacherId?` (the lesson's **effective** teacher), `studentId?`.

All counts are over **ended** lessons with `startsAt` in the range that pass
the filters:

| Column             | Definition                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expected`         | Lessons _L_ of the group with `expectedFor(s, L)`                                                                                                         |
| `absent`           | `expected` lessons with an `AbsenceReport` of _s_                                                                                                         |
| `absentWithCredit` | … of which the report has a `MakeupCredit` (in any state: available, used or expired)                                                                     |
| `absentLate`       | `absent − absentWithCredit`                                                                                                                               |
| `attended`         | `expected − absent`                                                                                                                                       |
| `attendanceRate`   | `roundHalfUpDiv(attended × 1000, expected)` tenths of a percent, i.e. a percentage with one decimal (`87.5`). Empty (`—` on the page) when `expected = 0` |
| `makeupsAttended`  | Ended, non-cancelled makeups _M_ that _s_ attended, **whose credit came from a lesson of this group** (below)                                              |

`makeupsAttended` counts, for student _s_:

- **replacements**: an active `ReplacementRequest` (`AUTO_APPROVED`,
  `APPROVED`, `OVERRIDDEN`) of _s_ whose target lesson _M_ has ended and is
  not cancelled; the row is the group of the booking's `originalLesson`;
- **rescheduled 1-on-1s**: a lesson _M_ with `isMakeupLesson(M)`, ended, not
  cancelled, in a 1-on-1 group where _s_ is the member at `M.startsAt`; the
  row is _M_'s group.

For makeups the range applies to `M.startsAt`. The `teacherId` filter
applies to _M_'s effective teacher (who taught the makeup), and the
`groupId` filter to the row's group.

`roundHalfUpDiv(a, b)` = ⌊(2a + b) / (2b)⌋ in integer arithmetic.

The totals (summary cards) are the column sums, and the overall rate is
computed from the summed `attended` and `expected`, not by averaging rates.
Sort order: group name, student name, then ids. The page also sorts by any
column (e.g. attendance ascending); ties fall back to this order.

Student, group and level names are read now (current names); archived
students and groups are listed with an `archived: true` flag.

## 4. Teacher hours

### 4.1 Summary

**Grain:** one row per teacher who taught at least one ended, non-cancelled
lesson in the range (as regular teacher or substitute). Filters:
`teacherId?`, `groupId?`.

With `ended` = the ended, non-cancelled lessons in the range (and in the
group, if filtered) and _t_ the teacher:

| Column                   | Definition                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `lessons`                | Number of `ended` lessons with effective teacher _t_                                                                        |
| `regularMinutes`         | `teachingMinutes(ended.filter(l => l.substituteTeacherId === null), t, range)`                                              |
| `substituteMinutes`      | `teachingMinutes(ended.filter(l => l.substituteTeacherId !== null), t, range)` (_t_ covering for someone else)              |
| `totalMinutes`           | `teachingMinutes(ended, t, range)` — the Phase 5 definition, unchanged (phase5-rules.md §3.4)                               |
| `hours`                  | `totalMinutes / 60` as a decimal string with 2 places (`minutesToHours`, rounded half up in integers): 750 → `12.50`        |
| `coveredByOthersMinutes` | Σ minutes of `ended` lessons where `teacherId = t` and someone else substituted. For information only, **not** in the total |

- **Substitute hours count for the substitute, not the regular teacher**
  (`teachingMinutes` uses the effective teacher). Invariants, unit- and
  property-tested: `totalMinutes = regularMinutes + substituteMinutes`, and
  Σ `totalMinutes` over all teachers equals Σ minutes of `ended`, so every
  lesson is counted exactly once.
- A teacher with only `coveredByOthersMinutes` in the range (all their
  lessons were covered) is not listed, as the spec says ("only teachers who
  taught in the period").
- Archived teachers are listed (`archived: true`); their past hours still
  count.
- Sort order: teacher name, then id. Summary cards: Σ `totalMinutes`,
  Σ `lessons`, Σ `substituteMinutes`.

### 4.2 Lesson detail

`teacherHoursLessons` (the per-teacher page with `teacherId` set, and the
`teacher-hours-lessons` export with or without it): one row per `ended`
lesson that passes the filters, sorted by `startsAt`, then id.

| Column           | Definition                                                      |
| ---------------- | --------------------------------------------------------------- |
| `date`           | Local date of `startsAt`                                        |
| `start` / `end`  | Local `HH:mm` of `startsAt` / `endsAt`                          |
| `minutes`        | `endsAt − startsAt` in minutes                                  |
| `teacher`        | Effective teacher                                               |
| `role`           | `REGULAR` (no substitute) or `SUBSTITUTE`                       |
| `regularTeacher` | `teacherId`'s name (the "Substitute for {teacher}" on the page) |
| `group`, `level` | Group name and level code                                       |
| `room`           | Room name, empty when none                                      |
| `lessonId`       | The lesson id (CSV only)                                        |

With `teacherId` set, the rows are the lessons whose **effective** teacher is
that teacher (the same set the summary row counts). This is the export that
can hit the row limit.

## 5. CSV export

- **Route:** `GET /api/admin/reports/<report>.csv?<same query as the page>`,
  where `<report>` ∈ `attendance`, `teacher-hours`, `teacher-hours-lessons`.
  Each request runs `requireRole("ADMIN")` and `getSchoolScopedDb()` and
  parses its input with the page's zod schema. Another school's ids in the
  filters give **404**, a teacher or student gets **403**, and a signed-out
  request gets **401**. A `RANGE_TOO_LONG`, `INVALID_RANGE` or
  `TOO_MANY_ROWS` answers **422** with `{ code, count? }` as JSON, so the
  page can show the spec's alert; nothing is downloaded.
- **Headers:** `Content-Type: text/csv; charset=utf-8`,
  `Content-Disposition: attachment; filename="<report>_<from>_<to>.csv"`,
  `Cache-Control: no-store`.
- **Body:** UTF-8 **with BOM** (so Excel reads it as UTF-8), comma
  separator, CRLF line endings, RFC 4180 quoting (quote fields that contain
  `,`, `"`, CR or LF, and double the quotes).
- **Header row** in the user's locale via next-intl
  (`reports.csv.<report>.<column>`). The column **order** is fixed and
  covered by a snapshot test:

  | Report                  | Columns                                                                                                                              |
  | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
  | `attendance`            | `student`, `group`, `level`, `expected`, `absent`, `absentWithCredit`, `absentLate`, `attended`, `attendanceRate`, `makeupsAttended` |
  | `teacher-hours`         | `teacher`, `lessons`, `regularMinutes`, `substituteMinutes`, `totalMinutes`, `hours`, `coveredByOthersMinutes`                       |
  | `teacher-hours-lessons` | `date`, `start`, `end`, `minutes`, `teacher`, `role`, `regularTeacher`, `group`, `level`, `room`, `lessonId`                         |

- **Values are machine-readable, not localised.** Dates are `YYYY-MM-DD`
  and times `HH:mm`, both in the school's time zone. Minutes are integers,
  hours are decimals with a dot (`12.50`), percentages are `87.5` (empty
  when there is no rate), and enums are codes (`SUBSTITUTE`). Never
  "12 h 30 min" in the file.
- **Formula-injection guard:** every text cell starting with `=`, `+`, `-`,
  `@`, TAB or CR gets a leading `'`. Names are user input. Numeric columns
  are written by the writer itself and are never prefixed.
- No totals row (the page shows totals). An empty result is a header-only
  file.
- **Audit:** `report.exported` with `{ report, input, rows }`, in
  `AuditLog`. Viewing a page is not audited.

## 6. Permissions

| Action / data                            | Admin (own school) | Teacher | Student |
| ---------------------------------------- | ------------------ | ------- | ------- |
| Report pages (`/admin/reports/*`)        | ✓                  | ✗ (403) | ✗ (403) |
| CSV exports (`/api/admin/reports/*.csv`) | ✓                  | ✗ (403) | ✗ (403) |

- **Teachers see no report data**, not even their own hours (default, open
  question in the spec §8 Q2; allowing it later would be a separate,
  teacher-scoped loader, never this one).
- **Server-side enforcement:** every function in
  `src/server/reports/admin.ts` starts with `requireRole("ADMIN")` and uses
  `getSchoolScopedDb()`. **Import allow-list** (like ratings): only files
  under `src/app/admin/**`, `src/app/api/admin/reports/**` and
  `src/server/reports/**` may import `reports/admin.ts`. A unit test scans
  the rest of `src/` and fails if any other file does.
- Every request re-reads the `Membership` (as every request does) and
  validates its input with zod.
- Reports never contain `TeacherNote`s, absence reasons, ratings, lesson
  logs or anything about money.

## 7. Schema

**No schema changes.** Both reports read existing tables (`Lesson`,
`GroupMembership`, `AbsenceReport`, `MakeupCredit`, `ReplacementRequest`,
`TeacherProfile`, `Group`, `Level`, `Room`, `Term`) through indexes that
already exist:

| Query                                | Index                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------- |
| Lessons in a range                   | `lessons (school_id, starts_at)`; per group / teacher / substitute variants |
| Absences of the loaded lessons       | `absence_reports (lesson_id, student_id)` unique                            |
| Credits of those absences            | `makeup_credits (school_id, absence_report_id)` unique                      |
| Replacements into the loaded lessons | `replacement_requests (school_id, target_lesson_id)`                        |
| Memberships                          | `group_memberships (school_id, student_id)`, `(group_id, student_id)`       |

`report.exported` uses the existing `AuditLog`. If the db test below shows
a slow query, an index is added in CARM-73 with a note here.

## 8. Agreed with the design spec (CARM-70, `docs/design/reports.md` at `10ba8d4`)

| #   | Spec                                                                                       | Verdict                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Two reports, attendance and teacher hours; no money reports, no _Payments_ / _Parents_ nav | Confirmed                                                                                                                                                                       |
| R2  | Period = term or custom dates, inclusive, school time zone, default current term           | Confirmed (§2)                                                                                                                                                                  |
| R3  | 366 days, 50,000 rows, "until today", "as of", "figures reflect later corrections"         | Confirmed (§2). The 366 days are counted inclusively                                                                                                                            |
| R4  | Attendance columns, "attended = expected − absent", makeups with this group's credits      | Confirmed (§3). Credit-earning 1-on-1 cancellations are expected-and-absent; the teacher filter applies to a makeup's own teacher                                               |
| R5  | Teacher hours columns, covered by others not in the total, only teachers who taught listed | Confirmed (§4.1)                                                                                                                                                                |
| R6  | Per-teacher page and _Lesson details_ export                                               | Confirmed (§4.2): rows are the lessons whose effective teacher is that teacher                                                                                                  |
| R7  | CSV format and file name                                                                   | Confirmed (§5). The guard also covers TAB and CR; the attendance and summary column lists above are the `reports.csv.<report>.<column>` keys. Range and row errors answer 422 |
| R8  | 403 for teacher / student, 401 signed out, 404 for another school's ids                    | Confirmed (§5, §6)                                                                                                                                                              |

Open in the spec (owner): Q1 keep the attendance report (default: keep; if
dropped, §3 and the `attendance` export are removed, nothing else changes);
Q2 teachers see their own hours (default: no, §6).

## 9. Tests CARM-73 must add

Unit (pure, no database):

- `reports/rules.test.ts`:
  - every row of the §3.2 table; `isMakeupLesson` over student reschedules,
    re-reschedules, admin reschedules of regular lessons and of makeups,
    _Book with credit_, and slot-split successors;
  - each attendance column, the rate rounding at exact halves and with
    `expected = 0`, makeups from replacements and from 1-on-1 reschedules,
    each filter (including the teacher filter on makeups);
  - teacher hours: each column, a covered lesson counted for the substitute
    only, a teacher with only covered lessons not listed,
    `minutesToHours` rounding, `regular + substitute = total`;
  - ended-only and the range boundaries in the school's time zone (DST
    days), `RANGE_TOO_LONG` at 366 / 367 days, `INVALID_RANGE`,
    `TOO_MANY_ROWS` at 50,000 / 50,001 rows;
  - sort order and output independent of input order.
- `reports/rules.property.test.ts` on the realistic fixtures (20 teachers,
  60 groups, 15 rooms; seeded, with absences, replacements, reschedules,
  substitutes and membership changes): `totalMinutes` equals
  `teachingMinutes` per teacher, Σ over teachers equals Σ lesson minutes;
  `attended + absent = expected` per row; no makeup is ever expected; the
  attendance report's `attended` for a (student, teacher, term) agrees with
  `attendedLessons` from `ratings/rules.ts` restricted to member lessons
  that are not makeups.
- `reports/csv.test.ts`: quoting, CRLF, BOM, the formula guard (numeric
  columns never prefixed), a header-only empty result, the column order
  snapshot per report, and parsing the output back with a CSV parser.
- The import allow-list test (§6).

Database (`*.db.test.ts`, cleanup scoped to the spec's own `suffix`): the
page loader and the CSV route return the same rows for the same input; a
filter id of school B from school A's admin gives `NOT_FOUND`; school B's
lessons never appear in school A's report; `report.exported` is written
once per export; a full-term report on the fixtures loads in under 2 s.

The e2e permission cases (pages and exports, teacher / student / other
school) are CARM-74's scope.
