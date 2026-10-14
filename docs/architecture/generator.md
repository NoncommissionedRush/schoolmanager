# Timetable generator: assign teachers (rules, CARM-53, revised CARM-58)

**Status: Phase 4, proposed. Nothing here is implemented yet.** Stage 2
(CARM-55) builds the schema, the engine and the service from this page;
stage 3 (CARM-56) the admin screens. The screens are specified in
`docs/design/timetable-generator.md` (CARM-54); §9 lists how the two fit.
Where they still disagree, raise it on the issue rather than picking one.

> **Revised for the owner's model (CARM-54, 2026-10-14).** The first
> version of this page (PR #29) had the generator choose days, times, rooms
> and teachers from per-term demand rows. The owner replaced that:
>
> 1. Every group has fixed **lesson times and a room**, set on the group and
>    kept from term to term.
> 2. The generator only **assigns one teacher per group** for the term. The
>    teacher must teach the group's level and be free at all of its times.
> 3. When several teachers fit, it prefers an **even workload**.
> 4. It no longer chooses days, times or rooms.
>
> Demand rows, placing times, pins and time-based preferences are gone.
> The draft, apply and preview, the published-term modes and concurrency
> carry over, with "assignment" in place of "slot".

The generator proposes a **teacher for each group** of a term. It writes a
**draft** the admin reviews, edits and locks, then applies through the same
checks and lesson generation the manual editor uses
([scheduling.md](scheduling.md)). Applying creates one `TimetableSlot` per
group lesson time with the assigned teacher. The generator never creates
`Lesson`s directly.

Owner decisions this builds on (2026-10-13 project brief, CARM-38 Phase 4
breakdown and CARM-54 model, both 2026-10-14):

- Timetable = recurring `TimetableSlot` templates; dated `Lesson`s are
  generated per term from them.
- Group lessons and 1-on-1 lessons (a 1-on-1 is a group of one with its own
  lesson times and level).
- Start in TypeScript; propose an OR-Tools CP-SAT sidecar only with evidence
  that TypeScript is not enough.
- The draft never touches the live timetable until the admin publishes it,
  and publishing goes through the existing `publishTerm` checks.
- No deployment target yet; everything must run locally.

Terms used below:

- A group's **times** are the weekly lessons the run must staff (§2.4):
  usually its `GroupLessonTime`s.
- An **assignment** is a group's teacher in the draft, or "no teacher".
- **Eligible**: a teacher who may get the group from the generator (§3.1).
- The **fixed context** is everything the generator may not change: other
  terms, lessons, the live slots it keeps, and locked assignments.

## 1. Where things live

| Path                                        | What                                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/server/scheduling/generator/`          | Pure engine: no Prisma, no Next.js; deterministic; unit- and property-tested                 |
| `· types.ts`                                | `GeneratorInput` (scheduling context, groups with times, teachers, draft), `GeneratorResult` |
| `· readiness.ts`                            | Which groups can be staffed and why not; the readiness checks of the Groups tab (§2.5)       |
| `· eligibility.ts`                          | Per group and teacher: eligible, or the reasons not (§3.1), via `checkSlot`                  |
| `· score.ts`                                | The objective (§3.3), full and incremental                                                   |
| `· assign.ts`                               | Construction with repair, then improvement (§4.2)                                            |
| `· explain.ts`                              | Per-teacher reasons and suggestions for groups without a teacher (§4.5)                      |
| `· generate.ts`                             | `assignTeachers(input)` and the step-wise `assignTeachersSteps(input)` (§4.6)                |
| `src/server/scheduling/lesson-sync.ts`      | New `planSlotTeacherChange` (§5.6)                                                           |
| `src/server/timetable/generator-service.ts` | Database service: readiness, drafts, runs, apply. One transaction per action                 |
| `messages/en-GB/scheduling.json`            | New `generator.reasons.<CODE>`, `generator.teacherReasons.<CODE>`, `generator.errors.<CODE>` |

The engine follows the scheduling module's contract: plain-data inputs,
sorted output, no `Date.now()` or `Math.random()`, every rule covered by a
test.

## 2. Inputs

### 2.1 Group lesson times and room

New table `GroupLessonTime`, one row per weekly lesson of a group. It
belongs to the **group**, not to a term, and applies to every term the
group runs in (owner decision 1).

| Field                      | Meaning                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `groupId`                  | The group.                                                                                           |
| `weekday`                  | ISO 1–7.                                                                                             |
| `startMinute`, `endMinute` | Local minutes since midnight, `start < end`, on the 5-minute grid (the form uses 15).                |
| `roomId`                   | Required (owner decision 2). Per row, so a group may use Room 3 on Tuesday and Online 1 on Thursday. |

- A group has 0–7 rows. Rows of one group must not overlap (service check,
  `LESSON_TIMES_OVERLAP`). A group with none is skipped (§2.5).
- **Saving a group never changes live slots** (UX spec Q2). The times are
  read the next time teachers are assigned. For the current term the admin
  edits the slots in the editor from a date, as today.
- The group form's live check uses `checkSlot` with the
  `UNASSIGNED_TEACHER` teacher (§4.3) against a context whose slots are the
  other groups' lesson times (one synthetic week) plus the live slots of
  current and future terms. Physical-room double booking blocks saving;
  student clashes, capacity, school days and hours are warnings, as in the
  editor.

### 2.2 Which levels a teacher teaches

New table `TeacherLevel` (teacher × level). The generator only gives a
teacher groups whose `Group.levelId` is in their list. The admin can still
pick anyone by hand (§5.3).

- The UX spec's tick boxes with an "Up to…" shortcut (its Q1) write one row
  per ticked level; "teaches up to X" is just a shortcut in the form. Both
  answers to Q1 fit this table.
- A teacher with no rows is never assigned by the generator; readiness
  lists them.
- Archived levels keep their rows (groups of an archived level still need
  teachers until archived themselves).

### 2.3 Maximum hours a week

`TeacherProfile.maxMinutesPerWeek Int?`, shown as hours in the UI. Null =
no limit. It is **hard** for the generator (§3.1) and a warning for manual
choices (§5.3).

What counts toward it: the weekly minutes of the teacher's lessons **in
this term** from the run's start date (term start, or _D_ in the published
modes): kept live slots of the term in effect then, locked assignments and
the draft's assignments. Lessons in other, overlapping terms block time
(§3.1) but do not count toward the maximum (open question 1).

### 2.4 Which times a group needs staffed in a run

| Term state and mode (§5.2)         | A group's times                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Not published (**REPLACE**)        | Its `GroupLessonTime`s, from term start to term end. Applying replaces the editor's slots of the term. |
| Published, group has live slots    | Its live slots in effect on or after _D_, with their own times and rooms, from _D_                     |
| Published, group has no live slots | Its `GroupLessonTime`s, from _D_ to term end                                                           |

So in a published term the generator **never moves an existing lesson**;
if a group's lesson times were edited, the live slots keep the old times
until the admin changes them in the editor (UX spec §12, last edge case).

Each time becomes a `SlotInfo` (`validFrom` = _D_ or null, `validUntil` =
the live slot's or null) for `checkSlot`.

### 2.5 Readiness: which groups take part

Every non-archived group of the school is classified before a run
(`readiness.ts`). The Groups tab shows the same result without running
anything (`checkReadiness(termId)`).

| Status            | When                                                                                                                                                                                   | In the run?                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `SKIPPED`         | A `GroupTermSkip` row exists for this term ("Skip this term")                                                                                                                          | No                                          |
| `NO_LESSON_TIMES` | §2.4 gives it no times                                                                                                                                                                 | No                                          |
| `NO_ROOM`         | A lesson time's room is archived (a live slot already in an archived room is fine, as in the editor)                                                                                   | No                                          |
| `TIMES_CLASH`     | One of its times has a **blocking** conflict that no teacher can fix: `ROOM_DOUBLE_BOOKED`, `GROUP_DOUBLE_BOOKED`, `OUTSIDE_TERM`, `INVALID_TIME`. Both groups of a room clash get it. | No                                          |
| `LEVEL_UNCOVERED` | No non-archived teacher teaches the group's level                                                                                                                                      | Yes: ends with "no teacher" and that reason |
| `READY`           | Otherwise                                                                                                                                                                              | Yes                                         |

Time conflicts come from `checkSlot` with `UNASSIGNED_TEACHER` (§4.3)
against the fixed context **plus the other included groups' times**.
Overridable time conflicts (`STUDENT_DOUBLE_BOOKED`,
`ROOM_CAPACITY_EXCEEDED`, `ONLINE_ROOM_SHARED`, `OUTSIDE_SCHOOL_DAYS`,
`OUTSIDE_SCHOOL_HOURS`, `NO_OCCURRENCES`, `GROUP_OVER_CAPACITY`,
`ONE_ON_ONE_STUDENT_COUNT`) do not exclude a group: they are warnings on
its rows in the draft and are acknowledged on apply, as in the editor.

**Readiness checks** (the UX spec's card, §6.2 there), all from data the
run uses:

| Check              | Rule                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `noTimes`          | Groups with `NO_LESSON_TIMES` or `NO_ROOM`                                                                                                                                                                                                                                                                                                                                                                    |
| `roomClash`        | Pairs of groups with `TIMES_CLASH` on a room                                                                                                                                                                                                                                                                                                                                                                  |
| `levelUncovered`   | Levels of included groups with no teacher                                                                                                                                                                                                                                                                                                                                                                     |
| `timeCrunch`       | At each weekday and minute where an included time starts, let _S_ be the included groups with a time covering it. For _S_ and for each one-level subset of _S_: if \|_S_\| > the number of teachers eligible (§3.1, ignoring draft lessons and max hours) for at least one group of _S_, warn with the counts and levels. A necessary condition only (Hall): no warning does not guarantee a full assignment. |
| `teachersNoLevels` | Non-archived teachers without `TeacherLevel` rows                                                                                                                                                                                                                                                                                                                                                             |
| `hours`            | Weekly minutes the included groups need vs what the pool can give: Σ `maxMinutesPerWeek`, or for teachers without one, the minutes of the school day window on teaching weekdays minus their weekly unavailability                                                                                                                                                                                            |
| `studentClash`     | Included groups whose times have `STUDENT_DOUBLE_BOOKED`                                                                                                                                                                                                                                                                                                                                                      |

## 3. Rules

### 3.1 Hard: who is eligible

A teacher _t_ is **eligible** for group _g_ when all of these hold:

1. _t_ is not archived (`User.deletedAt` null).
2. _t_ teaches _g_'s level (`TeacherLevel`).
3. At **every** time of _g_, `checkSlot` with teacher _t_ against the fixed
   context reports none of `TEACHER_DOUBLE_BOOKED`,
   `TEACHER_UNAVAILABLE_WEEKLY`. This covers other lessons and slots (also
   substitutions, moved lessons, overlapping terms) and weekly
   unavailability, through the existing checks (§4.3).
4. _t_ is not already teaching another group of the draft at an overlapping
   time (§4.2, the overlap graph).
5. _t_'s weekly minutes (§2.3) with _g_ stay ≤ `maxMinutesPerWeek`.

1–3 are static for a run; 4–5 depend on the other assignments.

Unchanged from the first version:

- **Weekly unavailability is hard.** In the editor it is overridable
  because the admin may have agreed an exception with the teacher; the
  generator cannot know that. The admin can still pick that teacher by hand
  (§5.3) and acknowledge the warning when applying.
- A `DATE_AVAILABLE` exception lifts a weekly rule for one date only, so it
  never makes a weekly lesson possible; `checkSlot` already reports the
  remaining dates.
- **One-off unavailability is not a rule.** A teacher away on one Tuesday
  must not lose every Tuesday group; that date is a substitute's job
  (Phase 5). `TEACHER_UNAVAILABLE_ON_DATE` is kept as a warning on the
  assignment and acknowledged on apply. It does not affect the choice.

### 3.2 Conflicts the generator never produces

`GENERATOR_HARD_CONFLICTS` = `TEACHER_DOUBLE_BOOKED`,
`TEACHER_UNAVAILABLE_WEEKLY`, `TEACHER_LEVEL_NOT_TAUGHT` (new, §4.3), plus
the aggregate `OVER_MAX_HOURS` (§3.1 rule 5, checked by the engine, not by
`checkSlot`). The engine's verification (§4.2 step 6) and the tests use
this constant. All other conflicts are properties of the group's times,
not of the teacher: readiness reports them (§2.5).

### 3.3 Objective and score

The engine compares two complete drafts by these keys, in order (smaller
wins; all integers, so results are exactly reproducible):

| #   | Key                 | Meaning                                                                                                                                |
| --- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `unassignedGroups`  | Included groups without a teacher                                                                                                      |
| 2   | `unassignedMinutes` | Their weekly minutes (prefers staffing groups with more lessons)                                                                       |
| 3   | `changedTeachers`   | **REPLAN_FROM only** (§5.2): groups whose teacher differs from the live one. "Current teachers are kept where possible" (UX spec §6.3) |
| 4   | `workloadPenalty`   | Σ over the pool of _m_ₜ², _m_ₜ = teacher _t_'s weekly minutes (§2.3)                                                                   |
| 5   | `workloadRange`     | max _m_ₜ − min _m_ₜ over the pool                                                                                                      |

**Even workload is the only preference** (owner decision 3). Keys 1–3 are
not preferences: 1–2 say "staff as many groups as possible", 3 is what the
REPLAN_FROM mode means (move as few teachers as possible in a published
term).

**The pool** is the non-archived teachers eligible by rules 1–3 for at
least one included group. Teachers who could never get a group (no
matching level, or never free) are left out, so they don't pull the
minimum to 0.

**Why the sum of squares.** With keys 1–2 tied the total minutes are fixed,
and then Σ _m_ₜ² is minimal exactly when the minutes are as even as
possible (it is the variance up to a constant). It changes with every move,
so the search can follow it; the range only looks at two teachers and is
flat for most moves, so it is only the tie-breaker. A teacher at their
`maxMinutesPerWeek` simply stays there; the others even out around them.

**What the admin sees** (no penalty numbers): the workload range in hours
("5–9 h a week"), the average over the pool, and the change since the
previous run ("range was 4–10 h"). Per teacher: minutes, groups, teaching
days, max. The draft stores `{ unassignedGroups, unassignedMinutes,
changedTeachers, workloadPenalty, workloadRange, minMinutes, maxMinutes,
averageMinutes, perTeacher[] }` after construction and at the end, plus the
previous run's range.

## 4. Algorithm

### 4.1 Choice: greedy construction with repair, then local improvement, in TypeScript

The problem is now an assignment, not a placement: about **60 groups × 20
teachers** on the realistic dataset (perhaps 300 × 60 in a large school),
with one choice per group. Each group has a handful of eligible teachers
after rules 1–3, two groups conflict only if their times overlap, and the
only other coupling is the weekly maximum.

It is still NP-hard in general (it contains list colouring of an interval
graph with capacities), but the instances are small and loose, and the
first version's measurements (Node 23, Apple Silicon) bound the cost:
`buildCalendar` ~1 ms, `checkSlot` 35–90 µs. Eligibility needs one
`checkSlot` per distinct time and teacher of the level: at most ~120 × 20 =
2 400 checks ≈ 0.2 s, usually far fewer because groups share times. The
search itself never calls `checkSlot`.

Why not a CP/ILP solver now: the same reasons as before, only stronger. A
solver's strength is tight instances; ours are loose. OR-Tools has no
maintained JavaScript binding, so CP-SAT means a Python sidecar, a second
runtime in docker compose and the rules written twice. A TypeScript engine
runs in Vitest next to the checker and stays deterministic.

**When to propose CP-SAT** (measured by the stage 2 tests, §6): the engine
assigns fewer groups than the exhaustive oracle on more than 1 % of small
instances, or its workload penalty exceeds the oracle's by more than 10 %
on more than 5 % of them, or it misses the time target. Then the sidecar is
proposed with those numbers, with `checkSlot` still verifying its output.

No new runtime dependency is needed.

### 4.2 Pipeline

1. **Snapshot.** The service loads the scheduling context of the term and
   every overlapping term (as `loadContext` does), groups with levels,
   members, lesson times and skip flags, teachers with levels, max minutes
   and archived flag, the live slots of the term, and the draft's locked
   assignments. All arrays are sorted by id before use, so input order
   never matters.
2. **Readiness** (§2.5) decides the included groups and their times.
   **Fixed context**: the scheduling context, minus this term's live slots
   in REPLACE, minus the reconsidered groups' slots from _D_ in REPLAN_FROM,
   so a group is never compared with its own current lessons. Locked
   assignments are not added to the calendar; they are pre-set in the
   engine (step 4) so the overlap graph covers them.
3. **Eligibility** (`eligibility.ts`). For each included group and each
   non-archived teacher of its level, run `checkSlot` per time (cached per
   distinct time and teacher) and keep the teacher-typed conflicts. Result:
   the static eligible set _E_(_g_), and for every non-eligible teacher the
   reasons (§4.5). Teacher-independent conflicts come from the
   `UNASSIGNED_TEACHER` check of step 2.
   **Overlap graph**: groups _g_, _h_ overlap if some time of _g_ and some
   time of _h_ share a weekday, their minute intervals intersect and their
   date ranges intersect. All draft times run from the same start date, so
   this is exact; a property test compares it with `checkSlot` (§6.3).
4. **Construction** (`assign.ts`). Locked assignments first, as given (even
   if they now break a rule; their conflicts are shown, §5.3). In
   REPLAN_FROM, each unlocked group starts with its current teacher if that
   teacher is still eligible. Then the remaining groups by fewest eligible
   teachers, then most weekly minutes, then group id. Each takes the
   eligible teacher, free by rules 4–5, with the smallest increase of the
   objective (ties: teacher id). If none is free, **repair**: search an
   ejection chain, i.e. give the group to teacher _t_ and move _t_'s
   overlapping unlocked group(s) to another free teacher, recursively,
   depth ≤ 3 and ≤ 2 000 nodes per group, in a fixed order; on failure undo
   and leave the group without a teacher.
5. **Improvement.** Deterministic first-improvement descent over three
   moves, in canonical order (groups by id, then teachers by id):
   **relocate** a group to another free eligible teacher; **swap** the
   teachers of two groups when both stay eligible; **insert** a group
   without a teacher with the repair of step 4. A move is taken when it
   improves the objective (§3.3) lexicographically; passes repeat until one
   makes no move or the budget (§4.4) is used. Only unlocked groups move.
   Deltas are O(1) for the workload keys (two teachers change).
   There is no randomness, so no seed. If the CP-SAT gate's numbers show
   the descent sticking in poor local optima, a seeded perturbation can be
   added without changing the contract.
6. **Verify.** Build one calendar from the fixed context plus every draft
   time with its assigned teacher; run `checkSlot` on each, and re-sum the
   weekly minutes. A `GENERATOR_HARD_CONFLICTS` conflict on a **generated**
   assignment is an engine bug: the group loses its teacher with
   `INTERNAL_CHECK_FAILED` (and the tests fail on it). On locked and
   imported assignments these conflicts are kept and shown. Overridable
   conflicts (one-off unavailability, the time warnings of §2.5) are stored
   per group so the review shows them like the editor does.
7. **Explain** every group without a teacher (§4.5).

### 4.3 Reusing the checker instead of duplicating rules

Small changes to `src/server/scheduling/`, no behaviour change for
existing callers:

- **`UNASSIGNED_TEACHER`**: an exported sentinel teacher id. `checkSlot` /
  `checkLesson` with it skip the teacher rules and return only the
  teacher-independent conflicts (readiness, the group form's live check).
- **`TEACHER_LEVEL_NOT_TAUGHT`** (overridable, new): the slot's or lesson's
  teacher has `TeacherLevel` rows but none for the group's level. Needs
  `GroupInfo.levelId` and an optional `SchedulingContext.teacherLevels`
  (`{ teacherId, levelId }[]`); without it the check is skipped, so old
  fixtures still pass. `loadContext` loads them, so the **editor warns
  too** (UX spec §10). A teacher with no rows at all gets no warning (the
  school may not use levels yet). Message params: `teacher`, `level`.
- **`planSlotTeacherChange`** (§5.6).

What the engine still owns: the overlap graph (an interval test, verified
against `checkSlot` in step 6 and by property 2), the weekly-minutes sum
for the maximum, and the objective. Apply re-checks everything with
`checkTimetable` / `checkLesson` under the timetable lock (§5.6), so even
an engine bug can never reach the live timetable.

### 4.4 Determinism and time budget

- Same input → the same draft, byte for byte, whatever the order of the
  input arrays. No seed: nothing is random.
- The budget is **iterations** (moves evaluated, `maxIterations`, default
  200 000), which is deterministic, plus a wall-time safety cap
  (`timeLimitMs`, default 10 s) for very large schools. No presets; the UX
  spec has none.
- A run ends by `stoppedBy`: `"converged"` (a pass without a move; normal),
  `"iterations"`, `"time"` (cap) or `"cancelled"` (nothing kept). The
  result records the iterations done; replaying with `maxIterations` =
  that count gives the same draft, so a capped draft stays reproducible.
  Tests use iteration budgets only.
- The result records iterations, duration, `stoppedBy`, and the objective
  after construction and at the end.

### 4.5 Groups without a teacher: reasons per teacher

Each group without a teacher gets one **group reason** and, when teachers
teach its level, a **reason list per teacher**. Same shape as a
`Conflict`: code, ICU params (`scheduling.generator.reasons.<CODE>` /
`.teacherReasons.<CODE>`) and refs to link.

| Group reason            | When                                                                   |
| ----------------------- | ---------------------------------------------------------------------- |
| `LEVEL_UNCOVERED`       | No non-archived teacher teaches the level ("Nobody teaches {level}.")  |
| `NO_TEACHER_FITS`       | Teachers teach the level, none could take it; see the per-teacher list |
| `REMOVED_BY_ADMIN`      | The admin set "No teacher" and it is locked (§5.3)                     |
| `TIME_LIMIT`            | The time cap fired before construction reached the group               |
| `INTERNAL_CHECK_FAILED` | Step 6 found a generator-hard conflict (a bug; never expected)         |

Per teacher who teaches the level (archived ones too, last), **every**
reason that applies, in this order:

| Teacher reason       | When                                                              | Params                                                                             |
| -------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `ARCHIVED`           | Rule 1                                                            | —                                                                                  |
| `UNAVAILABLE_WEEKLY` | Rule 3, weekly unavailability, per affected time                  | `weekday`, `time` (the rule's window)                                              |
| `BUSY`               | Rule 3, a lesson or slot in the fixed context (incl. other terms) | `weekday`, `otherGroup`, `otherTime`, `dateCount`, `firstDate` (from the conflict) |
| `TEACHING_IN_DRAFT`  | Rule 4, another draft group this teacher has                      | `weekday`, `otherGroup`, `otherTime`, `locked` (yes/no)                            |
| `OVER_MAX_HOURS`     | Rule 5                                                            | `currentMinutes`, `withMinutes`, `maxMinutes`                                      |

The UI shows "Eva Simon ✗ Thu — unavailable (weekly, 16:00–20:00)" from
these, and the row's short note from the group reason plus counts ("All 4
B1 teachers busy or unavailable").

**Suggestions** (UX spec Q4, up to 3 per group, in this order). They point
at a decision or at data; applying one is an ordinary draft edit.

| Kind                 | When                                                                                                                                                                                                            | Action in the UI                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `SWAP`               | Teacher _t_ is blocked only by one other draft group _h_ (`TEACHING_IN_DRAFT`, locked or not), and another teacher is eligible and free for _h_ with _g_ given to _t_. Ranked by the resulting workload penalty | _Apply_: both changes, both locked         |
| `ONLY_UNAVAILABLE`   | Teacher blocked only by weekly unavailability                                                                                                                                                                   | _Pick anyway_ (warning) / _Availability_   |
| `ONLY_MAX_HOURS`     | Teacher blocked only by the maximum                                                                                                                                                                             | _Pick anyway_ (warning) / _Teacher_        |
| `NOT_TEACHING_LEVEL` | Non-archived teachers free at all of _g_'s times (rules 3–5) who don't teach the level, up to 2                                                                                                                 | _Pick anyway_ (warning) / _Teacher levels_ |

A `SWAP` among unlocked groups only exists if the descent missed it,
because insert-with-repair tries exactly that; in practice swaps involve a
locked assignment, which only the admin may change.

### 4.6 Running inside the app

Kept from the first version, simplified. A run is a **`GeneratorRun`** row
(§8), one running per term (partial unique index), started by `startRun`
and executed on the server after the request returns, so the UX spec's
"{name} is assigning teachers" survives a reload and is visible to another
admin.

- **Executing.** `assignTeachersSteps(input)` is a generator function that
  yields every ~2 000 iterations; the service drives it with
  `await setImmediate` between steps so other requests keep being served.
  Its output equals the synchronous `assignTeachers` (tested).
- **Progress.** At most every 500 ms the runner writes `{ phase:
"checking" | "assigning" | "balancing", assigned, total, elapsedMs }` and
  `heartbeatAt`. The UI polls `getRun` every 1 s while its dialog is open
  (a normal run is done within it).
- **Cancel.** `cancelRun` sets `cancelRequested`; the runner checks it at
  each yield and saves nothing. There is no "stop and keep best": a run
  takes seconds.
- **Crashes.** No supervisor: if the Node process dies mid-run, the row
  stays `RUNNING` with a stale heartbeat. Any read that finds `heartbeatAt`
  older than 30 s marks it `FAILED` (`RUN_INTERRUPTED`) and frees the term;
  the previous draft is untouched.
- **Locking inputs.** While a run is running, edits to that term's draft
  are refused with `RUN_IN_PROGRESS`. Group, teacher and availability edits
  are **not** refused (a run takes seconds and they belong to other
  screens); a change made during the run makes the new draft stale at once
  (§5.5).
- **Saving.** On completion the runner saves the draft (§5.7) and marks the
  run `DONE`, or `FAILED` with an error code. Old runs are kept as the run
  history (they are small).

## 5. Draft lifecycle

### 5.1 Where a draft lives, and why not in `TimetableSlot`

A draft is a `TimetableDraft` (one per term) with one
`TimetableDraftAssignment` per included group: teacher (or none), locked,
origin. The draft's lessons are not stored: they are the group's times
(§2.4) × its assignment, computed when read.

It is not written as live slots for the same reasons as before: live slots
feed every overlapping term's checker, the editor, lesson generation and
teachers' and students' timetables; the admin's editor slots must survive
until the admin replaces them; discarding must leave no slot history; and
applying must be one atomic, audited step the existing checks guard.

Draft tables are read only by the generator service. No teacher or student
view, and no `loadContext` for the checker, ever reads them.

### 5.2 Starting a draft: modes

The term's state decides the modes the Assign dialog offers (UX spec §6.3):

| Term state                      | Mode (dialog option)                                | Behaviour                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Not published, no slots         | **REPLACE**                                         | Assign every included group from scratch.                                                                                                                                                                                                                                                                                                                                |
| Not published, has editor slots | **REPLACE**, _Keep current teachers_ (default)      | A group's **current teacher** (below) is imported as a locked `IMPORTED` assignment; the rest are assigned. Applying replaces the editor's slots with slots from the groups' lesson times.                                                                                                                                                                               |
| Not published, has editor slots | **REPLACE**, _Reassign everything_                  | Nothing imported; every included group is assigned from scratch. Applying replaces the editor's slots.                                                                                                                                                                                                                                                                   |
| Published (has lessons)         | **FILL**, _Only groups without a teacher_ (default) | From an **effective date** _D_. Groups with live slots in effect on or after _D_ are not in the draft; their slots stay as they are, are part of the fixed context and count toward their teachers' minutes. Only groups without live slots from _D_ (e.g. new groups) are assigned; their slots start on _D_.                                                           |
| Published (has lessons)         | **REPLAN_FROM**, _Reconsider every group_           | From _D_, every included group is in the draft. Groups with live slots start with their current teacher as an unlocked `IMPORTED` assignment; key 3 of the objective (§3.3) keeps it unless changing it staffs more groups. A group whose current teacher is no longer eligible keeps them if nobody else fits, with the conflict shown, rather than losing its lessons. |

**Current teacher** of a group: the teacher of its live slots in effect on
the run's start date when they all have the same one. If they differ, the
group has none (imported as nothing, with the warning `MIXED_TEACHERS`).

_D_ defaults to the next Monday on or after tomorrow, must be inside the
term and is never today or earlier, so today's lessons are never touched.

In FILL the kept live slots are not copied into the draft; they are read
live each time, so the draft cannot get out of step with them.

### 5.3 Editing and locking

- Each assignment has `teacherId` (null = no teacher), `locked` and
  `origin` (`GENERATED`, `MANUAL`, `IMPORTED`).
- The admin can pick any teacher, or "No teacher". The picker sections
  come from the same eligibility data (§4.5):

  | Section (UX spec §6.6) | Teachers                      | Saving                                                                                     |
  | ---------------------- | ----------------------------- | ------------------------------------------------------------------------------------------ |
  | Available              | Eligible and free (rules 1–5) | Allowed                                                                                    |
  | Unavailable            | Only `UNAVAILABLE_WEEKLY`     | Allowed; overridable conflict, acknowledged on apply                                       |
  | Doesn't teach {level}  | Free, level not in their list | Allowed; `TEACHER_LEVEL_NOT_TAUGHT`, acknowledged on apply                                 |
  | Over max hours         | Only `OVER_MAX_HOURS`         | Allowed; draft warning `OVER_MAX_HOURS`, acknowledged on apply                             |
  | Busy                   | `BUSY` or `TEACHING_IN_DRAFT` | **Refused** (`BLOCKING_CONFLICTS`): a teacher double booking is blocking, as in the editor |

  Archived teachers are not offered. Edits are checked with `checkSlot`
  for each of the group's times against the fixed context plus the other
  draft assignments.

- A changed assignment is locked automatically and becomes `MANUAL`; the
  admin can unlock it. "No teacher" chosen by hand is `MANUAL`, locked,
  reason `REMOVED_BY_ADMIN`.
- Locked assignments are fixed for the generator. A locked assignment that
  breaks a rule after data changed stays; its conflict is shown.
- `checkDraft` (UX spec _Check draft_) recomputes conflicts, warnings and
  reasons against current data without changing any assignment.

### 5.4 Reassigning the rest

"Reassign…" keeps locked assignments and assigns all unlocked groups again
from scratch (same inputs → same result). The draft's included groups are
refreshed first: newly ready groups are added, groups no longer included
are removed (a locked assignment of a group that became `SKIPPED` or lost
its times is removed too; the result lists it).

### 5.5 Staleness

When a run finishes, the draft stores a **fingerprint**: SHA-256 of the
canonical (sorted) generator input except the draft's own assignments:
included groups with level, members, times and rooms; skip flags; teachers
with levels, max minutes, archived flag and availability; the scheduling
context. Opening the draft recomputes it; if it differs, the draft is
**out of date** (UX spec §6.11). That is a warning, not a block: apply
re-checks everything.

### 5.6 Applying and publishing

`applyDraft(draftId, { version, acknowledgedConflictKeys, publish })`, in
one transaction holding the school's timetable advisory lock
(`lockTimetable`) and the draft row (`FOR UPDATE`, `version` must match):

1. Reload the context. In FILL and REPLAN_FROM, refuse with
   `EFFECTIVE_DATE_PASSED` if _D_ ≤ today. Refuse with `TEACHER_ARCHIVED`
   if an assignment's teacher is archived.
2. Build the would-be timetable.
   - REPLACE: the term's slots are exactly one slot per lesson time of each
     assigned group (`validFrom`/`validUntil` null).
   - FILL: the live slots plus, for each assigned group, a slot per lesson
     time from _D_.
   - REPLAN_FROM: as FILL for groups without live slots; for groups whose
     teacher changed, their live slots end on _D_ − 1 and copies with the
     new teacher start on _D_; for a group the admin set to "No teacher",
     its live slots end on _D_ − 1.
3. `checkTimetable` on it. Any **blocking** conflict refuses with the fresh
   list (`BLOCKING_CONFLICTS`). Every **overridable** conflict of a slot
   from the draft, and every `OVER_MAX_HOURS` warning, must be in
   `acknowledgedConflictKeys` (keys prefixed with the group id and lesson
   time; `maxHours:<teacherId>` for the maximum), else
   `UNACKNOWLEDGED_CONFLICTS`. A clash someone created meanwhile is never
   overridden blindly.
4. Write slots.
   - REPLACE (no lessons yet): delete the term's slots, create the new
     ones.
   - FILL: create the new slots from _D_; nothing else changes.
   - REPLAN_FROM: groups with an unchanged teacher: nothing. Groups with a
     changed teacher: `planSlotTeacherChange` per live slot (below).
     Groups set to "No teacher": the editor's **End** after _D_ − 1, with
     its lesson reconciliation (untouched lessons deleted, touched ones
     cancelled `TIMETABLE_CHANGED`). New groups: create from _D_.
5. Lessons. REPLACE with `publish: true`: the `publishTerm` logic in this
   transaction (split into `publishTermIn(tx, …)`; same checks, same
   `timetable.published` audit). REPLACE with `publish: false`: only the
   slots are written; the term stays a draft for the editor (UX spec "Save
   to the timetable editor only"). FILL and REPLAN_FROM: `planLessonSync`
   from _D_ for created slots, and the teacher-change plans.
6. Audit `timetable_draft.applied` (mode, _D_, counts of groups assigned /
   changed / unassigned, slots created / ended / deleted, lessons created /
   re-pointed / deleted / cancelled, overridden conflicts, workload range),
   then delete the draft. The response carries the same counts.

**Teacher-only change in a published term** (UX spec Q5, decided here).
When only the teacher of a live slot changes from _D_, nothing about the
lessons' time, room or students changes, so cancelling lessons with
history would be wrong. `planSlotTeacherChange(slot, newTeacherId, D)` (pure,
in `lesson-sync.ts`):

- splits the slot: the old one ends on _D_ − 1, a copy with the new teacher
  starts on _D_ (so past lessons keep pointing at the template they were
  made from, as `scheduling.md` requires);
- **re-points** every `SCHEDULED` lesson of the old slot on or after _D_ to
  the new slot and sets its `teacherId`, instead of deleting or cancelling
  it. Absences, replacement bookings, makeup credits and teacher notes stay
  on the same lesson row. A substitute stays (it was arranged for that
  date), unless the substitute is the new teacher, then it is cleared;
- lessons moved or re-roomed by hand keep their time and room and are
  checked with `checkLesson` for the new teacher in step 3 (blocking
  refuses, overridable must be acknowledged);
- creates any missing occurrences of the new slot (`planLessonSync`).

The editor keeps its current rule for slot edits; whether its teacher-only
edits should use the same plan is open question 3.

**Preview.** `previewApply(draftId)` runs steps 1–5 in a transaction that
is always rolled back and returns the counts plus the affected teachers,
students and replacement bookings: the UX spec's impact summary ("{moved}
future lessons get the new teacher; {cancelled} kept as cancelled…"). Apply
recomputes everything; the preview is information, not a reservation.

### 5.7 Concurrency

Unchanged from the first version:

- **A run does not hold the timetable lock.** It reads a snapshot, computes,
  then saves in a short transaction that locks the draft row and requires
  the `version` read at the start; otherwise the result is discarded with
  `DRAFT_CHANGED` and the UI offers to run again. Holding the school-wide
  lock would stall every booking and edit.
- **Draft edits** use the same `version` check (optimistic; the response
  carries the fresh draft on `DRAFT_CHANGED`).
- **Live changes during a draft's life** (editor, group times, levels,
  availability, holidays, absences) only make the draft out of date (§5.5).
  Apply takes the timetable lock and re-checks, so a draft can never
  double-book the live timetable.
- **Two drafts?** One per term (unique). Drafts of overlapping terms don't
  see each other; the second applied is checked against the first, as live
  data.

### 5.8 Discarding

`discardDraft` deletes the draft and its assignments (audited). Group times,
levels and skip flags stay.

## 6. Performance target and tests

### 6.1 Test data

`testing/realistic.ts` gets:

- six levels; each group gets one, and **lesson times** that are clash-free
  by construction (the existing greedy placement, 2 × 90 min per group, 1 ×
  60 min for 1-on-1s), with rooms;
- `TeacherLevel`: each teacher teaches 2–4 consecutive levels, always
  including the levels of the groups `groupTeacher` gives them, so the
  planted `groupTeacher` assignment is a full, valid assignment;
- `maxMinutesPerWeek` on a quarter of the teachers, at least their planted
  load;
- a `"tight"` variant: each teacher teaches only the levels of their
  planted groups, and extra weekly unavailability outside their planted
  times;
- a published variant with live slots and lessons (absences, a replacement
  booking, a substitute) for the published-term modes.

### 6.2 Performance target (stage 2 must report the numbers)

| Dataset (seeds 1–5) | Must                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| realistic           | 100 % assigned; workload range ≤ the planted assignment's; whole run (readiness to explain) ≤ 1 s |
| realistic, tight    | 100 % assigned on ≥ 4 of 5 seeds, ≥ 98 % on all; every group without a teacher explained; ≤ 1 s   |
| both                | Final objective ≤ construction objective; eligibility ≤ 0.3 s                                     |

On a dev laptop. CI machines are slower: the timed tests assert 3× these
limits and print the measured values.

### 6.3 Properties the engine must pass (fixed seeds)

1. **No generator-hard conflict:** every generated assignment's times pass
   `checkSlot` with none of `GENERATOR_HARD_CONFLICTS` against the fixed
   context plus all other draft times; every teacher's minutes ≤ their
   maximum; every generated teacher teaches the level.
2. **Overlap graph = checker:** for sampled pairs of groups (also with
   partial-range live slots, other terms, holidays, DST weeks), "overlap"
   equals "`checkSlot` reports `TEACHER_DOUBLE_BOOKED` when both have the
   same teacher".
3. **Eligibility = checker:** for every (group, teacher), eligible by rules
   1–3 exactly when the `checkSlot` calls report no teacher-hard conflict;
   `UNASSIGNED_TEACHER` checks return no teacher-typed conflict and the
   same other conflicts as any real teacher with no lessons or availability.
4. **Determinism:** same input → deep-equal result; shuffled input arrays →
   the same result; `assignTeachersSteps` = `assignTeachers`; a run capped
   after _k_ iterations equals a run with `maxIterations` = _k_.
5. **Locks:** with random subsets locked, locked assignments come out
   unchanged; with everything locked, the output is the input.
6. **Accounting:** assigned + without teacher = included groups; one
   teacher per group; skipped and not-ready groups never appear.
7. **Maximality:** no group without a teacher can be given any teacher by a
   single relocate or insert-with-depth-1-repair without breaking a hard
   rule, and its per-teacher reasons agree with a brute-force recount.
8. **Score:** incremental objective = from-scratch recomputation after every
   accepted move (checked every N moves in tests); with keys 1–3 tied, a
   relocate that lowers Σ _m_ₜ² is never available at the end.
9. **Small instances vs oracle:** on 200 random instances (≤ 8 groups, ≤ 4
   teachers, random levels, times, availability and maxima), an exhaustive
   oracle finds the lexicographic optimum; the engine matches its
   `unassignedGroups` on ≥ 99 % and is within 10 % of its workload penalty
   on ≥ 95 % (the CP-SAT gate, §4.1).
10. **Published modes:** new slots start on _D_; nothing before _D_
    changes; in FILL no live slot changes; in REPLAN_FROM with unchanged
    data the draft equals the live assignments (`changedTeachers` = 0),
    and a group whose current teacher becomes ineligible gets another one
    if any is eligible and keeps the current one otherwise.
11. **Teacher change:** `planSlotTeacherChange` re-points every scheduled
    lesson from _D_ (keeping absences, bookings, substitutes), deletes and
    cancels nothing, leaves lessons before _D_ alone, and is idempotent
    with `planLessonSync` afterwards.

DB tests (`generator-service.db.test.ts`, opt-in like the others): apply in
all three modes (and `previewApply` = what apply then does), refusal on a
clash created between generate and apply, a teacher change keeping a
lesson's absence and replacement booking, run lifecycle (one running run
per term, `RUN_IN_PROGRESS` on draft edits, cancel, a stale heartbeat
marked `FAILED`), `DRAFT_CHANGED` on concurrent edits,
`EFFECTIVE_DATE_PASSED`, `TEACHER_ARCHIVED`, skip flags, school scoping of
every action.

## 7. Service API and access

Every action: `requireRole("ADMIN")`, `getSchoolScopedDb()`, zod
validation, `SchedulingError` codes translated by
`scheduling.generator.errors.<code>`. Ids of another school are "not
found".

| Function                                  | Purpose                                                                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `checkReadiness`                          | Groups with status and the readiness checks (§2.5); no run                                                                             |
| `setGroupSkipped`                         | "Skip this term" / "Include" (`GroupTermSkip`)                                                                                         |
| `startRun`                                | Create the draft if needed (mode, _D_, keep / reassign from §5.2) and start a run (§4.6)                                               |
| `getRun` / `cancelRun`                    | Progress; cancel                                                                                                                       |
| `getDraft`                                | Assignments with conflicts and warnings, groups without a teacher with reasons and suggestions, workload, out-of-date flag, latest run |
| `teacherOptions`                          | The picker sections for one group (§5.3)                                                                                               |
| `saveAssignment` / `setAssignmentsLocked` | Change a teacher (or none); lock / unlock several, e.g. "Lock all of {teacher}"                                                        |
| `checkDraft`                              | §5.3                                                                                                                                   |
| `previewApply` / `applyDraft`             | §5.6                                                                                                                                   |
| `discardDraft`                            | §5.8                                                                                                                                   |

Group lesson times, teacher levels and max hours are saved by the existing
group and teacher actions (stage 3), with the same access rules.

Audit actions: `group.lesson_times_updated`, `teacher.levels_updated`,
`group_term_skip.created|deleted`, `generator_run.started|finished|cancelled|failed`
(assigned / without teacher, workload range), `timetable_draft.discarded`,
`timetable_draft.applied`, plus the existing `timetable.published`.
Assignment edits are not audited individually (nothing live changes); the
applied entry records the result.

Error codes the UI must handle: `RUN_IN_PROGRESS`, `RUN_INTERRUPTED`,
`DRAFT_CHANGED`, `BLOCKING_CONFLICTS`, `UNACKNOWLEDGED_CONFLICTS`,
`EFFECTIVE_DATE_PASSED`, `TERM_PUBLISHED` (REPLACE requested on a published
term), `TEACHER_ARCHIVED`, `NOTHING_TO_ASSIGN` (no included group),
`LESSON_TIMES_OVERLAP`.

## 8. Schema changes

Proposed for the stage 2 migration. Every new table carries `school_id`,
`@@unique([schoolId, id])` and composite FKs, as the schema convention
requires.

```prisma
enum DraftMode {
  REPLACE
  FILL
  REPLAN_FROM
}

enum DraftAssignmentOrigin {
  GENERATED
  MANUAL
  IMPORTED
}

enum GeneratorRunStatus {
  RUNNING
  DONE
  CANCELLED
  FAILED
}

model TeacherProfile {
  // … existing fields …
  /// Hard weekly maximum for the generator, a warning for manual choices; null = none.
  maxMinutesPerWeek Int?            @map("max_minutes_per_week")
  levels            TeacherLevel[]
}

model Group {
  // … existing fields …
  lessonTimes GroupLessonTime[]
  termSkips   GroupTermSkip[]
}

/// A group's regular weekly lesson; applies to every term the group runs in.
model GroupLessonTime {
  id          String   @id @default(uuid()) @db.Uuid
  schoolId    String   @map("school_id") @db.Uuid
  groupId     String   @map("group_id") @db.Uuid
  weekday     Int
  startMinute Int      @map("start_minute")
  endMinute   Int      @map("end_minute")
  roomId      String   @map("room_id") @db.Uuid
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  school School @relation(fields: [schoolId], references: [id], onDelete: Cascade)
  group  Group  @relation(fields: [schoolId, groupId], references: [schoolId, id], onDelete: Cascade)
  room   Room   @relation(fields: [schoolId, roomId], references: [schoolId, id], onDelete: Restrict)

  @@unique([schoolId, id])
  @@index([schoolId, groupId])
  @@index([schoolId, roomId, weekday])
  @@map("group_lesson_times")
}

/// A level the teacher may be given by the generator.
model TeacherLevel {
  id        String @id @default(uuid()) @db.Uuid
  schoolId  String @map("school_id") @db.Uuid
  teacherId String @map("teacher_id") @db.Uuid
  levelId   String @map("level_id") @db.Uuid

  school  School         @relation(fields: [schoolId], references: [id], onDelete: Cascade)
  teacher TeacherProfile @relation(fields: [schoolId, teacherId], references: [schoolId, id], onDelete: Cascade)
  level   Level          @relation(fields: [schoolId, levelId], references: [schoolId, id], onDelete: Restrict)

  @@unique([teacherId, levelId])
  @@unique([schoolId, id])
  @@index([schoolId, levelId])
  @@map("teacher_levels")
}

/// "Skip this term": the group takes no part in this term's assignment.
model GroupTermSkip {
  id          String   @id @default(uuid()) @db.Uuid
  schoolId    String   @map("school_id") @db.Uuid
  groupId     String   @map("group_id") @db.Uuid
  termId      String   @map("term_id") @db.Uuid
  createdById String?  @map("created_by_id") @db.Uuid
  createdAt   DateTime @default(now()) @map("created_at")

  school    School @relation(fields: [schoolId], references: [id], onDelete: Cascade)
  group     Group  @relation(fields: [schoolId, groupId], references: [schoolId, id], onDelete: Cascade)
  term      Term   @relation(fields: [schoolId, termId], references: [schoolId, id], onDelete: Cascade)
  createdBy User?  @relation(fields: [createdById], references: [id], onDelete: SetNull)

  @@unique([schoolId, groupId, termId])
  @@unique([schoolId, id])
  @@map("group_term_skips")
}

/// The generator's proposed teachers for a term (one per term).
/// Never read by timetable views or the conflict checker.
model TimetableDraft {
  id               String    @id @default(uuid()) @db.Uuid
  schoolId         String    @map("school_id") @db.Uuid
  termId           String    @map("term_id") @db.Uuid
  mode             DraftMode
  /// FILL and REPLAN_FROM: changes apply from this date.
  effectiveFrom    DateTime? @map("effective_from") @db.Date
  /// Optimistic concurrency for runs and edits.
  version          Int       @default(0)
  /// SHA-256 of the canonical generator input of the last run (out of date).
  inputFingerprint String?   @map("input_fingerprint")
  generatedAt      DateTime? @map("generated_at")
  /// Objective after construction and at the end, workload per teacher,
  /// previous run's range.
  summary          Json?
  /// Groups without a teacher: group reason, per-teacher reasons, suggestions.
  unassigned       Json      @default("[]")
  /// Overridable conflicts and warnings per group, from the last run or check.
  warnings         Json      @default("[]")
  /// iterations, durationMs, stoppedBy, budget.
  runStats         Json?     @map("run_stats")
  createdById      String?   @map("created_by_id") @db.Uuid
  createdAt        DateTime  @default(now()) @map("created_at")
  updatedAt        DateTime  @updatedAt @map("updated_at")

  school      School                     @relation(fields: [schoolId], references: [id], onDelete: Cascade)
  term        Term                       @relation(fields: [schoolId, termId], references: [schoolId, id], onDelete: Cascade)
  createdBy   User?                      @relation(fields: [createdById], references: [id], onDelete: SetNull)
  assignments TimetableDraftAssignment[]
  runs        GeneratorRun[]

  @@unique([schoolId, termId])
  @@unique([schoolId, id])
  @@map("timetable_drafts")
}

/// One included group's teacher in a draft.
model TimetableDraftAssignment {
  id        String                @id @default(uuid()) @db.Uuid
  schoolId  String                @map("school_id") @db.Uuid
  draftId   String                @map("draft_id") @db.Uuid
  groupId   String                @map("group_id") @db.Uuid
  /// Null = no teacher.
  teacherId String?               @map("teacher_id") @db.Uuid
  locked    Boolean               @default(false)
  origin    DraftAssignmentOrigin
  createdAt DateTime              @default(now()) @map("created_at")
  updatedAt DateTime              @updatedAt @map("updated_at")

  school  School          @relation(fields: [schoolId], references: [id], onDelete: Cascade)
  draft   TimetableDraft  @relation(fields: [schoolId, draftId], references: [schoolId, id], onDelete: Cascade)
  group   Group           @relation(fields: [schoolId, groupId], references: [schoolId, id], onDelete: Restrict)
  teacher TeacherProfile? @relation(fields: [schoolId, teacherId], references: [schoolId, id], onDelete: Restrict)

  @@unique([draftId, groupId])
  @@unique([schoolId, id])
  @@index([schoolId, teacherId])
  @@map("timetable_draft_assignments")
}

/// One generator run; progress while RUNNING, result summary after.
model GeneratorRun {
  id              String             @id @default(uuid()) @db.Uuid
  schoolId        String             @map("school_id") @db.Uuid
  termId          String             @map("term_id") @db.Uuid
  draftId         String             @map("draft_id") @db.Uuid
  status          GeneratorRunStatus @default(RUNNING)
  cancelRequested Boolean            @default(false) @map("cancel_requested")
  maxIterations   Int                @map("max_iterations")
  timeLimitMs     Int                @map("time_limit_ms")
  /// { phase, assigned, total, elapsedMs } while running.
  progress        Json?
  heartbeatAt     DateTime           @default(now()) @map("heartbeat_at")
  /// iterations, durationMs, stoppedBy, assigned, unassigned, workload range.
  result          Json?
  errorCode       String?            @map("error_code")
  startedById     String?            @map("started_by_id") @db.Uuid
  startedAt       DateTime           @default(now()) @map("started_at")
  finishedAt      DateTime?          @map("finished_at")

  school    School         @relation(fields: [schoolId], references: [id], onDelete: Cascade)
  term      Term           @relation(fields: [schoolId, termId], references: [schoolId, id], onDelete: Cascade)
  draft     TimetableDraft @relation(fields: [schoolId, draftId], references: [schoolId, id], onDelete: Cascade)
  startedBy User?          @relation(fields: [startedById], references: [id], onDelete: SetNull)

  @@unique([schoolId, id])
  @@index([schoolId, termId, startedAt])
  @@map("generator_runs")
}
```

Back-relations on `School`, `Term`, `Level`, `Room`, `TeacherProfile` and
`User` are added as usual. CHECKs in the migration:

- `group_lesson_times`: `weekday BETWEEN 1 AND 7`,
  `0 <= start_minute < end_minute <= 1440`, both `% 5 = 0`. "At most 7 per
  group" and "no overlap within a group" are cross-row; the service
  enforces them.
- `teacher_profiles`: `max_minutes_per_week IS NULL OR
max_minutes_per_week BETWEEN 15 AND 6000`.
- `timetable_drafts`: `(mode <> 'REPLACE') = (effective_from IS NOT NULL)`.
- `generator_runs`: partial unique index on `(school_id, term_id) WHERE
status = 'RUNNING'` (one running run per term).

Notes:

- `TimetableDraftAssignment.teacherId` is optional and composite, so per
  the schema convention it is `Restrict`. Teachers are archived, never
  deleted, so this never blocks in practice.
- `GroupLessonTime` and `GroupTermSkip` cascade with the group; groups are
  soft-deleted (`deletedAt`), so this only fires for a hard delete of an
  unused group.
- A term's draft and runs go with the term (`Cascade`): deleting a term is
  only possible before it has lessons anyway.
- No change to `TimetableSlot`, `Lesson`, `Room`, `Term`, `Holiday` or
  `TeacherAvailability` columns. Slots created by apply are ordinary slots.

**Removed from the first version** (never migrated): `TimetableDemand`,
`TimetableDemandTeacher`, `TimetableDemandRoom`, `TimetableDemandPin`,
`TimetableDraftSlot`, the enums `DemandTeacherMode`, `DemandRoomNeed`,
`DraftSlotOrigin`, `AvailabilityKind.WEEKLY_PREFERS_NOT`,
`TeacherProfile.maxTeachingMinutesPerDay`, the preference levels and the
run seed and presets.

## 9. Matches the UX spec (CARM-54, PR #30)

The spec's §10 lists what had to change here; every row is adopted:

| UX spec §10 row            | Here                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| Input                      | `GroupLessonTime` with room per row, `GroupTermSkip` (§2.1, §2.5)                                    |
| Teachers                   | `TeacherLevel`, `TeacherProfile.maxMinutesPerWeek` (§2.2, §2.3)                                      |
| Decision variable          | One teacher per group (§3)                                                                           |
| Hard rules                 | Level, free at all times, weekly unavailability, max hours (§3.1); time clashes are readiness (§2.5) |
| Soft                       | Even workload only (§3.3); one-off unavailability is a warning                                       |
| Not placed                 | Group reason plus every reason per teacher; one-swap and other suggestions (§4.5)                    |
| Draft                      | `TimetableDraftAssignment` (§5.1)                                                                    |
| Unchanged                  | Draft lifecycle, lock / reassign, out of date, apply / preview, FILL / REPLAN_FROM, concurrency (§5) |
| `TEACHER_LEVEL_NOT_TAUGHT` | Adopted as a new overridable conflict; the editor warns too (§4.3)                                   |

Answers to the spec's open questions, from the rules side:

- **Q1 levels:** one `TeacherLevel` row per level supports both answers;
  the tick boxes with "Up to…" need nothing extra.
- **Q2 group times mid-term:** adopted; the generator never moves a live
  lesson (§2.4).
- **Q3 max hours:** adopted, hard for the generator (§2.3).
- **Q4 swap suggestions:** defined (§4.5).
- **Q5 teacher change in a published term:** adopted: lessons are
  re-pointed to the new teacher, nothing is cancelled (§5.6).

Points the spec should reflect (small):

- In a published term, a group's lessons in the draft are its **live
  slots' times** where it has any, not its lesson times (§2.4); the Week
  view and Compare should show those.
- REPLAN_FROM keeps a group's current teacher when nobody else fits, even
  if that teacher now has a warning (§5.2). There is never "No teacher" for
  a group that has lessons unless the admin chooses it.
- The Busy section of the picker includes teachers busy in the draft
  (`TEACHING_IN_DRAFT`), not only in the live timetable.
- "Over max hours" picks need acknowledging on publish, like overridable
  conflicts (§5.6 step 3).
- Run: progress phases are `checking`, `assigning`, `balancing`; cancel
  only.

## 10. Open questions for the owner

1. **Max hours across terms:** should lessons in an overlapping term (e.g.
   a summer intensive running alongside) count toward a teacher's weekly
   maximum? Proposed: no, this term only; the other term's lessons still
   block the time.
2. **Published term, "Reconsider every group":** proposed meaning is "keep
   current teachers unless a change gives more groups a teacher" (the UX
   spec's wording). Is that right, or should it also rebalance workloads,
   changing more teachers mid-term?
3. **Teacher-only changes in the editor:** the generator re-points future
   lessons to the new teacher instead of cancelling those with absences or
   bookings (§5.6). Should the editor's "change teacher from a date" do the
   same? Proposed: yes, as a follow-up issue.
