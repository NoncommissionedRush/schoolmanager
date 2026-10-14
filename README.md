# School Manager

Management system for a language school (designed to support other school
types later). Three roles: **admin**, **teacher** and **student**. Covers
timetables (recurring slots → dated lessons), group and 1-on-1 lessons,
attendance, lesson logs, absences and replacement lessons.

**Stack:** Next.js (App Router) + TypeScript (strict), PostgreSQL + Prisma,
Tailwind CSS + shadcn/ui, next-intl, Vitest, Playwright. Package manager: pnpm.

## Run locally

Prerequisites: Node.js 22+, pnpm 10 (`corepack enable`), Docker.

```bash
pnpm install                 # also generates the Prisma client
cp .env.example .env         # DATABASE_URL for the docker compose Postgres
docker compose up -d --wait  # Postgres 16 on localhost:5432
pnpm db:migrate              # apply migrations
pnpm db:seed                 # demo data
pnpm dev                     # http://localhost:3000
```

Stop the database with `docker compose down` (add `-v` to wipe its data).

## Scripts

| Script                   | What it does                                    |
| ------------------------ | ----------------------------------------------- |
| `pnpm dev`               | Start the dev server on http://localhost:3000   |
| `pnpm build`             | Production build                                |
| `pnpm start`             | Serve the production build                      |
| `pnpm lint`              | ESLint                                          |
| `pnpm format`            | Format with Prettier (`format:check` to verify) |
| `pnpm typecheck`         | Generate route types and run `tsc --noEmit`     |
| `pnpm test`              | Unit tests (Vitest)                             |
| `pnpm test:e2e`          | End-to-end tests (Playwright; needs the DB up)  |
| `pnpm db:migrate`        | Create/apply migrations in development          |
| `pnpm db:migrate:deploy` | Apply existing migrations (CI / production)     |
| `pnpm db:seed`           | Seed demo data                                  |
| `pnpm db:reset`          | Drop, re-migrate and re-seed the database       |
| `pnpm db:generate`       | Regenerate the Prisma client                    |

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

## Conventions

- Every tenant-owned table has `school_id` and every query is scoped by it.
- Authorization is enforced server-side, never only in the UI.
- All UI strings go through next-intl — see
  [docs/architecture/i18n.md](docs/architecture/i18n.md).

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch, commit and PR conventions.
