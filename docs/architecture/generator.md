# Timetable generator (rules, CARM-53)

**Status: Phase 4, proposed. Nothing here is implemented yet.** Stage 2
(CARM-55) builds the schema, the engine and the service from this page;
stage 3 (CARM-56) the admin screens. The screens are specified in
`docs/design/timetable-generator.md` (CARM-54); §9 lists how the two were
reconciled. Where they still disagree, raise it on the issue rather than
picking one.

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
| `active`                                     | Inactive rows are kept but ignored by runs (the UI's per-row switch).                                                      |
| `lessonsPerWeek`                             | 1–14 units.                                                                                                                |
| `durationMinutes`                            | 15–600, a multiple of 5. Every unit of the row has this length.                                                            |
| `teacherMode`                                | `FIXED`: `teacherId` teaches every unit. `ANY_OF`: the generator picks **one** teacher for all units of the row (§2.2).    |
| `teacherId` / candidates                     | `FIXED`: `teacherId`. `ANY_OF`: one or more `TimetableDemandTeacher` rows; `teacherId` null.                               |
| `roomNeed`                                   | `ANY`, `PHYSICAL`, `ONLINE` or `SPECIFIC`. `SPECIFIC`: one of the rooms listed in `TimetableDemandRoom` (one = fixed).     |
| `minRoomCapacity`                            | Optional ("min seats" in the UI). Rooms need capacity ≥ max(enrolled students, this). Capacity-less online rooms fit.      |
| `preferredRoomId`                            | Soft (§3.3).                                                                                                               |
| `preferredWeekdays`                          | Soft. Empty = no preference.                                                                                               |
| `preferredStartMinute`, `preferredEndMinute` | Soft window the lessons should lie in, e.g. 16:00–20:00 for adults after work. Both or neither.                            |
| pins (`TimetableDemandPin`)                  | Up to `lessonsPerWeek` fixed times: weekday + start (+ optional room). A pinned unit is placed there or reported unplaced. |

The UX spec shows one row per group (one lesson length), which covers
almost every group; the schema allows several rows so "2 × 90 min + 1 ×
45 min with another teacher" needs no migration later. The engine treats
rows independently either way.

Pins live on the demand because they are a standing requirement ("this
group always meets Monday 17:00") that survives regenerating and copying to
the next term. Locks (§5.3) belong to one draft.

**Getting demand in.** Besides per-row editing, the service offers two bulk
sources (the UX spec decides the screens):

- `copyDemand(fromTermId, toTermId)`: copies rows of non-archived groups
  that have no demand in the target term yet. If the source term has no
  demand at all, it falls back to `demandFromSlots` (the UX spec's single
  "Copy from term" action).
- `demandFromSlots(termId, sourceTermId)`: derives rows from a term's live
  slots, for the first time a school uses the generator. Slots of a group
  are grouped by (teacher, duration); each group of slots becomes a row with
  `lessonsPerWeek` = count, the teacher fixed and the most used room as
  `preferredRoomId`. No pins.
- `bulkUpdateDemand(ids, field, value)`: one field (`lessonsPerWeek`,
  `durationMinutes`, `roomNeed`, `active`, …) set on N rows, validated per
  row, all or nothing.
- `precheckDemand(termId)`: the preflight of §4.2 step 3 alone, so the
  needs tab can flag rows that will certainly fail before a run.

Demand writes are last-write-wins per row (`updatedAt` returned); edits are
refused with `RUN_IN_PROGRESS` while a run of the term is running (§4.6),
because a run's input must not change under it.

Both return what they created and skipped (e.g. "archived group").

### 2.2 Who may teach what

The admin names the teachers: one fixed teacher, or an explicit "any of"
list per demand row (`TimetableDemandTeacher`). There is no qualification
table in v1. The UX spec prefills an "any of" list with the teachers who
taught the group's level in the previous term (derivable from slots); the
admin edits it. An `ANY_OF` row whose candidates are all archived, or that
has none, is `NO_ELIGIBLE_TEACHER` in preflight (§4.5). Any teacher is
allowed, qualified or not: the admin decided. A per-teacher "levels they
teach" list (`TeacherLevel`) can be added later without changing the
engine, which only ever sees a candidate list (open question 2).

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
| `OUTSIDE_SCHOOL_DAYS`, `OUTSIDE_SCHOOL_HOURS`     | overridable | **Hard**: only teaching weekdays and the school day window. Pins outside them are `PINNED_TIME_CONFLICT`   |
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
live in one constant, `GENERATOR_WEIGHTS`. Admins never see numbers.

**Preference levels.** Each run takes a level per code, as the UX spec's
Generate dialog shows them: **Off** = 0, **Low** = ⌈w / 2⌉, **Normal** = w
(default), **High** = 2 w, where w is the base weight below. Still integers,
so still exactly reproducible. The levels are stored on the run and the
draft and are part of the fingerprint (§5.5). Whether a change also becomes
the school's default (a `School.generatorPreferenceLevels Json?` column)
is open question 4; without it, every run starts from Normal.

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

**The score.** The engine minimises **penalty points** (the weighted total
above, at the run's levels). The admin sees a **quality score** derived
from it, 0–100 and higher is better, as the UX spec asks:

```
quality = floor(100 × 10·U / (10·U + penalty))     U = placed units (≥ 1)
```

0 penalty → 100; an average of 10 points per lesson → 50. It is monotone in
the penalty, integer and deterministic, and comparable between runs of the
same term (same U). It is not meant for comparing terms. Next to it the UI
shows the breakdown per code: level, **count** ("12 teacher gaps", "3
groups twice on one day"), points and share of the penalty, and the ids of
the draft slots each code hits (so _Show_ can highlight them). The breakdown
is also available per teacher and group. The result stores the quality and
penalty after construction and at the end, and the draft keeps the previous
run's quality, so the UI can show "▲ +5".

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
   overlapping terms), the demand, the teacher candidates and settings, the
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

- Same input + same seed + same iteration count → the same draft, byte for
  byte, whatever the order of the input arrays.
- The PRNG is seeded (`seed`, a 31-bit integer stored on the run and the
  draft). Generate and "Regenerate…" reuse the draft's seed; "Try another
  variant" draws a new one; the UX spec's _Use seed…_ sets it explicitly.
- The budget is **iterations** (`maxIterations`), which is deterministic.
  The admin picks a preset; each preset is an iteration budget plus a
  wall-time safety cap:

  | Preset (UX spec)   | `maxIterations` | Cap (`timeLimitMs`) |
  | ------------------ | --------------: | ------------------: |
  | Quick              |          50 000 |                10 s |
  | Standard (default) |         200 000 |                30 s |
  | Thorough           |       1 000 000 |               2 min |

  Stage 2 tunes the iteration numbers so the realistic dataset finishes
  Standard in ≤ 3 s (§6.2); the caps are only for very large or dense
  schools. The UX spec's 30 s / 2 min / 5 min labels become "up to 10 s /
  30 s / 2 min".

- A run can end by `stoppedBy`: `"iterations"` (normal), `"time"` (cap),
  `"admin"` (_Stop and keep best_) or `"cancelled"` (nothing kept).
  Whatever stopped it, the result records the **iterations actually done**,
  and replaying with that seed and `maxIterations` = that count gives the
  same draft. So every kept draft is reproducible, even a stopped one.
  Tests use iteration budgets only.
- The result records the seed, preset, levels, iterations, duration,
  `stoppedBy`, and the penalty and quality after construction and at the
  end.

### 4.5 Unplaced demand and reasons

Each unplaced unit gets one reason code with ICU params
(`scheduling.generator.reasons.<CODE>`) and refs to link, the same shape
as a `Conflict`. The codes are the UX spec's (§5.7 there), made precise:

| Code                     | When                                                                                                                             | Params / refs                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `GROUP_ARCHIVED`         | Preflight: the group is archived                                                                                                 | `group`                           |
| `NO_ELIGIBLE_TEACHER`    | Preflight: an `ANY_OF` row with no usable (non-archived) candidate, or a fixed teacher who is archived                           | `group`                           |
| `DURATION_TOO_LONG`      | Preflight: longer than the school day window                                                                                     | `duration`, `schoolHours`         |
| `PINNED_TIME_CONFLICT`   | Preflight: the pin is outside school days/hours or clashes with the fixed context                                                | `time`; the pin's conflicts       |
| `NO_ROOM`                | Preflight: no non-archived room of the need and capacity exists. Or search: rooms are the sole blocker at most candidate times   | `roomKind`, `seats`; blockers     |
| `NO_TEACHER_TIME`        | Search: the teacher (every candidate, for `ANY_OF`) being busy or weekly-unavailable is the sole blocker at most candidate times | `teacher`, `minutes`; blockers    |
| `STUDENT_CLASH`          | Search: students in other groups are the sole blocker at most candidate times                                                    | `count`, top 3 students; blockers |
| `NO_COMMON_TIME`         | Search: no candidate time has a single blocker; teacher, students and rooms are never free together                              | `teacher`, `seats`, `students`    |
| `TAKEN_BY_OTHER_LESSONS` | Search: some times are free in the fixed context, but other draft lessons occupy all of them and repair could not move them      | blockers, suggestions             |
| `TIME_LIMIT`             | The time cap fired before construction reached this unit                                                                         | —                                 |
| `REMOVED_BY_ADMIN`       | The admin deleted the unit's draft slot (§5.3); kept until the next run                                                          | —                                 |
| `INTERNAL_CHECK_FAILED`  | Step 7 found a generator-hard conflict (a bug; never expected)                                                                   | the conflicts                     |

**Which search code.** For every candidate time (weekday × start on the
grid, inside school days and hours, with occurrences) the explainer
collects the blocking categories: _teacher_, _students_ (including the
group's own lessons), _room_, _draft_ (only other unlocked draft slots).
If some candidate is blocked by _draft_ alone → `TAKEN_BY_OTHER_LESSONS`.
Otherwise the category that is the **sole** blocker at the most candidates
wins (ties: teacher, students, room); if no candidate has a sole blocker →
`NO_COMMON_TIME`.

**Blocker breakdown**: over all candidate times, how many are blocked by
the teacher being busy, the teacher's weekly unavailability, students being
busy (the top 3 students by count, by name), the group's own lessons, or no
room being free. Example: "No common free time: teacher busy at 38 times,
unavailable at 22, students Ana K. and Petr S. busy at 10".

**Closest** (the UX spec's near miss): the candidate placement with the
fewest generator-hard conflicts from `checkSlot` (ties: weekday, start,
room id), with those conflicts as the editor renders them. "Place by hand"
prefills it; the admin can then acknowledge the overridable ones.

**Suggestions** (up to 3): candidate times blocked by exactly one movable
thing, e.g. "Tue 17:00 would work if Group B2-Evening's lesson moved"
(→ unlock/move that draft slot), "… if Teacher X were available"
(→ edit availability), "… with a room for 12" (→ room). They point at the
data to change; they never change it.

### 4.6 Running inside the app

A run is a **`GeneratorRun`** row (§8), one running per term at a time
(partial unique index), started by `startRun` and executed on the server
after the request returns. This gives the UX spec's run screen: it survives
a reload, another admin sees the same progress, and it can be stopped.

- **Executing.** The engine is synchronous and CPU-bound, so
  `generateTimetableSteps(input)` is a generator function that yields every
  ~2 000 iterations, and the service drives it with `await setImmediate`
  between steps so other requests keep being served. Its output is
  identical to the synchronous `generateTimetable` (tested). No worker
  bundling, one code path; a worker thread can come later if a deployment
  target needs it.
- **Progress.** At most every 500 ms the runner writes
  `{ phase: "placing" | "improving", placed, total, quality, elapsedMs,
heartbeatAt }` to the row. The UI polls `getRun` every 2 s.
- **Stop and cancel.** `stopRun` sets `stopRequested = "keep"` (only in the
  improving phase) or `"cancel"`; the runner checks it at each yield. Keep
  saves the best draft so far (`stoppedBy: "admin"`); cancel saves nothing.
- **Crashes.** No deployment target means no supervisor: if the Node
  process dies mid-run, the row stays `RUNNING` with a stale heartbeat.
  Any read that finds `heartbeatAt` older than 30 s marks it `FAILED`
  (`RUN_INTERRUPTED`) and frees the term; the previous draft is untouched.
- **Locking inputs.** While a term has a running run, demand writes and
  draft edits of that term are refused with `RUN_IN_PROGRESS` (the UX spec's
  "Locked while generating").
- **Saving.** On completion the runner saves the draft as §5.7 describes
  and marks the run `DONE` (or `FAILED` with an error code). The run row
  keeps the result summary and is the audit trail of runs; old runs are
  kept (they are small).

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

The term's state decides which modes the Generate dialog offers:

| Term state                             | Mode            | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Not published, no slots                | **REPLACE**     | Generate everything.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Not published, has slots (manual work) | **REPLACE**     | The admin chooses: **keep them as they are** (default: copied into the draft as locked `IMPORTED` slots) or **let the generator rearrange them** (copied unlocked: construction starts from them and the search may move them). Live slots of this term are never in the fixed context in REPLACE mode: the draft is the term's whole timetable, and applying replaces it.                                                           |
| Published (has lessons)                | **FILL**        | From an **effective date** _D_. Every live slot in effect on or after _D_ stays as it is and is part of the fixed context; demand units they cover count as placed. The generator only places the **remaining** demand (new groups, more lessons), as new slots from _D_. No existing lesson changes.                                                                                                                                |
| Published (has lessons)                | **REPLAN_FROM** | From an effective date _D_, the generator re-plans the term's whole weekly timetable. The live slots in effect on _D_ are copied into the draft as unlocked `IMPORTED` slots (the admin may lock some), and `TIME_CHANGED` is measured against them instead of the previous term, at **High** by default, so the draft moves as few lessons as it can. Applying ends changed slots on _D_ − 1 and starts the new ones on _D_ (§5.6). |

_D_ defaults to the next Monday on or after tomorrow, must be a date inside
the term and is never today or earlier (the UX spec's default, with
"tomorrow" so that today's lessons are never touched). FILL is the default
for a published term; REPLAN_FROM is offered next to it (open question 1
asks whether the owner wants it in v1; the rules are complete either way).

Why REPLAN_FROM is safe enough to offer: it changes nothing the editor
cannot already do slot by slot. Applying it is exactly a batch of the
editor's **End** and **Create** actions from _D_ (scheduling.md
§"Published term"), so lessons are reconciled by the same rule: untouched
future lessons are deleted; lessons with a log, notes, absences,
replacements, makeup credits or a substitute are **cancelled**
(`TIMETABLE_CHANGED`) and stay visible; replacement bookings on them are
released with grace as replacements.md already defines (this answers the
UX spec's Q7 without a new rule). Unchanged slots are kept, not split.

In FILL mode the kept live slots are not copied into the draft; they are
read live each time, so the draft cannot get out of step with them.

Matching for "counts as placed" (imported and FILL-kept slots): demand
units of a group are matched to its slots in order (teacher equal when the
demand fixes one or one of the `ANY_OF` candidates, duration equal), each
slot used once. Slots matching no demand stay as fixed bookings ("not
managed by demand"); the review lists them.

### 5.3 Editing and locking

- Each draft slot has `locked` and `origin` (`GENERATED`, `MANUAL`,
  `PINNED`, `IMPORTED`), the UX spec's "source".
- The admin can move or re-room a slot, change its teacher (any teacher:
  the admin decides, as with pins), delete it (its unit becomes unplaced)
  or add a slot for an unplaced unit. Edits are
  checked with `checkSlot` against the fixed context plus the other draft
  slots: **blocking** conflicts are refused, as in the editor;
  **overridable** ones are allowed and shown, and acknowledged on apply.
  So a draft can hold a slot the generator would not make (e.g. in a
  teacher's weekly unavailability) when the admin wants it.
- An edited or added slot is locked automatically and becomes `MANUAL`;
  the admin can unlock it. A deleted slot's unit is unplaced with
  `REMOVED_BY_ADMIN` until the next run.
- Locked slots are fixed for the generator: never moved, re-roomed or
  re-assigned. A locked slot that conflicts after data changed stays put;
  its conflict is shown.

### 5.4 Regenerating the rest

"Regenerate…" keeps locked slots and re-places all unlocked units from
scratch with the draft's seed (same inputs → same result). Its option
"Also unlock slots I moved by hand" unlocks every `MANUAL` slot first. "Try another
variant" does the same with a new seed. Deleting a demand row removes its
unlocked draft slots and detaches its locked ones (`demandId` null,
origin `MANUAL`) in the same transaction.

### 5.5 Staleness

When a run finishes, the draft stores a **fingerprint**: SHA-256 of the
canonical (sorted) generator input, i.e. demand, teacher candidates, preference levels and
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

1. Reload the context. In FILL and REPLAN_FROM, refuse with
   `EFFECTIVE_DATE_PASSED` if _D_ ≤ today.
2. Build the would-be timetable. REPLACE: the term's slots are exactly the
   draft slots. FILL: the live slots plus the draft slots from _D_.
   REPLAN_FROM: the live slots ending on _D_ − 1 where they change, plus the
   draft slots from _D_.
3. `checkTimetable` on it. Any **blocking** conflict refuses with the fresh
   list (`BLOCKING_CONFLICTS`). Every **overridable** conflict of a draft
   slot must be in `acknowledgedConflictKeys` (`decideSave` per slot,
   keys prefixed with the draft slot id), else `UNACKNOWLEDGED_CONFLICTS`.
   A clash someone created meanwhile is never overridden blindly.
4. Write slots.
   - REPLACE (term has no lessons): live slots matched by `sourceSlotId`
     are updated in place, unmatched live slots deleted, the others created.
   - FILL: draft slots are created with `validFrom` = _D_; nothing else
     changes.
   - REPLAN_FROM: a live slot whose draft copy (by `sourceSlotId`) is
     identical in weekday, start, end, teacher and room stays as it is.
     Every other live slot in effect on _D_ is ended on _D_ − 1 (`endSlot`
     logic); every changed or new draft slot is created from _D_.
5. Lessons. REPLACE with `publish: true`: run the `publishTerm` logic in
   this transaction (it is split into `publishTermIn(tx, …)` for this; same
   checks, same `timetable.published` audit). REPLACE with `publish: false`:
   only the slots are written; the term stays a draft for further manual
   work in the editor (the UX spec's "only save the slots"). FILL and
   REPLAN_FROM: `planLessonSync` from _D_ for the touched slots, as the
   editor does: new lessons are generated, unwanted ones deleted or
   cancelled (§5.2).
6. Audit `timetable_draft.applied` (mode, _D_, counts of slots
   created/updated/ended/deleted and lessons created/deleted/cancelled,
   overridden conflicts, seed, quality), then delete the draft. The
   response carries the same counts.

**Preview.** `previewApply(draftId)` runs steps 1–5 in a transaction that
is always rolled back, and returns the counts and the affected teachers,
students and replacement bookings. It is the UX
spec's impact summary ("{ended} current slots end…, {removed} lessons
removed, {cancelled} kept as cancelled…"). Apply recomputes everything; the
preview is information, not a reservation.

### 5.7 Concurrency

- **A run does not hold the timetable lock.** It reads a snapshot, computes
  for up to `timeLimitMs`, then saves in a short transaction that locks the
  draft row and requires the `version` read at the start. Demand writes and
  draft edits are refused while it runs (§4.6), so this check only fires in
  races around start and end; then the result is discarded with
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
  a fixed teacher (`groupTeacher`), 20 % `ANY_OF` 2–3 candidates;
  some pins, preferred windows and rooms. `"dense"` = 3 units of 60–90 min
  per group (~180 units).
- daily maxima on half the
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
   arrays → the same result; `generateTimetableSteps` = `generateTimetable`;
   a run stopped after _k_ iterations equals a run with `maxIterations` = _k_.
4. **Locks:** with random subsets locked, locked slots come out unchanged;
   with everything locked, the output is the input.
5. **Accounting:** placed + unplaced = demand units; every slot matches its
   demand (duration, fixed teacher or one of its candidates, one teacher per row, room
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
9. **FILL and REPLAN_FROM:** new slots start on _D_; no live slot or lesson
   before _D_ changes; in FILL the kept slots are never moved; in
   REPLAN_FROM, with `TIME_CHANGED` at High and unchanged input, the draft
   equals the live timetable (nothing moves without a reason).
10. **Infeasible input:** a demand with no eligible teacher, no fitting
    room, an impossible pin or an over-full teacher gets the right reason
    and does not disturb the rest.
11. **Levels:** with every preference Off the penalty is 0 and quality 100;
    Off/Low/Normal/High give the weights of §3.3 exactly; the quality
    formula is monotone in the penalty.

DB tests (`generator-service.db.test.ts`, opt-in like the others): apply in
all three modes (and `previewApply` = what apply then does), refusal on a
clash created between generate and apply, run lifecycle (one running run
per term, `RUN_IN_PROGRESS` on demand edits, stop-and-keep, cancel, a stale
heartbeat marked `FAILED`),
`DRAFT_CHANGED` on concurrent edits, `EFFECTIVE_DATE_PASSED`, demand
deletion with locked slots, school scoping of every action.

## 7. Service API and access

Every action: `requireRole("ADMIN")`, `getSchoolScopedDb()`, zod validation,
`SchedulingError` codes translated by `scheduling.generator.errors.<code>`.
Draft and demand ids of another school are "not found".

| Function                                              | Purpose                                                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `listDemand` / `saveDemand` / `deleteDemand`          | Demand rows with pins, teacher candidates and rooms                                                           |
| `bulkUpdateDemand` / `copyDemand` / `demandFromSlots` | Bulk edits and sources (§2.1)                                                                                 |
| `precheckDemand`                                      | Preflight only (§2.1)                                                                                         |
| `startRun`                                            | Create the draft if needed (mode, _D_, keep/rearrange from §5.2) and start a run: preset, levels, seed (§4.6) |
| `getRun` / `stopRun`                                  | Progress; stop and keep best, or cancel (§4.6)                                                                |
| `getDraft`                                            | Draft, slots with conflicts, unplaced, score and breakdown, stale flag, latest run                            |
| `saveDraftSlot` / `deleteDraftSlot`                   | Edit, add, delete a draft slot (§5.3)                                                                         |
| `setDraftSlotsLocked`                                 | Lock / unlock several slots                                                                                   |
| `previewApply` / `applyDraft`                         | §5.6                                                                                                          |
| `discardDraft`                                        | §5.8                                                                                                          |

Audit actions: `timetable_demand.created|updated|deleted|copied`,
`timetable_run.started|stopped|finished|failed` (seed, preset, levels,
stoppedBy, placed/unplaced, quality), `timetable_draft.discarded`,
`timetable_draft.applied`, plus the existing `timetable.published`. Draft slot edits are not audited
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
  REPLAN_FROM
}

enum DraftSlotOrigin {
  GENERATED
  MANUAL
  PINNED
  IMPORTED
}

enum DemandTeacherMode {
  FIXED
  ANY_OF
}

enum DemandRoomNeed {
  ANY
  PHYSICAL
  ONLINE
  SPECIFIC
}

enum GeneratorRunStatus {
  RUNNING
  DONE
  CANCELLED
  FAILED
}

model TeacherProfile {
  // … existing fields …
  /// Soft daily maximum for the timetable generator; null = none.
  maxTeachingMinutesPerDay Int? @map("max_teaching_minutes_per_day")
}

/// What a group needs every week in a term (generator input).
model TimetableDemand {
  id                   String    @id @default(uuid()) @db.Uuid
  schoolId             String    @map("school_id") @db.Uuid
  termId               String    @map("term_id") @db.Uuid
  groupId              String    @map("group_id") @db.Uuid
  active               Boolean           @default(true)
  lessonsPerWeek       Int               @map("lessons_per_week")
  durationMinutes      Int               @map("duration_minutes")
  teacherMode          DemandTeacherMode @default(FIXED) @map("teacher_mode")
  /// FIXED only.
  teacherId            String?           @map("teacher_id") @db.Uuid
  roomNeed             DemandRoomNeed    @default(ANY) @map("room_need")
  minRoomCapacity      Int?              @map("min_room_capacity")
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
  preferredRoom Room?                @relation("DemandPreferredRoom", fields: [schoolId, preferredRoomId], references: [schoolId, id], onDelete: Restrict)
  pins          TimetableDemandPin[]
  teachers      TimetableDemandTeacher[]
  rooms         TimetableDemandRoom[]
  draftSlots    TimetableDraftSlot[]

  @@unique([schoolId, id])
  @@index([schoolId, termId])
  @@index([schoolId, groupId])
  @@map("timetable_demands")
}

/// ANY_OF candidates of a demand row.
model TimetableDemandTeacher {
  id        String @id @default(uuid()) @db.Uuid
  schoolId  String @map("school_id") @db.Uuid
  demandId  String @map("demand_id") @db.Uuid
  teacherId String @map("teacher_id") @db.Uuid

  school  School          @relation(fields: [schoolId], references: [id], onDelete: Cascade)
  demand  TimetableDemand @relation(fields: [schoolId, demandId], references: [schoolId, id], onDelete: Cascade)
  teacher TeacherProfile  @relation(fields: [schoolId, teacherId], references: [schoolId, id], onDelete: Restrict)

  @@unique([demandId, teacherId])
  @@unique([schoolId, id])
  @@map("timetable_demand_teachers")
}

/// SPECIFIC rooms of a demand row (one row = a fixed room).
model TimetableDemandRoom {
  id       String @id @default(uuid()) @db.Uuid
  schoolId String @map("school_id") @db.Uuid
  demandId String @map("demand_id") @db.Uuid
  roomId   String @map("room_id") @db.Uuid

  school School          @relation(fields: [schoolId], references: [id], onDelete: Cascade)
  demand TimetableDemand @relation(fields: [schoolId, demandId], references: [schoolId, id], onDelete: Cascade)
  room   Room            @relation(fields: [schoolId, roomId], references: [schoolId, id], onDelete: Restrict)

  @@unique([demandId, roomId])
  @@unique([schoolId, id])
  @@map("timetable_demand_rooms")
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
  /// FILL and REPLAN_FROM: new slots start on this date.
  effectiveFrom    DateTime? @map("effective_from") @db.Date
  seed             Int
  /// Off/Low/Normal/High per preference code, of the last run.
  preferenceLevels Json      @default("{}") @map("preference_levels")
  /// Optimistic concurrency for runs and edits.
  version          Int       @default(0)
  /// SHA-256 of the canonical generator input of the last run (staleness).
  inputFingerprint String?   @map("input_fingerprint")
  generatedAt      DateTime? @map("generated_at")
  /// Penalty and quality after construction and at the end, previous run's
  /// quality, breakdown per code with the slot ids each code hits.
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
  runs      GeneratorRun[]

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
  /// IMPORTED slots: the live slot this copies. No FK: the editor
  /// may delete that slot meanwhile; apply then creates it anew.
  sourceSlotId String?         @map("source_slot_id") @db.Uuid
  groupId      String          @map("group_id") @db.Uuid
  teacherId    String          @map("teacher_id") @db.Uuid
  roomId       String?         @map("room_id") @db.Uuid
  weekday      Int
  startMinute  Int             @map("start_minute")
  endMinute    Int             @map("end_minute")
  /// IMPORTED slots keep their range; generated ones are null (term or effective date).
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

/// One generator run; progress while RUNNING, result summary after.
model GeneratorRun {
  id            String             @id @default(uuid()) @db.Uuid
  schoolId      String             @map("school_id") @db.Uuid
  termId        String             @map("term_id") @db.Uuid
  draftId       String             @map("draft_id") @db.Uuid
  status        GeneratorRunStatus @default(RUNNING)
  /// "keep" | "cancel", set by stopRun, read by the runner at each yield.
  stopRequested String?            @map("stop_requested")
  seed          Int
  preset        String
  maxIterations Int                @map("max_iterations")
  timeLimitMs   Int                @map("time_limit_ms")
  levels        Json
  /// { phase, placed, total, quality, elapsedMs } while running.
  progress      Json?
  heartbeatAt   DateTime           @default(now()) @map("heartbeat_at")
  /// iterations, durationMs, stoppedBy, placed, unplaced, penalty, quality.
  result        Json?
  errorCode     String?            @map("error_code")
  startedById   String?            @map("started_by_id") @db.Uuid
  startedAt     DateTime           @default(now()) @map("started_at")
  finishedAt    DateTime?          @map("finished_at")

  school    School         @relation(fields: [schoolId], references: [id], onDelete: Cascade)
  term      Term           @relation(fields: [schoolId, termId], references: [schoolId, id], onDelete: Cascade)
  draft     TimetableDraft @relation(fields: [schoolId, draftId], references: [schoolId, id], onDelete: Cascade)
  startedBy User?          @relation(fields: [startedById], references: [id], onDelete: SetNull)

  @@unique([schoolId, id])
  @@index([schoolId, termId, startedAt])
  @@map("generator_runs")
}
```

Back-relations on `School`, `Term`, `Group`, `Room`, `TeacherProfile` and `User` are
added as usual. CHECKs in the migration:

- `timetable_demands`: `lessons_per_week BETWEEN 1 AND 14`;
  `duration_minutes BETWEEN 15 AND 600 AND duration_minutes % 5 = 0`;
  `(teacher_mode = 'FIXED') = (teacher_id IS NOT NULL)`; `min_room_capacity IS NULL OR
min_room_capacity >= 1`; `preferred_weekdays <@ ARRAY[1,2,3,4,5,6,7]`;
  preferred minutes both null, or `0 <= start < end <= 1440`.
- `timetable_demand_pins`: `weekday BETWEEN 1 AND 7`,
  `start_minute BETWEEN 0 AND 1439`. "At most `lessons_per_week` pins" is
  cross-row; the service enforces it.
- `timetable_drafts`: `(mode <> 'REPLACE') = (effective_from IS NOT NULL)`.
- `generator_runs`: partial unique index on `(school_id, term_id) WHERE
status = 'RUNNING'` (one running run per term); `stop_requested IN
('keep', 'cancel')` or null. "`ANY_OF` has ≥ 1 candidate" and
  "`SPECIFIC` has ≥ 1 room" are cross-row; the service enforces them.
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

## 9. Reconciled with the UX spec (CARM-54, PR #30)

The Designer's spec (`docs/design/timetable-generator.md`) was written in
parallel and lists its assumptions in its §9; that spec says this page wins
where they differ. Most assumptions are adopted as they are. Where this
page decides differently, the spec needs the change in the last column.

| Topic                           | UX spec assumed                                                                                 | Rules decision                                                                                                                                                              | Change to the UX spec                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Demand row                      | One row per group, one length, fixed or "any of" teachers, room need, min seats, pins, `active` | Adopted (§2.1). The schema allows several rows per group; v1 screens may keep one                                                                                           | None                                                                                        |
| Teacher eligibility             | "Any of" a list                                                                                 | Adopted; no `TeacherLevel` table in v1 (§2.2)                                                                                                                               | Prefill "any of" from last term's teachers of the level                                     |
| Bulk / copy / pre-check         | Bulk set, copy from term (derive from slots), pre-check                                         | Adopted (§2.1)                                                                                                                                                              | None                                                                                        |
| Run                             | Server-side, one per term, progress, stop/cancel, seed, audited                                 | Adopted: `GeneratorRun` with polling (§4.6)                                                                                                                                 | None                                                                                        |
| Time limit                      | Quick 30 s · Standard 2 min · Thorough 5 min                                                    | Iteration presets with caps 10 s / 30 s / 2 min; realistic data finishes Standard in ≤ 3 s (§4.4)                                                                           | Labels "up to 10 s / 30 s / 2 min"; the time-based bar ends early when the budget is done   |
| Stop                            | Stop and keep best (improving), cancel (placing)                                                | Adopted; a stopped run stays reproducible (§4.4)                                                                                                                            | None                                                                                        |
| Preferences                     | Off/Low/Normal/High per preference                                                              | Adopted: 0, ⌈w/2⌉, w, 2w (§3.3). All 12 codes have a level                                                                                                                  | List all 12 codes (group them if needed); "school defaults" waits for owner Q4              |
| Score                           | 0–100, breakdown with counts, change vs previous                                                | Adopted: quality = ⌊100·10U / (10U + penalty)⌋, plus per-code count, points and slot ids (§3.3)                                                                             | None                                                                                        |
| Unplaced reasons                | The 8 codes of its §5.7, closest option                                                         | Adopted those codes with exact rules, plus `GROUP_ARCHIVED`, `DURATION_TOO_LONG`, `TAKEN_BY_OTHER_LESSONS`, `INTERNAL_CHECK_FAILED`; closest = fewest hard conflicts (§4.5) | Add copy for the 4 extra codes; `NO_ELIGIBLE_TEACHER` means "no usable teacher in the row"  |
| Draft slots                     | `locked`, `source` GENERATED/MANUAL/PINNED/IMPORTED, auto-lock on move                          | Adopted (§5.3); deleting a slot gives `REMOVED_BY_ADMIN`                                                                                                                    | None                                                                                        |
| Draft term with slots           | Keep locked / let the generator rearrange                                                       | Adopted (§5.2)                                                                                                                                                              | None                                                                                        |
| Published term                  | Apply from a date: changed slots end the day before, impact first                               | Two modes: **FILL** (add missing lessons only; default) and **REPLAN_FROM** (the spec's flow), both from _D_ ≥ tomorrow (§5.2)                                              | Add the mode choice to the Generate dialog; default date "next Monday on or after tomorrow" |
| Impact preview                  | Nice to have                                                                                    | `previewApply` returns the counts (§5.6)                                                                                                                                    | None                                                                                        |
| Replacement bookings (UX Q7)    | Open                                                                                            | Existing rule: cancelled lessons release bookings with grace (replacements.md)                                                                                              | Answer Q7 with that                                                                         |
| Concurrent demand edits (UX Q8) | Last write wins per row                                                                         | Adopted; edits refused while a run is running (§2.1)                                                                                                                        | None                                                                                        |
| Out of date                     | Draft records what it was built from                                                            | Fingerprint (§5.5)                                                                                                                                                          | None                                                                                        |

Error codes the UI must handle: `RUN_IN_PROGRESS`, `RUN_INTERRUPTED`,
`DRAFT_CHANGED`, `BLOCKING_CONFLICTS`, `UNACKNOWLEDGED_CONFLICTS`,
`EFFECTIVE_DATE_PASSED`, `TERM_PUBLISHED` (REPLACE requested on a published
term), `NO_DEMAND`.

## 10. Open questions for the owner

1. **Published terms:** FILL (add missing lessons from a date) is the
   default. Should REPLAN_FROM (re-plan the whole week from a date, as the
   UX spec designs it) ship in v1 too? It only does what the editor already
   allows slot by slot, but it changes many students' routines at once.
2. **Teacher choice:** is an explicit "any of" list per group enough, or do
   you want a per-teacher "levels they teach" list the generator uses
   automatically?
3. **Teacher daily maximum:** soft (as proposed) or a hard limit? Do you
   need a weekly maximum (contract hours) too?
4. **Preference levels:** should a change in the Generate dialog become the
   school's default, or apply to one run only? (Same as UX spec Q4.)
5. **Online rooms:** never shared by the generator (as proposed), or may two
   online lessons share one room?
6. **Preferred time of day** (UX spec Q3): covered by the demand's
   preferred window and weekdays. Is that enough, or do you want named
   periods (morning, afternoon, evening)?
