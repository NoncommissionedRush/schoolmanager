# One school per user (decision)

**Decided by the project owner on 2026-10-14 (CARM-33).** Replaces the
CARM-29 proposal for users who belong to several schools; that proposal and
its "home school" question no longer apply.

## Decision

Every user belongs to **exactly one school**. There are no multi-school
users.

- A `User` has one `Membership`, which holds their school and their role
  (`ADMIN` / `TEACHER` / `STUDENT`).
- The same person in two schools needs two accounts with two different
  emails. `User.email` stays globally unique, so an email used in another
  school is "already used" (design `admin-data.md` Q2).
- **P6 "multi-school"** means several schools in one installation, each with
  its own users. It does not mean users across schools.

## What school admins may do

Nobody outside the school shares a user record, so a school admin manages
their school's users fully, through `src/server/admin/people/service.ts`:

| Function               | Writes on `User`   | Effect                      |
| ---------------------- | ------------------ | --------------------------- |
| `updatePersonIdentity` | `name`, `email`    | renamed / new sign-in email |
| `setPassword`          | `passwordHash`     | new password                |
| `archivePerson`        | `deletedAt = now`  | can't sign in, signed out   |
| `restorePerson`        | `deletedAt = null` | can sign in again           |

All of them first check that the user is a member of the admin's school
(`findMember`), so an admin can't reach a user of another school.

## How it is enforced

- **Database:** unique `memberships.user_id` (`@@unique([userId])` on
  `Membership`). A second membership for the same user fails with a unique
  violation, whatever code path tries it.
- **Application:** `assertEmailFree` (`people/service.ts`) refuses an email
  that exists anywhere, also in another school, with
  `people.error.emailTaken`. So creating a person always creates a new user
  with its first and only membership.
- **Sign-in:** `verifyCredentials` (`src/server/auth/credentials.ts`) signs
  the user in to the school of their only membership; there is no school
  picker.
- `User` itself has no `school_id`: sign-in looks the user up by email before
  a school is known. The school-scoped client still refuses to read a user's
  relations (see `src/server/db/school-scope.ts`), because a user reached
  through a plain FK (e.g. an audit actor) may belong to another school.

## Consequences

- No per-membership archive, no "home school", no read-only identity for
  shared users: `User.deletedAt` remains the archive flag.
- If the product ever needs one person in several schools, revisit this
  record first: the unique index, sign-in (school choice) and the admin
  writes above all assume one school per user.
