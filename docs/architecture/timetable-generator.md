# Timetable generator (rules, CARM-48)

**Status: Phase 4, proposed. Nothing here is implemented yet.** Stage 2
(CARM-50) builds the schema, the engine and the service from this page;
stage 3 (CARM-51) the admin screens. The screens are specified in
`docs/design/timetable-generator.md` (CARM-49); where the two disagree,
raise it on the issue rather than picking one.

The generator builds a term's **weekly timetable** (`TimetableSlot`s) from
what each group needs per week. It writes a **draft** the admin reviews,
edits and locks, then applies through the same checks and lesson
generation the manual editor uses ([scheduling.md](scheduling.md)). It
never creates `Lesson`s directly.

Owner decisions this builds on (2026-10-13 project brief, CARM-38 Phase 4
breakdown approved 2026-10-14):

- Timetable = recurring `TimetableSlot` templates; dated `Lesson`s are
  generated per term from them.
- Group lessons and 1-on-1 lessons.
- Start in TypeScript; propose an OR-Tools CP-SAT sidecar only with evidence
  that TypeScript is not enough.
- The draft never touches the live timetable until the admin publishes it,
  and publishing goes through the existing `publishTerm` checks.
- No deployment target yet; everything must run locally.

Terms used below: a **unit** is one weekly lesson the generator has to
place (a demand row with 2 lessons a week has 2 units). A **placement** is
a unit's weekday, start, teacher and room. The **fixed context** is
everything the generator may not move: other terms, existing lessons,
live slots it keeps, locked draft slots. **Generator-hard** is the set of
conflicts the generator never produces (§3.1).

## 1. Where things live

| Path                                        | What                                                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/server/scheduling/generator/`          | Pure engine: no Prisma, no Next.js; deterministic; unit- and property-tested                       |
| `· types.ts`                                | `GeneratorInput` (scheduling context + demand + draft + settings), `GeneratorResult`               |
| `· preflight.ts`                            | Demand checks that need no search (no eligible teacher, no suitable room, bad pin, …)              |
| `· occupancy.ts`                            | Weekly occupancy masks per teacher, room, group and student, built from `buildCalendar`'s bookings |
| `· score.ts`                                | Soft preferences, weights, full and incremental scoring                                            |
| `· construct.ts` / `search.ts`              | Greedy construction with repair; late-acceptance local search                                      |
| `· explain.ts`                              | Reasons and suggested fixes for unplaced units                                                     |
| `· generate.ts`                             | `generateTimetable(input)` and the step-wise `generateTimetableSteps(input)` (§4.6)                |
| `src/server/scheduling/random.ts`           | The seeded PRNG (mulberry32), moved here from `testing/realistic.ts`, which re-exports it          |
| `src/server/timetable/generator-service.ts` | Database service: demand, drafts, generate, apply. One transaction per action                      |
| `messages/en-GB/scheduling.json`            | New `generator.reasons.<CODE>`, `generator.criteria.<CODE>`, `generator.errors.<CODE>`             |

The engine follows the scheduling module's contract: plain-data inputs,
sorted output, no `Date.now()` or `Math.random()`, every rule covered by a
test.

## 2. Inputs

### 2.1 Demand: what a group needs in a term

New table `TimetableDemand`, one or more rows per group and term. Several
rows let a group have, say, 2 × 90 min with its regular teacher and
1 × 45 min conversation with another one.

| Field                                        | Meaning                                                                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `termId`, `groupId`                          | Which term and group. The group must not be archived.                                                                      |
| `lessonsPerWeek`                             | 1–14 units.                                                                                                                |
| `durationMinutes`                            | 15–600, a multiple of 5. Every unit of the row has this length.                                                            |
| `teacherId`                                  | Fixed teacher. Null = the generator picks **one** teacher for all units of the row from the eligible ones (§2.2).          |
| `roomId`                                     | Fixed room. Null = the generator picks one per unit.                                                                       |
| `roomKind`                                   | `PHYSICAL`, `ONLINE` or null (any). Only with `roomId` null.                                                               |
| `minRoomCapacity`                            | Optional. Rooms need capacity ≥ max(enrolled students, this). Online rooms without a capacity always fit.                  |
| `preferredRoomId`                            | Soft (§3.3).                                                                                                               |
| `preferredWeekdays`                          | Soft. Empty = no preference.                                                                                               |
| `preferredStartMinute`, `preferredEndMinute` | Soft window the lessons should lie in, e.g. 16:00–20:00 for adults after work. Both or neither.                            |
| pins (`TimetableDemandPin`)                  | Up to `lessonsPerWeek` fixed times: weekday + start (+ optional room). A pinned unit is placed there or reported unplaced. |

Pins live on the demand because they are a standing requirement ("this
group always meets Monday 17:00") that survives regenerating and copying to
the next term. Locks (§5.3) belong to one draft.

**Getting demand in.** Besides per-row editing, the service offers two bulk
sources (the UX spec decides the screens):

- `copyDemand(fromTermId, toTermId)`: copies rows of non-archived groups
  that have no demand in the target term yet.
- `demandFromSlots(termId, sourceTermId)`: derives rows from a term's live
  slots, for the first time a school uses the generator. Slots of a group
  are grouped by (teacher, duration); each group of slots becomes a row with
  `lessonsPerWeek` = count, the teacher fixed and the most used room as
  `preferredRoomId`. No pins.

Both return what they created and skipped (e.g. "archived group").

### 2.2 Who may teach what

New table `TeacherLevel` (teacher × level). When `teacherId` is null, the
eligible teachers are those with a `TeacherLevel` row for the group's
level. No eligible teacher → `NO_ELIGIBLE_TEACHER` (§4.5). The teacher
form gets a "Levels they teach" multi-select. A fixed `teacherId` is
always allowed, qualified or not (the admin decided).

### 2.3 Teacher settings

- `TeacherProfile.maxTeachingMinutesPerDay Int?`: soft daily maximum (§3.3).
- New `AvailabilityKind` `WEEKLY_PREFERS_NOT` (same shape as
  `WEEKLY_UNAVAILABLE`): "rather not on Fridays after 16:00". It is a soft
  preference for the generator only. `unavailabilityRules` already ignores
  kinds it does not know, so the conflict checker and the editor do not
  change; the availability form gets the new option.

### 2.4 Everything else comes from existing data

School teaching weekdays and day window, terms and holidays, groups with
their enrolled students (`GroupMembership.leftAt` null) and level, rooms,
teacher availability, live slots and lessons of the term and of every
overlapping term: exactly what `loadContext` in the timetable service
already loads for the checker.

## 3. Constraints

### 3.1 Hard: what the generator never produces

The generator places weekly slots, so it uses `checkSlot`, which applies
the same blocking checks as `checkLesson` (both go through `collect`). It
treats **more** as hard than the editor blocks: an admin may knowingly
override a warning, but the generator must not decide that for them.

| Conflict type                                     | Editor      | Generator                                                                                                  |
| ------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------- |
| `INVALID_TIME`, `OUTSIDE_TERM`                    | blocking    | Never produced: candidates are on the grid inside the day window and the term                              |
| `GROUP_ARCHIVED`                                  | blocking    | Preflight → unplaced                                                                                       |
| `ROOM_ARCHIVED`                                   | blocking    | Archived rooms are never candidates (a kept slot may stay in one, as in the editor)                        |
| `TEACHER_` / `ROOM_` / `GROUP_DOUBLE_BOOKED`      | blocking    | **Hard**                                                                                                   |
| `STUDENT_DOUBLE_BOOKED`                           | overridable | **Hard**: a student in several groups (or in another term's group) never gets two lessons at once          |
| `ONLINE_ROOM_SHARED`                              | overridable | **Hard**: an online room is one licence/link; add online rooms if more are needed at once                  |
| `ROOM_CAPACITY_EXCEEDED`                          | overridable | **Hard**: only rooms that fit (with `minRoomCapacity`)                                                     |
| `TEACHER_UNAVAILABLE_WEEKLY`                      | overridable | **Hard** (§3.2)                                                                                            |
| `TEACHER_UNAVAILABLE_ON_DATE`                     | overridable | **Soft**, penalised per affected date (§3.2)                                                               |
| `OUTSIDE_SCHOOL_DAYS`, `OUTSIDE_SCHOOL_HOURS`     | overridable | **Hard**: only teaching weekdays and the school day window. Pins outside them are `PIN_INVALID`            |
| `NO_OCCURRENCES`                                  | overridable | **Hard**: a weekday with no dates left (all holidays, or all before the effective date) is not a candidate |
| `LESSON_ON_HOLIDAY`                               | overridable | Not applicable: slots skip holidays                                                                        |
| `GROUP_OVER_CAPACITY`, `ONE_ON_ONE_STUDENT_COUNT` | overridable | Not about placement: no time or room fixes them. Shown as preflight warnings; the unit is still placed     |

The set is one exported constant, `GENERATOR_HARD_CONFLICTS`, used by the
engine's final verification and by the tests.

### 3.2 Teacher unavailability

- **Weekly unavailability is hard.** It is the teacher telling the school
  when they cannot work every week. In the editor it is overridable because
  an admin may have agreed an exception with the teacher; the generator
  cannot know that. If the admin wants it, they place or move the slot by
  hand in the draft (§5.3) and acknowledge the warning when applying.
- A `DATE_AVAILABLE` exception lifts a weekly rule for one date only, so it
  does not make a weekly slot possible; it is ignored.
- **One-off unavailability is soft.** A teacher away on one Tuesday must not
  rule out every Tuesday of the term; that date is handled with a
  substitute (Phase 5). Each affected date costs `TEACHER_DATE_UNAVAILABLE`
  points, and the slot shows the usual overridable conflict in the draft.

### 3.3 Soft preferences

Penalty points, lower is better; 0 means every preference is met. Weights
are integers (no floating point, so scores are exactly reproducible) and
live in one constant, `GENERATOR_WEIGHTS`. They are not admin-editable in v1
(open question 4).

| Code                       | Counts                                                                                                                                    | Weight |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -----: |
| `TEACHER_DAILY_MAX`        | Per started 15 min a teacher teaches over `maxTeachingMinutesPerDay` on a weekday                                                         |     25 |
| `SAME_DAY_REPEAT`          | Per extra lesson of the same group on one weekday (not counted when the group has more units than there are teaching weekdays)            |     40 |
| `OUTSIDE_PREFERRED_TIME`   | Per unit outside its demand's preferred weekdays or window                                                                                |     15 |
| `TEACHER_PREFERS_NOT`      | Per unit overlapping one of its teacher's `WEEKLY_PREFERS_NOT` windows                                                                    |     12 |
| `TEACHER_DATE_UNAVAILABLE` | Per date a unit falls on a teacher's one-off unavailability                                                                               |     10 |
| `TEACHER_CHANGED`          | Per demand row with a generator-chosen teacher who did not teach this group in the previous term (when it had one): teacher continuity    |     20 |
| `CONSECUTIVE_DAYS`         | Per pair of a group's lessons on consecutive weekdays when the group has ≤ 3 units a week (spread across the week)                        |      8 |
| `UNSTABLE_TIME`            | Per extra distinct start time among one demand row's units (stable time across the week)                                                  |      6 |
| `NOT_PREFERRED_ROOM`       | Per unit not in its demand's `preferredRoomId`                                                                                            |      4 |
| `TEACHER_GAP`              | Per started 30 min a teacher sits idle between two lessons on the same day, after a 15 min changeover                                     |      3 |
| `TIME_CHANGED`             | Per unit whose weekday + start differs from all of the group's slots in the previous term (when it had some): students keep their routine |      3 |
| `STUDENT_GAP`              | Per started 30 min a student sits idle between lessons of different groups on the same day, after a 15 min changeover                     |      1 |

"Previous term" is the school's term that ends last before this one starts.
School opening hours are not a soft preference: the school day window is
hard (§3.1); a group's or teacher's narrower wishes are the preferred
window and `WEEKLY_PREFERS_NOT`.

**The score shown to the admin** is the total plus a breakdown per code
(points and count, e.g. "Teacher gaps: 4 h, 24 points"), for the whole
draft and per teacher and group, so the review grid can mark the worst
spots. The draft also stores the score after construction, so the UI can
say how much the search improved it.

## 4. Algorithm

### 4.1 Choice: constructive heuristic + local search, in TypeScript

The problem is small. The realistic test school (20 teachers, 60 groups,
15 rooms, ~330 students, 2 × 90 min per group) has **120 units**; a large
language school perhaps 500. On a 15-minute grid a unit has about 6
weekdays × 50 starts × its rooms ≈ 4 000 candidate placements.

Measured on `main` (Node 23, Apple Silicon, realistic dataset seeds 1–3):

| What                                                                     | Result                      |
| ------------------------------------------------------------------------ | --------------------------- |
| `buildCalendar` with ~120 slots                                          | ~1.0 ms                     |
| `checkSlot` for one candidate, full calendar                             | 35–90 µs                    |
| First-fit placement with `checkSlot` (rebuilding the calendar each time) | 120/120 placed in 2.0–2.4 s |
| Checking all 2 340 candidates of one unit with `checkSlot`               | 82–92 ms                    |

So placement is easy on realistic data; the real work is the soft score,
and a search loop that called `checkSlot` for every move would spend ~90 ms
per unit sweep. Hence a fast **weekly occupancy index** for the search and
`checkSlot` as the authority (§4.3).

Why not a CP/ILP solver now:

- Greedy first-fit already places everything on realistic data; a solver's
  strength (proving feasibility of tight instances) is not where we are.
- OR-Tools has no maintained JavaScript binding; CP-SAT means a Python (or
  C++) sidecar process: a second runtime in docker compose, a wire format
  for the whole context, and hard rules written a second time, which would
  drift from `checkSlot`. With no deployment target, we would also be
  choosing a hosting shape blind.
- A pure TypeScript engine runs in Vitest next to the checker, shares its
  code and stays deterministic.

**When to propose CP-SAT** (the evidence gate, measured by the stage 2
tests, §6): the engine misses a complete placement that the exhaustive
oracle finds on more than 1 % of small instances, or places < 98 % of the
dense dataset, or cannot meet the time target. Then the sidecar is proposed
with those numbers, keeping `checkSlot` as the verifier of its output.

No new runtime dependency is needed.

### 4.2 Pipeline

1. **Snapshot.** The service loads the scheduling context of the term (and
   overlapping terms), the demand, the teacher levels and settings, the
   previous term's slots and the draft. All arrays are sorted by id before
   use, so input order never matters.
2. **Fixed context.** Live slots and lessons the run must respect (§5.2),
   plus the draft's locked slots, go into one `buildCalendar`.
3. **Preflight** (`preflight.ts`) per demand row: archived group, no
   eligible teacher, no room of the right kind and size, duration longer
   than the school day, pins outside school days/hours or blocked by the
   fixed context (the pin's `checkSlot` conflicts are attached). Units
   already covered by kept or locked slots (§5.2) are removed. What fails
   here is unplaced with its reason and never searched.
4. **Occupancy index** (`occupancy.ts`). For every teacher, room, group and
   student, a bitset per weekday of 5-minute cells (288 per day). A weekly
   candidate on weekday _w_ clashes with a booking exactly when the booking
   overlaps its time on **any** of the candidate's dates, and every
   candidate on _w_ has the same dates (the term's _w_ dates from the start
   or effective date, minus holidays). So the mask of _w_ is the union, over
   those dates, of the bookings `buildCalendar` indexed for them (local
   start/end minutes). Weekly unavailability, room kind, capacity and
   archived rooms become per-candidate filters; one-off unavailability
   becomes a per-cell **count of affected dates** for the soft score.
   Placing or moving a unit updates the bitsets of its teacher, room, group
   and students in O(cells).
5. **Construction** (`construct.ts`). Pinned units first, then the rest by
   fewest feasible placements (ties: demand id, unit index). Each unit gets
   the feasible placement with the lowest score increase; a demand row's
   teacher is chosen with its first unit and kept for the others. If none
   is feasible, **repair**: try to eject one or two unlocked units that
   block the best candidate, place this unit, re-place the ejected ones; on
   failure undo. Bounded per unit.
6. **Local search** (`search.ts`): late-acceptance hill climbing (one
   parameter, history length 500; robust on timetabling and easy to make
   deterministic). Moves, drawn by the seeded PRNG: move a unit to another
   feasible weekday/start (room re-chosen), change a unit's room, swap the
   times of two units, change a demand row's chosen teacher (all its units,
   only if all stay feasible), and every N iterations try to insert an
   unplaced unit with repair. Only unlocked, unpinned units move (pinned
   units may change room unless the pin has one). Score changes are
   computed incrementally for the teachers, groups and students the move
   touches. The best solution seen is kept.
7. **Verify.** Build one calendar from the fixed context plus all draft
   slots and run `checkSlot` on every generated slot. Any
   `GENERATOR_HARD_CONFLICTS` conflict is an engine bug: the slot is dropped
   to unplaced with `INTERNAL_CHECK_FAILED` (and the tests fail on it). The
   remaining overridable conflicts (one-off unavailability, data warnings)
   are stored with the draft slots so the review shows them like the editor
   does.
8. **Explain** (`explain.ts`) every unplaced unit (§4.5).

### 4.3 Reusing the checker instead of duplicating rules

- The occupancy masks are built from `buildCalendar`'s bookings, which
  already resolve substitutes, moved and cancelled lessons, slot ranges,
  holidays and DST. `Booking` and `bookingsByDate` get exported for this
  (no behaviour change).
- Weekly and one-off availability go through `unavailabilityRules`.
- Occurrence dates come from `slotOccurrenceDates`; holidays from
  `holidaysOfTerm`.
- `checkSlot` is the final verifier (step 7), the source of the conflicts
  the draft shows, and the oracle the masks are property-tested against
  (§6): for sampled candidates, "mask says feasible" must equal "`checkSlot`
  reports no generator-hard conflict".
- Apply re-checks with `checkSlot` / `checkTimetable` under the timetable
  lock (§5.6), so even a mask bug can never reach the live timetable.

The only rule-like code the generator owns is the soft score.

### 4.4 Determinism, seed and time budget

- Same input + same seed + same iteration budget → the same draft, byte for
  byte, whatever the order of the input arrays.
- The PRNG is seeded (`seed`, a 31-bit integer stored on the draft). Generate
  and "regenerate the rest" reuse the draft's seed; "Try another variant"
  draws a new one.
- The budget is **iterations** (`maxIterations`), which is deterministic.
  Wall time (`timeLimitMs`, default 10 s, max 30 s) is only a safety cap; if
  it fires first, the result says `stoppedBy: "time"` and is not guaranteed
  reproducible. Defaults are tuned so the realistic dataset finishes well
  inside the cap (§6). Tests use iteration budgets only.
- The result records the seed, iterations, duration, `stoppedBy` and the
  construction and final scores.

### 4.5 Unplaced demand and reasons

Each unplaced unit gets one reason code with ICU params
(`scheduling.generator.reasons.<CODE>`) and refs to link, the same shape
as a `Conflict`:

| Code                     | When                                                                                                             | Params / refs                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `GROUP_ARCHIVED`         | The group is archived                                                                                            | `group`                        |
| `NO_ELIGIBLE_TEACHER`    | No fixed teacher and nobody teaches the group's level                                                            | `group`, `level`               |
| `NO_SUITABLE_ROOM`       | No non-archived room of the required kind with enough capacity                                                   | `roomKind`, `capacity`         |
| `DURATION_TOO_LONG`      | Longer than the school day window                                                                                | `duration`, `schoolHours`      |
| `PIN_INVALID`            | The pin is outside school days/hours or clashes with the fixed context                                           | `time`; the pin's conflicts    |
| `NO_FREE_TIME`           | Even with no other draft lessons, no time has the teacher, group, students and a room all free                   | blocker breakdown              |
| `TAKEN_BY_OTHER_LESSONS` | Free times exist in the fixed context, but other draft lessons occupy all of them and repair could not move them | blocker breakdown, suggestions |
| `INTERNAL_CHECK_FAILED`  | Step 7 found a generator-hard conflict (a bug; never expected)                                                   | the conflicts                  |

**Blocker breakdown** for the last three: over all candidate times, how many
are blocked by the teacher being busy, the teacher's weekly unavailability,
students being busy (the top 3 students by count, by name), the group's
own lessons, or no room being free. Example: "No common free time: teacher
busy at 38 times, unavailable at 22, students Ana K. and Petr S. busy at
10".

**Suggestions** (up to 3): candidate times blocked by exactly one movable
thing, e.g. "Tue 17:00 would work if Group B2-Evening's lesson moved"
(→ unlock/move that draft slot), "… if Teacher X were available"
(→ edit availability), "… with a room for 12" (→ room). They point at the
data to change; they never change it.

### 4.6 Running inside the app

The engine is synchronous and CPU-bound; running it for seconds inside a
server action would freeze every other request of the Node process. So
`generateTimetableSteps(input)` is a generator function that yields every
~2 000 iterations, and the service drives it with `await setImmediate`
between steps. The output is identical to the synchronous
`generateTimetable` (tested). This needs no worker bundling and keeps one
code path. The server action waits for the result (≤ `timeLimitMs`); the UI
shows indeterminate progress with the elapsed time. A job table with
polling or a worker thread can come later if a deployment target needs it
(open question 3).

## 5. Draft lifecycle

### 5.1 Where a draft lives, and why not in `TimetableSlot`

A draft is a `TimetableDraft` (one per term) with its `TimetableDraftSlot`s.
It is **not** written as live slots because:

- live slots are the source of everything else: the checker of every
  overlapping term, the editor, lesson generation, teachers' and students'
  timetables of a published term. A half-reviewed draft would leak into
  all of them;
- the admin's manual slots in a draft term must survive "Generate" until
  the admin decides to replace them;
- discarding or regenerating a draft must be free, with no slot history
  (splits, ended slots) left behind;
- applying must be one atomic, audited step that the existing checks guard.

Draft tables are read only by the generator service. No teacher or student
view, and no `loadContext` for the checker, ever reads them.

### 5.2 Starting a draft: what happens to an existing timetable

The service picks the mode from the term's state:

| Term state                             | Mode        | Behaviour                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Not published, no slots                | **REPLACE** | Generate everything.                                                                                                                                                                                                                                                                                                                                                            |
| Not published, has slots (manual work) | **REPLACE** | The admin chooses: **keep my slots** (default; copied into the draft as locked `KEPT` slots, matched to demand units by group, then fixed teacher, then duration, so they count as placed) or **start from scratch** (none copied; applying will delete them). Live slots of this term are never in the fixed context in REPLACE mode: the draft is the term's whole timetable. |
| Published (has lessons)                | **FILL**    | From an **effective date** _D_ (default: the first teaching day after today; never today or earlier). Every live slot in effect on or after _D_ stays as it is and is part of the fixed context; demand units they cover count as placed. The generator only places the **remaining** demand (new groups, more lessons), as new slots from _D_. Lessons are unaffected.         |

In FILL mode the kept live slots are not copied into the draft; they are
read live each time, so the draft cannot get out of step with them. A full
re-plan of a published term (moving existing groups mid-term) is not
offered in v1: it moves every student's routine at once and would cancel
lessons with history. Admins move individual slots in the editor (open
question 1).

Matching for "counts as placed": demand units of a group are matched to
its slots in order (teacher equal when the demand fixes one, duration
equal), each slot used once. Slots matching no demand stay as fixed
bookings ("not managed by demand"); the review lists them.

### 5.3 Editing and locking

- Each draft slot has `locked` and `origin` (`GENERATED`, `MANUAL`, `KEPT`).
- The admin can move or re-room a slot, change its teacher (any teacher:
  the admin decides, as with pins), delete it (its unit becomes unplaced)
  or add a slot for an unplaced unit. Edits are
  checked with `checkSlot` against the fixed context plus the other draft
  slots: **blocking** conflicts are refused, as in the editor;
  **overridable** ones are allowed and shown, and acknowledged on apply.
  So a draft can hold a slot the generator would not make (e.g. in a
  teacher's weekly unavailability) when the admin wants it.
- An edited or added slot is locked automatically; the admin can unlock it.
- Locked slots are fixed for the generator: never moved, re-roomed or
  re-assigned. A locked slot that conflicts after data changed stays put;
  its conflict is shown.

### 5.4 Regenerating the rest

"Regenerate" keeps locked slots and re-places all unlocked units from
scratch with the draft's seed (same inputs → same result). "Try another
variant" does the same with a new seed. Deleting a demand row removes its
unlocked draft slots and detaches its locked ones (`demandId` null,
origin `MANUAL`) in the same transaction.

### 5.5 Staleness

When a run finishes, the draft stores a **fingerprint**: SHA-256 of the
canonical (sorted) generator input, i.e. demand, teacher levels and
settings, and the scheduling context. Opening the draft recomputes it; if
it differs, the draft is **stale** (someone changed demand, enrolment,
availability, holidays, rooms or the live timetable). Stale is a warning
("Data changed since this draft was generated. Regenerate the unlocked
rest?"), not a block: apply re-checks everything anyway.

### 5.6 Applying and publishing

`applyDraft(draftId, { version, acknowledgedConflictKeys, publish })`, in
one transaction holding the school's timetable advisory lock
(`lockTimetable`, as every timetable write) and the draft row
(`FOR UPDATE`, `version` must match):

1. Reload the context. In FILL mode, refuse with `EFFECTIVE_DATE_PASSED` if
   _D_ ≤ today.
2. Build the would-be timetable. REPLACE: the term's slots are exactly the
   draft slots. FILL: the live slots plus the draft slots from _D_.
3. `checkTimetable` on it. Any **blocking** conflict refuses with the fresh
   list (`BLOCKING_CONFLICTS`). Every **overridable** conflict of a draft
   slot must be in `acknowledgedConflictKeys` (`decideSave` per slot,
   keys prefixed with the draft slot id), else `UNACKNOWLEDGED_CONFLICTS`.
   A clash someone created meanwhile is never overridden blindly.
4. Write slots. REPLACE (term has no lessons): live slots matched by
   `sourceSlotId` are updated in place, unmatched live slots deleted, the
   others created. FILL: draft slots are created with `validFrom` = _D_;
   nothing else changes.
5. Lessons. REPLACE with `publish: true`: run the `publishTerm` logic in
   this transaction (it is split into `publishTermIn(tx, …)` for this; same
   checks, same `timetable.published` audit). REPLACE with `publish: false`:
   only the slots are written; the term stays a draft for further manual
   work in the editor. FILL: the new slots' lessons are generated from _D_
   with the same `syncSlots` the editor uses.
6. Audit `timetable_draft.applied` (mode, counts created/updated/deleted,
   overridden conflicts, seed, score), then delete the draft.

### 5.7 Concurrency

- **A run does not hold the timetable lock.** It reads a snapshot, computes
  for up to `timeLimitMs`, then saves in a short transaction that locks the
  draft row and requires the `version` read at the start. If a draft edit
  or another run saved meanwhile, the result is discarded with
  `DRAFT_CHANGED` and the UI offers to run again. Holding the school-wide
  lock for seconds would stall every booking and edit.
- **Draft edits** use the same `version` check (optimistic; the response
  carries the fresh draft on `DRAFT_CHANGED`). Two admins on one draft
  cannot overwrite each other silently.
- **Live changes during a draft's life** (editor, holidays, absences,
  reschedules) only make the draft stale (§5.5). Apply takes the timetable
  lock and re-checks, so the live timetable can never be double-booked by a
  draft.
- **Two drafts?** One per term (unique). Drafts of two overlapping terms
  don't see each other; the second one applied is checked against the
  first, as live data.

### 5.8 Discarding

`discardDraft` deletes the draft and its slots (audited). Demand stays.

## 6. Performance target and tests

### 6.1 Test data

`testing/realistic.ts` gets:

- `realisticDemand(seed, school, { density })`: `"normal"` = every group
  2 × 90 min (as the existing property test places; 120 units), 80 % with
  a fixed teacher (`groupTeacher`), 20 % chosen from eligible teachers;
  some pins, preferred windows and rooms. `"dense"` = 3 units of 60–90 min
  per group (~180 units).
- teacher levels (each teacher 2–4 of the levels), daily maxima on half the
  teachers, a few `WEEKLY_PREFERS_NOT` rules, and a previous term with
  slots.

### 6.2 Performance target (stage 2 must report the numbers)

| Dataset (seeds 1–5)      | Must                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------- |
| realistic, normal demand | 100 % placed; construction ≤ 0.5 s; full run with default budget ≤ 3 s on a dev laptop |
| realistic, dense demand  | ≥ 98 % placed, every unplaced unit with a reason; full run ≤ 5 s                       |
| both                     | Final score strictly below the construction score                                      |

CI machines are slower: the timed tests assert 3× these limits, and print
the measured values.

### 6.3 Properties the engine must pass (fixed seeds)

1. **No generator-hard conflict:** every generated slot passes `checkSlot`
   with none of `GENERATOR_HARD_CONFLICTS` against the fixed context plus
   all other draft slots; and the brute-force pairwise oracle from
   `conflicts.property.test.ts` finds no clash.
2. **Mask = checker:** for sampled candidates (also with existing lessons,
   moved and substituted lessons, partial-range slots, other terms,
   holidays, DST weeks), the occupancy index's verdict equals `checkSlot`'s.
3. **Determinism:** same input and seed → deep-equal result; shuffled input
   arrays → the same result; `generateTimetableSteps` = `generateTimetable`.
4. **Locks:** with random subsets locked, locked slots come out unchanged;
   with everything locked, the output is the input.
5. **Accounting:** placed + unplaced = demand units; every slot matches its
   demand (duration, fixed or eligible teacher, one teacher per row, room
   kind and capacity, pins).
6. **Maximality:** no unplaced unit can be added to the final draft at any
   candidate placement without a hard conflict (so "couldn't place" is
   true), and its reason agrees with a brute-force recount.
7. **Score:** the incremental score equals a from-scratch recomputation
   after every accepted move (checked every N moves in tests); the final
   score never exceeds the construction score.
8. **Completeness on small instances:** on 200 small random instances
   (≤ 10 groups, 3 teachers, 3 rooms) where an exhaustive backtracking
   oracle finds a full placement, the engine places everything on ≥ 99 %
   (the CP-SAT gate, §4.1).
9. **FILL mode:** new slots start on _D_; no live slot or lesson before _D_
   changes; the kept slots are never moved.
10. **Infeasible input:** a demand with no eligible teacher, no fitting
    room, an impossible pin or an over-full teacher gets the right reason
    and does not disturb the rest.

DB tests (`generator-service.db.test.ts`, opt-in like the others): apply in
both modes, refusal on a clash created between generate and apply,
`DRAFT_CHANGED` on concurrent edits, `EFFECTIVE_DATE_PASSED`, demand
deletion with locked slots, school scoping of every action.

## 7. Service API and access

Every action: `requireRole("ADMIN")`, `getSchoolScopedDb()`, zod validation,
`SchedulingError` codes translated by `scheduling.generator.errors.<code>`.
Draft and demand ids of another school are "not found".

| Function                                     | Purpose                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| `listDemand` / `saveDemand` / `deleteDemand` | Demand rows with pins                                                        |
| `copyDemand` / `demandFromSlots`             | Bulk sources (§2.1)                                                          |
| `getDraft`                                   | Draft, slots with conflicts, unplaced, score, stale flag                     |
| `generateDraft`                              | Create the draft if needed (mode from §5.2) and run; `newSeed` for a variant |
| `saveDraftSlot` / `deleteDraftSlot`          | Edit, add, delete a draft slot (§5.3)                                        |
| `setDraftSlotsLocked`                        | Lock / unlock several slots                                                  |
| `applyDraft`                                 | §5.6                                                                         |
| `discardDraft`                               | §5.8                                                                         |

Audit actions: `timetable_demand.created|updated|deleted|copied`,
`timetable_draft.generated` (seed, budget, stoppedBy, placed/unplaced,
score), `timetable_draft.discarded`, `timetable_draft.applied`, plus the
existing `timetable.published`. Draft slot edits are not audited
individually (nothing live changes); the applied entry records the result.

## 8. Schema changes

Proposed for the stage 2 migration. Every new table carries `school_id`,
`@@unique([schoolId, id])` and composite FKs, as the schema convention
requires.

```prisma
enum AvailabilityKind {
  WEEKLY_UNAVAILABLE
  DATE_UNAVAILABLE
  DATE_AVAILABLE
  /// Soft, generator only: rather not teach then (same fields as WEEKLY_UNAVAILABLE).
  WEEKLY_PREFERS_NOT
}

enum DraftMode {
  REPLACE
  FILL
}

enum DraftSlotOrigin {
  GENERATED
  MANUAL
  KEPT
}

model TeacherProfile {
  // … existing fields …
  /// Soft daily maximum for the timetable generator; null = none.
  maxTeachingMinutesPerDay Int? @map("max_teaching_minutes_per_day")
  levels                   TeacherLevel[]
}

/// Levels a teacher may teach; the generator picks teachers from these.
model TeacherLevel {
  id        String   @id @default(uuid()) @db.Uuid
  schoolId  String   @map("school_id") @db.Uuid
  teacherId String   @map("teacher_id") @db.Uuid
  levelId   String   @map("level_id") @db.Uuid
  createdAt DateTime @default(now()) @map("created_at")

  school  School         @relation(fields: [schoolId], references: [id], onDelete: Cascade)
  teacher TeacherProfile @relation(fields: [schoolId, teacherId], references: [schoolId, id], onDelete: Cascade)
  level   Level          @relation(fields: [schoolId, levelId], references: [schoolId, id], onDelete: Cascade)

  @@unique([schoolId, teacherId, levelId])
  @@unique([schoolId, id])
  @@index([schoolId, levelId])
  @@map("teacher_levels")
}

/// What a group needs every week in a term (generator input).
model TimetableDemand {
  id                   String    @id @default(uuid()) @db.Uuid
  schoolId             String    @map("school_id") @db.Uuid
  termId               String    @map("term_id") @db.Uuid
  groupId              String    @map("group_id") @db.Uuid
  lessonsPerWeek       Int       @map("lessons_per_week")
  durationMinutes      Int       @map("duration_minutes")
  teacherId            String?   @map("teacher_id") @db.Uuid
  roomId               String?   @map("room_id") @db.Uuid
  roomKind             RoomKind? @map("room_kind")
  minRoomCapacity      Int?      @map("min_room_capacity")
  preferredRoomId      String?   @map("preferred_room_id") @db.Uuid
  preferredWeekdays    Int[]     @default([]) @map("preferred_weekdays")
  preferredStartMinute Int?      @map("preferred_start_minute")
  preferredEndMinute   Int?      @map("preferred_end_minute")
  note                 String?
  createdAt            DateTime  @default(now()) @map("created_at")
  updatedAt            DateTime  @updatedAt @map("updated_at")

  school        School               @relation(fields: [schoolId], references: [id], onDelete: Cascade)
  term          Term                 @relation(fields: [schoolId, termId], references: [schoolId, id], onDelete: Cascade)
  group         Group                @relation(fields: [schoolId, groupId], references: [schoolId, id], onDelete: Restrict)
  teacher       TeacherProfile?      @relation(fields: [schoolId, teacherId], references: [schoolId, id], onDelete: Restrict)
  room          Room?                @relation("DemandRoom", fields: [schoolId, roomId], references: [schoolId, id], onDelete: Restrict)
  preferredRoom Room?                @relation("DemandPreferredRoom", fields: [schoolId, preferredRoomId], references: [schoolId, id], onDelete: Restrict)
  pins          TimetableDemandPin[]
  draftSlots    TimetableDraftSlot[]

  @@unique([schoolId, id])
  @@index([schoolId, termId])
  @@index([schoolId, groupId])
  @@map("timetable_demands")
}

/// A fixed weekly time for one unit of a demand row.
model TimetableDemandPin {
  id          String  @id @default(uuid()) @db.Uuid
  schoolId    String  @map("school_id") @db.Uuid
  demandId    String  @map("demand_id") @db.Uuid
  weekday     Int
  startMinute Int     @map("start_minute")
  roomId      String? @map("room_id") @db.Uuid

  school School          @relation(fields: [schoolId], references: [id], onDelete: Cascade)
  demand TimetableDemand @relation(fields: [schoolId, demandId], references: [schoolId, id], onDelete: Cascade)
  room   Room?           @relation(fields: [schoolId, roomId], references: [schoolId, id], onDelete: Restrict)

  @@unique([demandId, weekday, startMinute])
  @@unique([schoolId, id])
  @@map("timetable_demand_pins")
}

/// The generator's working copy of a term's timetable (one per term).
/// Never read by timetable views or the conflict checker.
model TimetableDraft {
  id               String    @id @default(uuid()) @db.Uuid
  schoolId         String    @map("school_id") @db.Uuid
  termId           String    @map("term_id") @db.Uuid
  mode             DraftMode
  /// FILL only: new slots start on this date.
  effectiveFrom    DateTime? @map("effective_from") @db.Date
  seed             Int
  /// Optimistic concurrency for runs and edits.
  version          Int       @default(0)
  /// SHA-256 of the canonical generator input of the last run (staleness).
  inputFingerprint String?   @map("input_fingerprint")
  generatedAt      DateTime? @map("generated_at")
  /// Final and construction score, breakdown per criterion.
  score            Json?
  /// Unplaced units with reason codes, params, refs and suggestions.
  unplaced         Json      @default("[]")
  /// iterations, durationMs, stoppedBy, budget.
  runStats         Json?     @map("run_stats")
  createdById      String?   @map("created_by_id") @db.Uuid
  createdAt        DateTime  @default(now()) @map("created_at")
  updatedAt        DateTime  @updatedAt @map("updated_at")

  school    School               @relation(fields: [schoolId], references: [id], onDelete: Cascade)
  term      Term                 @relation(fields: [schoolId, termId], references: [schoolId, id], onDelete: Cascade)
  createdBy User?                @relation(fields: [createdById], references: [id], onDelete: SetNull)
  slots     TimetableDraftSlot[]

  @@unique([schoolId, termId])
  @@unique([schoolId, id])
  @@map("timetable_drafts")
}

model TimetableDraftSlot {
  id           String          @id @default(uuid()) @db.Uuid
  schoolId     String          @map("school_id") @db.Uuid
  draftId      String          @map("draft_id") @db.Uuid
  /// Null for slots not tied to demand (detached or kept unmatched).
  demandId     String?         @map("demand_id") @db.Uuid
  /// KEPT slots: the live slot this copies (REPLACE mode). No FK: the editor
  /// may delete that slot meanwhile; apply then creates it anew.
  sourceSlotId String?         @map("source_slot_id") @db.Uuid
  groupId      String          @map("group_id") @db.Uuid
  teacherId    String          @map("teacher_id") @db.Uuid
  roomId       String?         @map("room_id") @db.Uuid
  weekday      Int
  startMinute  Int             @map("start_minute")
  endMinute    Int             @map("end_minute")
  /// KEPT slots keep their range; generated ones are null (term or effective date).
  validFrom    DateTime?       @map("valid_from") @db.Date
  validUntil   DateTime?       @map("valid_until") @db.Date
  locked       Boolean         @default(false)
  origin       DraftSlotOrigin
  createdAt    DateTime        @default(now()) @map("created_at")
  updatedAt    DateTime        @updatedAt @map("updated_at")

  school  School           @relation(fields: [schoolId], references: [id], onDelete: Cascade)
  draft   TimetableDraft   @relation(fields: [schoolId, draftId], references: [schoolId, id], onDelete: Cascade)
  demand  TimetableDemand? @relation(fields: [schoolId, demandId], references: [schoolId, id], onDelete: Restrict)
  group   Group            @relation(fields: [schoolId, groupId], references: [schoolId, id], onDelete: Restrict)
  teacher TeacherProfile   @relation(fields: [schoolId, teacherId], references: [schoolId, id], onDelete: Restrict)
  room    Room?            @relation(fields: [schoolId, roomId], references: [schoolId, id], onDelete: Restrict)

  @@unique([schoolId, id])
  @@index([schoolId, draftId])
  @@map("timetable_draft_slots")
}
```

Back-relations on `School`, `Term`, `Group`, `Room`, `Level` and `User` are
added as usual. CHECKs in the migration:

- `timetable_demands`: `lessons_per_week BETWEEN 1 AND 14`;
  `duration_minutes BETWEEN 15 AND 600 AND duration_minutes % 5 = 0`;
  `room_kind IS NULL OR room_id IS NULL`; `min_room_capacity IS NULL OR
min_room_capacity >= 1`; `preferred_weekdays <@ ARRAY[1,2,3,4,5,6,7]`;
  preferred minutes both null, or `0 <= start < end <= 1440`.
- `timetable_demand_pins`: `weekday BETWEEN 1 AND 7`,
  `start_minute BETWEEN 0 AND 1439`. "At most `lessons_per_week` pins" is
  cross-row; the service enforces it.
- `timetable_drafts`: `(mode = 'FILL') = (effective_from IS NOT NULL)`.
- `timetable_draft_slots`: `weekday BETWEEN 1 AND 7`,
  `0 <= start_minute < end_minute <= 1440`.
- `teacher_profiles`: `max_teaching_minutes_per_day IS NULL OR
max_teaching_minutes_per_day BETWEEN 15 AND 1440`.
- `teacher_availability`: extend the shape CHECK so `WEEKLY_PREFERS_NOT`
  has the `WEEKLY_UNAVAILABLE` shape.

Notes:

- `TimetableDraftSlot.demandId` is optional and composite, so per the schema
  convention it is `Restrict`; the service detaches or deletes draft slots
  before deleting a demand row (§5.4).
- A term's demand and draft go with the term (`Cascade`): deleting a term is
  only possible before it has lessons anyway.
- Archiving a group, room or level never deletes demand; preflight reports
  it.
- No change to `TimetableSlot`, `Lesson`, `Room`, `Term` or `Holiday`
  columns.

## 9. Agreed with the UX spec (CARM-49)

These rules shape the screens; the Designer's spec should match them:

- Demand entry per term with pins and preferences; bulk via copy from a
  term and "derive from current slots" (§2.1).
- Mode chosen by the term's state; in a draft term with slots, the admin
  picks keep (default) or start from scratch; in a published term, an
  effective date and "add the missing lessons" only (§5.2).
- Generate is one request with indeterminate progress, elapsed time and
  the time cap (§4.6).
- Results: placed/unplaced counts, total score with breakdown, unplaced
  units with reason, blocker breakdown and up to 3 suggestions (§4.5).
- Review: draft slots show the same conflicts as the editor; edits are
  auto-locked; blocking edits refused (§5.3); stale banner (§5.5).
- Apply: "Apply" (term stays draft) or "Apply and publish"; overridable
  conflicts acknowledged in the dialog; blocking conflicts listed (§5.6).
- Error codes the UI must handle: `DRAFT_CHANGED`, `BLOCKING_CONFLICTS`,
  `UNACKNOWLEDGED_CONFLICTS`, `EFFECTIVE_DATE_PASSED`, `TERM_PUBLISHED`
  (REPLACE requested on a published term), `NO_DEMAND`.

## 10. Open questions for the owner

1. **Published terms:** v1 only adds missing lessons from a date (FILL).
   Do you also want a full re-plan of a running term from a date, moving
   existing groups? It cancels or moves many lessons at once.
2. **Teacher qualification:** is "levels a teacher may teach"
   (`TeacherLevel`) the right rule for choosing teachers, or should every
   demand row name its teacher (no `TeacherLevel` at all)?
3. **Run time:** is waiting up to ~10 s on the Generate screen acceptable,
   or do you want background runs with a progress bar (a job table and
   polling; more moving parts)?
4. **Weights:** fixed in code for v1 (§3.3), or should admins tune them
   (e.g. "minimise teacher gaps" vs "keep last term's times")?
5. **Teacher daily maximum:** soft (as proposed) or a hard limit? And do you
   need a weekly maximum (contract hours) too?
6. **Online rooms:** never shared by the generator (as proposed), or may two
   online lessons share one room?
