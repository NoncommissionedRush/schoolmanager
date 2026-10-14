# Testing

| Layer       | Where                       | Runs with                                                        |
| ----------- | --------------------------- | ---------------------------------------------------------------- |
| Unit        | `src/**/*.test.ts`          | `pnpm test` (no database)                                        |
| Database    | `src/**/*.db.test.ts`       | `pnpm test` with `SCHEDULING_TEST_DATABASE_URL` set (see README) |
| End-to-end  | `e2e/**/*.spec.ts`          | `pnpm test:e2e` (database migrated and seeded)                   |
| Permissions | `e2e/permissions/*.spec.ts` | part of `pnpm test:e2e`, also in CI                              |

CI (`.github/workflows/ci.yml`) runs all of them except the opt-in database
tests: it migrates and seeds Postgres, builds the app and runs Playwright
against `pnpm start`.

## Permission suite (`e2e/permissions/`)

The project's access rules are enforced by tests, not only by review:

- **Tenant isolation** (`cross-school.spec.ts`): an admin, teacher or student
  of one school can't read or change another school's data — through pages,
  filters and search params, guessed detail-page ids, or server actions
  called directly with the other school's ids. It runs both ways.
- **Role boundaries** (`roles.spec.ts`): teachers and students get the
  forbidden page on every admin page and can't run any admin server action;
  an admin demoted while signed in is refused by the pages and actions
  themselves (the proxy still trusts the old token); students see only their
  own groups' lessons and no classmates' names; teachers see only the
  lessons they teach or substitute.
- **Teacher notes** (`teacher-notes.spec.ts`): no note body reaches a
  student through any page they can open (dashboard, timetable, Homework
  tab, lesson pages), the RSC payload inlined in it, or an API route; the
  teacher and admin lesson pages that show notes are forbidden to them.
- **Teacher lessons** (`teacher-lessons.spec.ts`): a teacher opens only the
  lessons they teach or substitute — anything else, also another school's,
  renders "not found" — and the lesson page actions refuse those lessons
  without changing anything; students and admins get the forbidden page
  and can't run any teacher lesson action.
- **Lesson records** (`lesson-records.spec.ts`, Phase 2): on its own
  lessons, groups and a student who joined one group ten days ago and left
  another:
  - students open only lessons of their groups from joining until leaving,
    once started, in published terms — anything else (other groups, before
    joining, after leaving, future, unpublished) is 404 — and no list,
    home card or timetable shows those lessons' log or homework;
  - teachers write only on lessons they teach or substitute (the substitute
    control is accepted), not before the start or on cancelled lessons, and
    can't edit or delete a colleague's notes;
  - admins read every lesson of their school, notes included, and can't run
    any teacher lesson action; students can't either, and no action
    response carries a note body to them;
  - none of it crosses schools: pages, list filters with the other school's
    ids, and every teacher or admin lesson action with its lesson and note
    ids.

  Every log, homework and note there carries a unique marker, so finding
  one in a response that shouldn't have it is the leak check.

Leak checks read the raw server response (`serverResponse` in
`fixtures.ts`), which includes the RSC payload, so data the client receives
but doesn't render still counts as a leak. Mutating checks compare a digest
of the target rows (or, for school B, the whole school) before and after.

### Two schools

`pnpm db:seed` also creates **Northbridge Language Academy**
(`prisma/seed/second-school.ts`): one admin, teacher and student, a group,
room, level, course, term with a holiday, a published timetable with
lessons, a teacher availability rule and a teacher note. Nothing in the demo
needs it; it exists so every tenant-owned table has rows in two schools. Its
names are distinct from the demo school's, so a leak shows up in page text.
Sign-ins (password `demo-password`): `admin@northbridge.test`,
`bruno.berger@northbridge.test`, `bianca.bauer@northbridge.test`.

### Calling server actions directly

`callAction(page, [file, exportName], args)` in `e2e/server-actions.ts` posts a
server action the way a crafted request would, with the cookies of the user
signed in on `page`. It looks the action id up in Next's
`server-reference-manifest.json` (`.next/server` after `pnpm build`,
`.next/dev/server` under `pnpm dev` once the page using it was compiled) and
encodes arguments like React does; wrap a form argument (at most one per
call) in `new FormFields({...})`. The CARM-28 admin-action spec uses the same
helper. It returns the HTTP status and the action's
`ActionResult`, or `null` when the action didn't run.

### Adding a case

- **New admin server action**: add it to `crossSchoolCases` in
  `action-cases.ts` (aimed at the target school's ids, with a form that
  passes validation so the id is the only reason to refuse), or to
  `unaimedCases` in `roles.spec.ts` if it takes no id. The coverage test in
  `roles.spec.ts` fails until every action under `src/app/admin/` is listed.
- **New admin page**: add it to `ADMIN_PAGES` in `cross-school.spec.ts` and
  `adminPages` in `roles.spec.ts`; detail pages take an id from `SchoolIds`.
- **New teacher server action**: add it to `teacherLessonCases` in
  `action-cases.ts`, aimed at the target's lesson, note or student. The
  coverage test in `lesson-records.spec.ts` fails until every action under
  `src/app/teacher/` is listed; it also fails if `src/app/student/` gets a
  server action (students write nothing yet), which then needs its own
  cases.
- **New teacher or student page**: add it to the role's page lists
  (`cross-school.spec.ts`, and `studentPaths` in `teacher-notes.spec.ts` for
  students). Student pages that show lessons also go into the list checks
  of `lesson-records.spec.ts`.
- **New tenant-owned table**: the school fingerprint picks it up
  automatically (every table with `school_id`). Seed a row for it in
  `second-school.ts` so the cross-school checks have something to find, and
  add its id to `schoolIds` in `fixtures.ts` if actions or pages take it.
- **Showing teacher notes somewhere**: read them through
  `findTeacherNotes` (`src/server/notes/teacher-notes.ts`), which refuses
  students; its unit test fails if anything else in `src/` reads the
  `TeacherNote` table. Add the new page to the student checks if a student
  can reach any variant of it.

Run only this suite: `pnpm test:e2e e2e/permissions`. Against a production
build (as in CI): `pnpm build && CI=1 pnpm test:e2e e2e/permissions`.
