# Contributing

## Branches

- `main` is always releasable. Never force-push it.
- One branch per issue, named `<type>/<ISSUE-KEY>-<short-slug>`, e.g.
  `feat/CARM-17-database-schema`.
- Don't rewrite branches someone else is working on.

## Commits

- Small, focused commits using [Conventional Commits](https://www.conventionalcommits.org/):
  `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`, `ci:`.
- Imperative mood, e.g. `feat: add timetable slot form`.

## Pull requests

- Open against `main`; put the issue key in the title, e.g.
  `CARM-17: Database schema & seed data`.
- Describe what changed, how it was tested, and any deviation from the design
  spec in `docs/design/`.
- Before requesting review run locally and report the results:

  ```bash
  pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e
  ```

- PRs are reviewed and merged by the QA & Review engineer.

## Code rules

- Domain logic goes in `src/server/` as pure, testable functions — not inside
  React components. Cover it with Vitest tests next to the code (`*.test.ts`).
- Every tenant-owned table carries `school_id`; every query is scoped by it.
- Authorization is enforced server-side. Teacher internal notes are never
  readable by students.
- All user-facing strings go through the i18n layer (next-intl); `pnpm lint`
  rejects hard-coded UI text. See `docs/architecture/i18n.md`.
- Add a Playwright test for the main happy path of each feature.
