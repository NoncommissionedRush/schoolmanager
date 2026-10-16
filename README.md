# School Manager

Management system for a language school (designed to support other school
types later). Three roles: **admin**, **teacher** and **student**. Covers
timetables (recurring slots → dated lessons), group and 1-on-1 lessons,
lesson logs with homework, internal teacher notes, absences and replacement
lessons.

**Stack:** Next.js (App Router) + TypeScript (strict), PostgreSQL + Prisma,
Tailwind CSS + shadcn/ui, next-intl, Vitest, Playwright. Package manager: pnpm.

## Run locally

Prerequisites: Node.js 22 (see `.nvmrc`), pnpm 10 (`corepack enable`), Docker.

```bash
pnpm install                 # also generates the Prisma client
cp .env.example .env         # DATABASE_URL + AUTH_SECRET for local dev
docker compose up -d --wait  # Postgres 16 on localhost:5432
pnpm db:migrate              # apply migrations
pnpm db:seed                 # demo data
pnpm dev                     # http://localhost:3000
```

Stop the database with `docker compose down` (add `-v` to wipe its data).

Upgrading an existing local database: databases created before the CARM-17
schema (PR #4) need `pnpm db:reset`; otherwise `pnpm db:migrate && pnpm db:seed`
picks up new migrations and demo passwords. `.env` files from before CARM-19
need an `AUTH_SECRET` line (copy it from `.env.example`).

### Demo data

`pnpm db:seed` is idempotent and creates "Demo Language School": 1 admin,
8 teachers, 40 students, levels A1–C1, group and 1-on-1 lessons, rooms, the
"Autumn 2026" term with holidays and a published timetable with generated
lessons. Data model: `docs/architecture/data-model.md`. It also seeds a
small second school, "Northbridge Language Academy", used by the e2e
permission suite (`docs/architecture/testing.md`).

Sign in at http://localhost:3000/login — every seeded user has the password
**`demo-password`**:

| Role    | Email                            | Lands on   |
| ------- | -------------------------------- | ---------- |
| Admin   | `admin@demo-school.test`         | `/admin`   |
| Teacher | `jana.novakova@demo-school.test` | `/teacher` |
| Student | `adam.kollar@demo-school.test`   | `/student` |

All other users are `first.last@demo-school.test` without diacritics (see
`prisma/seed/data.ts`). Passwords are set by admins in v1 — there is no
"forgot password" flow yet: an admin sets or resets them under _Teachers_,
_Students_ or _Settings › Administrators_ (_Set new password_).

### Admin screens

Signed in as admin: _People › Teachers / Students_, _Academics › Courses &
groups / Skill levels_ and _Settings_ (school, terms & holidays, rooms,
administrators). Spec: `docs/design/admin-data.md`; server code in
`src/server/admin/`.

### Notifications and substitutes

Every role has a bell in the header and an inbox at `/{role}/notifications`
(in-app only; rows older than 90 days are removed, also by
`pnpm notifications:purge`). Admins arrange cover under _Schedule ›
Substitutions_: in the demo data Peter Horváth is away on 27 Oct, so his
lesson is listed under _Needs cover_. Teachers see their cover under _Me ›
Substitutions_. Rules: `docs/architecture/phase5-rules.md`; spec:
`docs/design/notifications-substitutes.md`.

### Database tests

Unit tests run without a database. The service tests that need Postgres
(`*.db.test.ts`) are skipped unless `SCHEDULING_TEST_DATABASE_URL` points at a
**separate**, migrated database — they create and delete their own schools:

```bash
docker compose exec db createdb -U schoolmanager schoolmanager_test
DATABASE_URL=postgresql://schoolmanager:schoolmanager@localhost:5432/schoolmanager_test pnpm db:migrate:deploy
SCHEDULING_TEST_DATABASE_URL=postgresql://schoolmanager:schoolmanager@localhost:5432/schoolmanager_test pnpm test
```

## Scripts

| Script                     | What it does                                    |
| -------------------------- | ----------------------------------------------- |
| `pnpm dev`                 | Start the dev server on http://localhost:3000   |
| `pnpm build`               | Production build                                |
| `pnpm start`               | Serve the production build                      |
| `pnpm lint`                | ESLint                                          |
| `pnpm format`              | Format with Prettier (`format:check` to verify) |
| `pnpm typecheck`           | Generate route types and run `tsc --noEmit`     |
| `pnpm test`                | Unit tests (Vitest)                             |
| `pnpm test:e2e`            | End-to-end tests (Playwright; needs the DB up)  |
| `pnpm db:migrate`          | Create/apply migrations in development          |
| `pnpm db:migrate:deploy`   | Apply existing migrations (CI / production)     |
| `pnpm db:seed`             | Seed demo data                                  |
| `pnpm db:reset`            | Drop, re-migrate and re-seed the database       |
| `pnpm db:generate`         | Regenerate the Prisma client                    |
| `pnpm notifications:purge` | Delete notifications older than 90 days         |

First Playwright run: `pnpm exec playwright install chromium`.

## Project layout

```
src/app         Next.js routes (UI, route handlers, server actions)
src/server      Domain logic — pure, testable functions
src/components  React components (shadcn/ui in src/components/ui)
src/lib         Shared utilities (e.g. Prisma client in src/lib/db.ts)
src/i18n        next-intl request config, locales, named formats
messages/       UI message catalogs, one JSON file per feature namespace
src/generated   Generated Prisma client (git-ignored)
prisma/         Schema, migrations, seed
e2e/            Playwright tests
docs/           Project docs and design specs
```

## Authentication & roles

Auth.js (email + password, JWT session cookie). Each user has one role per
school — admin, teacher or student — with its own area: `/admin`, `/teacher`,
`/student`. `src/proxy.ts` sends signed-out users to `/login` and answers other
roles' areas with the 403 page; every page, route handler and server action
still checks the role itself:

```ts
import { getSchoolScopedDb, requireRole } from "@/server/auth/session";

const viewer = await requireRole("ADMIN", "TEACHER"); // login / 403 otherwise
const db = await getSchoolScopedDb(); // every query scoped to viewer.school.id
```

## Conventions

- Every tenant-owned table has `school_id` and every query is scoped by it.
- Authorization is enforced server-side, never only in the UI.
- All UI strings go through next-intl — see
  [docs/architecture/i18n.md](docs/architecture/i18n.md).

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch, commit and PR conventions.
