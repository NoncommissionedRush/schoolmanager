# Writes to the global `User` from a school (proposal, CARM-29)

**Status: proposed, waiting for the project owner's approval. Nothing below is
implemented.** Needs a decision before P6 (multi-school).

## Problem

`User` is global (one person can belong to several schools, see
[data-model.md](data-model.md#tenancy)). School admins write it today through
`src/server/admin/people/service.ts`:

| Function               | Writes on `User`   | Effect in every school the user belongs to |
| ---------------------- | ------------------ | ------------------------------------------ |
| `updatePersonIdentity` | `name`, `email`    | renamed / new sign-in email                |
| `setPassword`          | `passwordHash`     | new password                               |
| `archivePerson`        | `deletedAt = now`  | can't sign in anywhere                     |
| `restorePerson`        | `deletedAt = null` | can sign in everywhere again               |

So an admin of school A could rename, lock out or take over (reset the
password of) a person who also belongs to school B. v1 can't get there:
`assertEmailFree` refuses an email that exists in another school (design
`admin-data.md` Q2), so every user has exactly one membership. P6 lifts that
restriction, and then the writes above cross schools.

## Proposed rule

A school admin may only change what belongs to their school. What belongs to
the person is changed by the person, or by a school admin only while the
person belongs to no other school.

1. **Archive and restore are per membership.** Add
   `Membership.archivedAt` (nullable). `archivePerson` / `restorePerson` set
   and clear it on the admin's school's membership; `User.deletedAt` is no
   longer written by school admins (kept for a future platform-level
   "disable account" and for existing rows).
   - Sign-in skips archived memberships; with none left, sign-in returns
     `disabled` as today. `getSessionContext` (`access.ts`) treats an archived
     membership like a missing one, so an archived person is signed out of
     that school on the next request, as now.
   - All "active person" queries switch from `user: { deletedAt: null }` to
     `archivedAt: null` on the membership (admin lists, last-active-admin
     check, timetable pickers).
   - Archive side effects (leave groups, teacher slot check) are already
     per school and stay as they are.
2. **Identity (name, email) and password: single-school users only.**
   `updatePersonIdentity` and `setPassword` first count the user's
   memberships in other schools (global client). If there are any, they
   throw a blocked error: "{name} also belongs to another school, so only
   they can change their name, email or password." The edit form shows the
   fields read-only with that note.
   - The person changes these themselves on a self-service account page
     (P6, needs current-password confirmation). A password reset by email
     link (P5 notifications) covers a forgotten password.
   - Counting includes archived memberships in other schools: the other
     school may restore them.
3. **Joining a second school** (the P6 flow that replaces Q2's "already
   used") creates only a `Membership` and profile for the existing `User`;
   it never changes the user's name, email or password.

### Why not alternatives

- _Per-school copies of name/email:_ breaks the single sign-in email and
  duplicates identity; display name per school isn't a product need.
- _Allow writes, notify the other schools:_ still lets school A lock a
  person out of school B or take over their account.
- _Let any admin write but require the person's confirmation:_ needs email
  infrastructure (P5) for every edit; per-membership archive is simpler and
  covers the common case (person leaves one school).

## Implementation sketch (after approval)

- Migration: `memberships.archived_at timestamptz null`; backfill
  `archived_at = users.deleted_at` for users archived in v1 (all single-school).
- `people/service.ts`: `archivePerson`/`restorePerson` update the membership
  through the scoped client (no more global `User` write); new
  `assertSingleSchool(scope, userId, users)` used by `updatePersonIdentity`
  and `setPassword`.
- `findMember` returns `membership.archivedAt` instead of `user.deletedAt`;
  callers and UI badges follow.
- Auth: `findCredentialUser` selects `archivedAt` on memberships;
  `verifyCredentials` picks the oldest non-archived membership.
- Tests: unit tests for both rules with a two-school fixture (school A admin
  can't rename/reset a user who is in B; archiving in A leaves B signed in),
  and the permission e2e suite extended accordingly.

## Open questions for the owner

1. OK to keep `User.deletedAt` only for a future platform-level disable, with
   no UI in v1/P6?
2. Is "read-only for multi-school users" acceptable for name/email/password,
   or should the school where the user was created first ("home school")
   keep the right to change them?
