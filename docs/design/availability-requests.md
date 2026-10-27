# Teacher availability requests (CARM-86)

Teachers add, change and remove their own unavailability and exceptions.
Every change is a **request** that an admin approves or declines; nothing in
`TeacherAvailability` changes before that. Admins keep editing availability
directly on the teacher detail page (admin-data.md §6.4), with no approval.

## 1. Rules

- A request is one of: add weekly unavailability, change one weekly rule,
  add an exception (one day or a range of up to 31 days), remove one rule
  (weekly or exception). Exceptions are still added or removed, not edited,
  same as for admins.
- Only the teacher's own rules: the teacher's `TeacherProfile` comes from the
  session, never from the client. Someone else's rule or request is "not
  found".
- One pending request per rule: changing or removing a rule that already has
  a pending change is refused (`availabilityRequests.error.alreadyPending`).
  New additions have no limit.
- Teachers can't ask for exceptions on days that have already passed.
- The teacher can **withdraw** a request while it is pending.
- An admin **approves** (it is applied at once) or **declines** (with an
  optional note, up to 200 characters). A request is decided only once: a
  second decision or a withdrawal after it is refused
  (`availabilityRequests.error.alreadyDecided`).
- Approval goes through the admin availability service, so weekly rules
  merge the same way, the change is audited the same way, and an approved
  unavailability shows the "N lessons need a substitute" toast to the
  approving admin.
- If the rule an edit targets was deleted meanwhile, approval is refused
  (`targetGone`) and the request stays pending for the admin to decline. A
  removal whose rule is already gone is approved as is.

## 2. Data

`AvailabilityRequest` (`availability_requests`): `kind`
(`ADD_WEEKLY` / `EDIT_WEEKLY` / `ADD_EXCEPTION` / `DELETE_RULE`), `targetId`
(the rule; set exactly for edits and removals, CHECK), `payload` (the
parsed form, plus a snapshot of the target rule for edits and removals),
`status` (`PENDING` / `APPROVED` / `REJECTED` / `WITHDRAWN`), `reviewedBy*`
(set exactly when approved or rejected, CHECK). `targetId` is not a foreign
key, so a request outlives its rule and still shows what it was about.

## 3. Teacher: _My availability_ (`/teacher/availability`)

Sidebar item under **Me**. Same cards as the admin tab, plus:

- Lead text: changes are sent for approval; until then the timetable uses the
  times shown.
- **Your requests** card on top: pending requests (oldest first) with
  _Withdraw_, then the ones decided in the last 30 days with an
  _Approved_ / _Declined_ badge and the school's note.
- Dialogs submit with _Send for approval_; the toast says "Sent for
  approval". Rules with a pending change show a _Change pending_ badge and
  have no edit or delete buttons.

## 4. Admin: teacher detail › Availability

- A **Change requests** card above the other two while there are pending
  requests: each with what changes (and, for an edit, what it was), the note
  and the date sent. _Approve_ asks for confirmation; _Decline_ opens a dialog
  with an optional note.
- Rules with a pending change show the _Change pending_ badge; the admin can
  still edit or delete them directly.

## 5. Notifications

- `AVAILABILITY_REQUEST_PENDING` → every admin: "{teacher} asked to change
  their availability"; unread ones coalesce per teacher ("{teacher} sent
  N availability changes to review"). Opens the teacher's Availability tab.
- `AVAILABILITY_REQUEST_DECIDED` → the teacher: approved / declined, with the
  admin's note as a detail line. Opens _My availability_.
- Withdrawing notifies nobody.

## 6. Permissions

Covered by `e2e/permissions/availability-requests.spec.ts` (a colleague, a
teacher of another school, an admin of another school, a student) and the
existing suites (teachers and students are refused by every admin action;
every teacher action must be in `action-cases.ts`).
