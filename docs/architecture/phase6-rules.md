# Payments & reports (rules, CARM-71)

**Status: Phase 6, stage 1.** This page defines the rules that stage 2
(CARM-72: payments) and stage 3 (CARM-73: reports) build, plus the schema
they need. The UX Designer specifies the screens in `docs/design/` in
CARM-70. If the two disagree, raise it on the issue instead of picking one.
§11 lists the points the spec has to agree on.

The owner decisions this page builds on (CARM-62 / CARM-69, 2026-10-16):

- **In scope:** payments and reports.
- **Out of scope:** parent accounts and logins, and multi-school (a user
  belongs to exactly one school, so there is no school switcher).
- **No payment provider yet.** An admin records every payment by hand.
  The design leaves room for a real provider later without rewriting the
  schema. Nothing calls an external payment service.

These earlier decisions still apply: one school per user
(multi-school-users.md), **no attendance tracking** (`docs/design/lessons.md`
§1), `TeacherNote`s never reach students, every tenant table has
`school_id`, and every UI string goes through next-intl.

Terms are used as in [phase5-rules.md](phase5-rules.md) and
[replacements.md](replacements.md):

- _now_ is the server time of the request.
- A lesson _has ended_ when `endsAt ≤ now`.
- The **effective teacher** is `substituteTeacherId ?? teacherId`.
- A **local date** is a date in `School.timezone`.
- A student is a **member** of group _g_ at instant _t_ when
  `isMemberAt(memberships, g, t)` holds (`src/server/timetable/week.ts`, the
  same rule that ratings use).

Also:

- **Minor units**: an integer number of the currency's smallest unit (cents
  for EUR). All money in this phase is an integer in minor units plus an
  ISO 4217 currency code (§3.1).
- A **makeup** is a lesson that a student gets in return for a missed one: a
  replacement booking into another group's lesson (replacements.md §6), or a
  credit-backed rescheduled 1-on-1 (replacements.md §7). §2.2 defines this
  exactly.

## 1. Where things live

| Path                                          | What                                                                                                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/billing/money.ts`                 | Pure: `parseMoney`, `formatMoneyParts`, `minorDigits`, `roundHalfUpDiv`, `toDecimalString` (§3.1). No floats                                                                |
| `src/server/billing/rules.ts`                 | Pure: `isMakeupLesson`, `billableLessons`, `resolvePrice`, `desiredCharges`, `planChargeSync`, `allocate`, `studentStatus` (§2, §3). No Prisma, no Next.js                  |
| `src/server/billing/provider.ts`              | The `PaymentProvider` interface and the provider registry (§4.6). v1 registers `MANUAL` only                                                                                |
| `src/server/billing/sync.ts`                  | Internal, **ungated**: `syncCharges(tx, schoolId, studentIds \| "ALL", now)` and `lockBilling` (§2.5). No role check of its own; callers are allow-listed (§6.2)            |
| `src/server/billing/admin.ts`                 | Every function that reads or writes **other people's** money: prices, statements, overview, payments, adjustments. Admin only, and allow-listed for imports (§6.2)          |
| `src/server/billing/student.ts`               | The student's own balance, statement and payment history only (§6.3)                                                                                                        |
| `src/server/reports/rules.ts`                 | Pure report builders: `attendanceReport`, `teacherHoursReport`, `teacherHoursLessons`, `revenueReport`, `outstandingReport` (§5). Built on `teachingMinutes` and `allocate` |
| `src/server/reports/csv.ts`                   | Pure `toCsv(columns, rows, messages)` with RFC 4180 quoting and formula-injection guard (§5.6)                                                                              |
| `src/server/reports/admin.ts`                 | Loaders and the CSV route handlers' shared entry point (page and export call the same function)                                                                             |
| `src/app/api/admin/reports/[report]/…`        | `GET …/<report>.csv`, admin only, same zod input and same loader as the page (§5.6)                                                                                         |
| `messages/en-GB/billing.json`, `reports.json` | `billing.*` (charge descriptions, statuses, reason codes `billing.reasons.<CODE>`), `payments.*`, `reports.*` (incl. `reports.csv.<report>.<column>`)                       |

The pure files follow the scheduling module's contract. Inputs are plain data
and output is deterministic and sorted. There is no `Date.now()`,
`Math.random()` or floating-point money: the service passes `now` and the
school's time zone. Every rule has a unit test, and every reason code is
returned (not only the first one) so the UI can explain it.

## 2. Billing: which lessons cost money

### 2.1 Principles

1. **Billing follows group membership, not the attendee list.** A student
   pays for the lessons of the groups they are a member of. A replacement
   seat in another group never costs anything, and a substitute teacher
   doesn't change the price.
2. **Missed lessons are billed, and makeups are free.** A student who
   reports an absence still pays for the lesson, whether or not they got a
   makeup credit. The makeup the credit buys (a replacement or a rescheduled
   1-on-1) is never billed. This is the same for group and 1-on-1 lessons,
   and it means a credit being used, expiring or being released never
   changes the bill.
3. **Lessons the school cancels are not billed.** Holidays, timetable
   changes, admin cancellations and admin reschedules are free (the
   rescheduled lesson is billed instead).
4. **One definition.** `billableLessons` (pure) is the only definition. The
   charge planner (§2.4), the student statement and the attendance report's
   `expected` count (§5.2) all use it, so they can't disagree.

### 2.2 The rule

For student _s_ and lesson _L_ of group _g_, `billableFor(s, L)` holds when
**all** of the following are true:

| #   | Condition                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------- |
| 1   | _L_ is in a published term (`Term.timetablePublishedAt` set)                                              |
| 2   | _s_ is a **member** of _g_ at `L.startsAt` (`isMemberAt`)                                                 |
| 3   | `L.status ≠ CANCELLED`, **or** `L.cancelReason = STUDENT_CANCELLED` and _s_ has an `AbsenceReport` on _L_ |
| 4   | _L_ is not a makeup: `isMakeupLesson(L) = false`                                                          |

`isMakeupLesson(L)` is pure and follows the reschedule chain (replacements.md
§7). With `P` = the lesson that `L.rescheduledFromId` points to:

- `L.rescheduledFromId` is null → **false**. This covers regular and ad-hoc
  lessons.
- `P.cancelReason = STUDENT_CANCELLED` → **true**. _L_ was bought with the
  credit the student earned by cancelling `P`. This includes the admin's
  _Book 1-on-1 with credit…_, whose chain starts at the credit's
  `STUDENT_CANCELLED` lesson.
- `P.cancelReason = RESCHEDULED` → `isMakeupLesson(P)`. An admin move
  (no credit) is the same lesson at a new time, so _L_ inherits _P_'s role.
- Anything else (the chain was rewritten by a slot split, replacements.md
  §5) → `isMakeupLesson(P)`.

The chain is followed on the loaded lessons. The unique
`rescheduledFromId` index and the `createdAt` order make it acyclic. The
function stops after 50 steps with `CHAIN_TOO_LONG`, and a unit test asserts
that this never happens on the fixtures.

What this means case by case:

| Case                                                                                   | Billed?                                                                          |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Group lesson, student comes                                                            | Yes                                                                              |
| Group lesson, absence before the cutoff (credit)                                       | Yes. The replacement it buys is free                                             |
| Group lesson, absence after the cutoff (no credit)                                     | Yes                                                                              |
| Replacement seat in another group's lesson                                             | No (not a member, rule 2)                                                        |
| 1-on-1, cancelled by the student before the cutoff (`STUDENT_CANCELLED`, credit)       | Yes (rule 3). The rescheduled lesson is a makeup and free                        |
| 1-on-1 credit-backed reschedule, then cancelled again by the student before the cutoff | No (makeup, rule 4). The original is still billed once                           |
| 1-on-1, late cancel (stays `SCHEDULED`, absence, no credit)                            | Yes                                                                              |
| 1-on-1 moved by an admin (`RESCHEDULED` → new ad-hoc lesson)                           | The old lesson isn't billed, the new one is. A moved makeup stays a makeup       |
| Lesson cancelled by the school (`HOLIDAY`, `TIMETABLE_CHANGED`, `SCHOOL_CANCELLED`)    | No                                                                               |
| Lesson with a substitute                                                               | Same as without one                                                              |
| Ad-hoc lesson (not from a slot, not a reschedule)                                      | Like any lesson of the group                                                     |
| Student joined or left mid-term                                                        | Only lessons that start while they are a member                                  |
| Absence report deleted by an admin                                                     | No change for group lessons. A 1-on-1 returns to `SCHEDULED` and is still billed |
| Student archived (user deleted)                                                        | Past charges stay. No new lessons start while they aren't a member               |
| Lesson status `COMPLETED`                                                              | Treated like `SCHEDULED`                                                         |

### 2.3 Prices

Prices are set **per term**. A school sets prices term by term, so a price
never changes in the middle of a term and the unit (per lesson or per term)
of a student's group can't change in the middle of a term either. A
_Copy prices from {term}_ action makes a new term's list in one step
(§11).

A `Price` row has a **target** and a **unit**:

- **Target:** a course (`courseId`) or a group (`groupId`), exactly one of
  them (CHECK). With `studentId` set as well, the row is a **per-student
  override**.
- **Unit:** `PER_LESSON` (the amount for each billable lesson) or
  `PER_TERM` (one amount for the term, prorated by lessons, §2.4).
- **Amount:** `amountMinor` from 0 to `PRICE_MAX_MINOR` (10,000,000, i.e.
  €100,000), in the school's currency. An amount of 0 is a valid price
  (for example a scholarship): the lesson is priced but produces no charge
  row.

`resolvePrice(s, g, T)` returns the **first** match in this order and
records which level matched (`source`):

1. student override for _s_ on group _g_ in _T_ (`STUDENT_GROUP`)
2. student override for _s_ on _g_'s course in _T_ (`STUDENT_COURSE`)
3. price for group _g_ in _T_ (`GROUP`)
4. price for _g_'s course in _T_ (`COURSE`)

If nothing matches, the result is **unpriced**. Billable lessons of an
unpriced (student, group, term) produce no charge. They are listed in the
admin's _Needs pricing_ list as `{ termId, groupId, studentIds, lessonCount }`
until a price exists. Then the next sync (§2.5) posts them, backdated to
when they would have been posted. A group without a course (common for
1-on-1s) needs a group price or an override.

Uniqueness: at most one price per (term, target, student-or-none), enforced
by partial unique indexes (§9).

### 2.4 Charges

A **charge** is one line on the student's account: a positive amount owed
(or a negative one for a discount adjustment). Charges are stored as
`Charge` rows with the amount and description **snapshotted**, so renaming
a group or editing a price later can never silently rewrite a line that was
already posted. Charges change only through §2.5.

There are three kinds of charge:

| Kind         | One per                                                 | `sourceKey`                     | Amount                                                        | Posted at (`postedAt`)                                                                        | `serviceDate`                   |
| ------------ | ------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------- |
| `LESSON`     | Billable lesson of a `PER_LESSON` (s, g, T)             | `lesson:<lessonId>`             | The price's `amountMinor`                                     | `L.endsAt` (the lesson has ended)                                                             | Local date of `L`               |
| `TERM`       | (s, g, T) with a `PER_TERM` price and ≥ 1 member lesson | `term:<termId>:group:<groupId>` | `roundHalfUpDiv(amount × memberLessons, termLessons)` (below) | `startsAt` of the student's first member lesson of _g_ in _T_ (the term has started for them) | Local date of that first lesson |
| `ADJUSTMENT` | Admin action (§4.4)                                     | `adjustment:<uuid>`             | Signed, admin-entered, ≠ 0                                    | When the admin saves it                                                                       | Admin-entered date              |

For a `PER_TERM` price:

- `termLessons` = the lessons of _g_ in _T_ that pass rules 1, 3 and 4 of
  §2.2 **for a member** (cancelled-by-school lessons and makeups don't
  count, `STUDENT_CANCELLED` ones do).
- `memberLessons` = those of them that pass rule 2 for _s_.
- A student who is a member all term has `memberLessons = termLessons` and
  pays exactly `amount`. Someone who joins or leaves in the middle pays the
  share of lessons they were a member for.
- `roundHalfUpDiv(a, b)` = ⌊(2a + b) / (2b)⌋ in integer (bigint) arithmetic,
  so it never uses floats. With `termLessons = 0` there is no charge.
- The counts include lessons that haven't happened yet, so the amount may
  change later during the term (a lesson cancelled by the school, a student
  leaving). §2.5 handles that.

**Due date.** `dueDate` = local date of `postedAt` + `School.paymentTermDays`
(default 14, 0–90). When a charge is reposted (§2.5), it keeps the
`postedAt` and `dueDate` of the row it replaces, so a recalculation never
moves a due date.

**Upcoming.** `desiredCharges(…, now)` called with `now` = the end of the
term returns the charges that **will** be posted if nothing changes. The
statement shows them as _Upcoming this term_ (not part of the balance), so
an admin can tell a student what the term will cost.

### 2.5 When charges are created or recalculated

There is no scheduler. Charges are kept in line with the facts by
**reconciling**:

```
desired = desiredCharges(lessons, memberships, absences, prices, terms, now)   // pure
plan    = planChargeSync(desired, existingActiveCharges)                         // pure
```

For each `sourceKey` (system kinds only, never `ADJUSTMENT`):

| Desired                               | Existing active row | Action                                                                                                                               |
| ------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| posted, amount > 0                    | none                | **Insert**                                                                                                                           |
| none (or amount 0)                    | row                 | **Void** it with reason `NO_LONGER_BILLABLE` (or `NO_PRICE` when only the price disappeared)                                         |
| posted, same amount and `priceId`     | row                 | Nothing. Snapshot text isn't compared, so a rename doesn't repost                                                                    |
| posted, different amount or `priceId` | row                 | **Void** (`RECALCULATED`) and **insert** a new row with `replacesChargeId` = the old one, which keeps the old `postedAt` / `dueDate` |

`syncCharges(tx, schoolId, studentIds | "ALL", now)` lives in the internal
module `src/server/billing/sync.ts`. It does **no** role check itself:
it runs for a student's own read and from a script with no session, so
gating is the caller's job. Only `billing/admin.ts` and `reports/admin.ts`
(both after `requireRole("ADMIN")`), `billing/student.ts` (always passing exactly the
viewer's own `StudentProfile` id) and `scripts/billing-sync.ts` may import
it (§6.2).

It runs the plan in **one transaction holding the school's billing lock**
(`lockBilling`, a `pg_advisory_xact_lock` on `('billing', schoolId)`, like
`lockTimetable`), but **only when there is something to write**: it plans
first without the lock; an empty plan returns at once (no lock, no writes),
otherwise it takes the lock, re-loads and re-plans, and writes that plan. So
a read only waits on the lock when a line is actually due, and the 2 s
budget below is the cost of a first sync, not of every page. It runs:

- **Before every money read**, for the students the read covers: the
  student's own page, the admin's statement for a student (one student), the
  admin overview and the revenue and outstanding reports (whole school). This
  is lazy, like the notification purge (phase5-rules.md §2.5). A read never
  shows a stale balance.
- **After a price change**, inside the same transaction as the change (§2.6).
- From `pnpm billing:sync` (new script; whole school, every school).

Properties that stage 2 must prove (§10):

- **Idempotent.** A second sync right after the first plans nothing. A
  partial unique index on `(school_id, student_id, source_key) WHERE voided_at
IS NULL` makes two concurrent syncs unable to post the same line twice
  (the lock serialises them, and the index is the backstop).
- **Order-independent.** The plan is the same for any input order.
- **Bounded.** A sync loads only lessons of published terms, and only for
  the students in scope. A whole-school sync of the realistic fixtures (20
  teachers, 60 groups, 15 rooms, one term) must finish in under 2 s in the db
  test, and a no-op sync must make zero writes.
- **Audited when it changes posted money.** A sync that voids or reposts
  anything writes **one** `billing.recalculated` audit entry with
  `{ trigger, voided: [{ chargeId, reason, amountMinor }], inserted:
[{ chargeId, replaces, amountMinor }] }`. Inserts that only post newly
  due lines (the normal case after a lesson ends) are not audited one by one.
  Their audit is the row itself (`createdAt`, `sourceKey`).

### 2.6 Changing prices

- Creating, editing or deleting a `Price` is admin only. It is allowed for
  any term, past ones included. Each change runs `syncCharges` for the
  affected students **in the same transaction**, so the admin sees the
  result straight away.
- **Preview first.** `previewPriceChange(input)` runs the planner without
  writing and returns `{ students, voided, inserted, deltaMinor }` so the
  dialog can say "This changes 34 posted charges for 12 students by
  +€120.00". The save takes `expectedPreviewHash` and is refused with
  `PREVIEW_OUT_OF_DATE` if the plan has changed in between.
- Audit: `price.created`, `price.updated` (old and new amount and unit),
  `price.deleted`, each with the recalculation summary.
- **Copy prices from term** copies every non-override price (and, if the
  admin ticks it, the overrides) of a source term into a target term that has
  no prices yet. It is one audited action, `price.copied`.

## 3. Money

### 3.1 Storage and arithmetic

- **Integer minor units, never floats.** Amounts are Postgres `integer`
  columns (`*Minor`), with CHECK constraints on every column (§9). Sums are
  computed in SQL as `bigint` (or `bigint` in JS) and converted to `number`
  only after asserting `≤ Number.MAX_SAFE_INTEGER`. Prisma `Decimal` and JS
  `Float` are not used for money anywhere.
- **Currency.** `School.currency` (ISO 4217, default `EUR`). Every money row
  also stores `currency`, and the service refuses a row whose currency
  differs from the school's (`CURRENCY_MISMATCH`). A school uses exactly one
  currency in v1. The currency can be changed only while the school has no
  `Price`, `Charge` or `Payment` rows (`CURRENCY_LOCKED`).
- `minorDigits(currency)` = `new Intl.NumberFormat("en", { style:
"currency", currency }).resolvedOptions().maximumFractionDigits` (EUR 2,
  JPY 0).
- **Parsing input** (`parseMoney(text, currency, locale)`) is string-based.
  It accepts digits, the locale's grouping and decimal separators, and at
  most `minorDigits` decimals. There is no sign (the kind of row carries the
  sign), no exponent and no more than 12 digits. It returns minor units or
  `INVALID_AMOUNT`. `"12.5"` → 1250, `"12.505"` → `INVALID_AMOUNT`.
- **Display** goes through next-intl's number formatting with
  `style: "currency"`. The value is passed as the **decimal string**
  `toDecimalString(minor, currency)` (e.g. `"1250.50"`), which
  `Intl.NumberFormat` formats exactly, so formatting never divides a float.
  `formatMoneyParts` is the helper that the components and the CSV writer
  share.

### 3.2 Balance

```
balance(s) = Σ active charges(s).amountMinor            // positive = the student owes
           − Σ SUCCEEDED PAYMENT(s).amountMinor
           + Σ SUCCEEDED REFUND(s).amountMinor
```

"Active" means `voidedAt IS NULL`. Voided rows and payments that aren't
`SUCCEEDED` never count. A positive balance means the student **owes**, a
negative balance means the student **is in credit** (has overpaid), and 0
means settled.

### 3.3 Allocation and status (pure `allocate`)

Payments are not tied to particular charges (a balance-forward account), but
the statement needs a per-line paid / unpaid state and the overview needs
"overdue". `allocate(charges, payments)` is deterministic:

1. **Linked waivers first.** Each active negative adjustment with
   `adjustsChargeId` set is applied to **that** line: it covers
   `min(|adjustment|, line's uncovered amount)` (`waivedMinor`). If the
   target is voided or already covered, or the waiver is bigger than the
   line, the rest goes into the general funds. Several waivers on one line
   are applied in (`postedAt`, `id`) order.
2. **Funds** = Σ succeeded payments − Σ succeeded refunds + Σ |unlinked
   negative adjustments| + the waiver leftovers from step 1.
3. Positive charges, sorted by (`dueDate`, `postedAt`, `id`), each take
   `min(remaining funds, uncovered amount)`. The oldest debts are paid first.
4. Per charge: `waivedMinor`, `paidMinor` and a state: `WAIVED` (fully
   covered by linked waivers), `PAID` (fully covered, at least partly by
   funds), `PARTIALLY_PAID` or `UNPAID`. An uncovered remainder whose
   `dueDate` < today (local) is **overdue**.
5. Funds left over = credit (`−balance`).

So waiving a line clears **that** line: with an overdue September line and
a current October line, waiving October makes October `WAIVED` and leaves
September overdue. The identity `Σ uncovered remainders − leftover funds =
balance` holds for any input, linked waivers included, and a property test
checks it.

**Student status** (`studentStatus`, shown on the overview and the student
page). The table is evaluated top to bottom and the **first match wins**
(so a student with no charges and no payments is `NOTHING_DUE`, not
`SETTLED`):

| Status        | When                                                   |
| ------------- | ------------------------------------------------------ |
| `NOTHING_DUE` | No active charges and no payments                      |
| `SETTLED`     | `balance = 0`                                          |
| `IN_CREDIT`   | `balance < 0`                                          |
| `DUE`         | `balance > 0`, nothing overdue                         |
| `OVERDUE`     | `balance > 0` and some charge is overdue (§3.3 step 3) |

The overview also shows `overdueMinor` and `oldestOverdueDate`.

## 4. Payments

### 4.1 What a payment is

A `Payment` row is money received from a student (`kind PAYMENT`) or paid
back to them (`kind REFUND`). It has:

- `amountMinor` > 0 (CHECK), up to `PAYMENT_MAX_MINOR` (100,000,000)
- `currency`
- `method`: `CASH`, `BANK_TRANSFER`, `CARD` or `OTHER`. `ONLINE` is reserved
  for providers.
- `receivedOn`: the local date the money moved, ≤ today
- an optional `reference` (≤ 100 chars, e.g. the bank transfer's variable
  symbol) and an optional `note` (≤ 500 chars)
- `provider` (`MANUAL` in v1) and `status` (`SUCCEEDED` for manual
  payments, §4.6)
- `recordedById`

### 4.2 Recording (and partial payments)

`recordPayment({ studentId, kind: PAYMENT, amountMinor, method, receivedOn,
reference?, note?, clientRequestId })`:

- Any amount is accepted. A payment smaller than the balance is a
  **partial payment**: it simply covers the oldest charges first (§3.3).
  A payment bigger than the balance leaves the student in credit. Paying
  ahead of time (before charges are posted) is allowed.
- **No double submits.** `clientRequestId` (a UUID the form makes when it
  opens) is unique per school. A second submit with the same id returns the
  first payment and writes nothing.
- The student must be a `STUDENT` of the school. Archived students are
  allowed (old debts get paid). Another school's id gives `NOT_FOUND`.

### 4.3 Refunds

`recordPayment({ kind: REFUND, … , refundOfId? })` checks:

| Code                    | Severity    | Rule                                                                                                                     |
| ----------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| `REFUND_EXCEEDS_PAID`   | blocking    | `amount ≤ Σ succeeded payments − Σ succeeded refunds` (you can't refund money that was never received)                   |
| `REFUND_EXCEEDS_CREDIT` | overridable | `amount ≤ max(0, −balance)`. Refunding more than the credit makes the student owe again; the admin has to acknowledge it |
| `REFUND_OF_MISMATCH`    | blocking    | If `refundOfId` is set: it is an active `PAYMENT` of the same student, and the refunds linked to it don't exceed it      |

`refundOfId` is optional and only for display ("Refund of 12 Oct payment").
Allocation ignores it (§3.3).

To refund a cancelled course, the admin first gives the student a credit
note (a negative adjustment, §4.4), which puts them in credit, and then
records the refund.

### 4.4 Corrections

Nothing about money is ever edited in place or deleted.

- **Void a payment or refund** (`voidPayment(id, reason)`, with the reason
  required, ≤ 300 chars) sets `voidedAt`, `voidedById` and `voidReason`
  through a conditional update (`WHERE voided_at IS NULL`, one row, or
  `ALREADY_VOIDED`). If voiding a `PAYMENT` would make Σ refunds > Σ
  payments, it is refused with `REFUNDS_EXCEED_PAYMENTS`: void the refund
  first.
- **Correct a payment** (wrong amount, date or method) = void + record the
  new one in one transaction. The new row has `correctsId` = the voided
  one. The UI shows it as one "Edit".
- **Adjustments** (`addAdjustment({ studentId, amountMinor (signed, ≠ 0),
serviceDate, reason, chargeId? })`) are `ADJUSTMENT` charges: a fee
  (positive) or a discount, waiver or write-off (negative). The reason is
  required (≤ 300). `chargeId` (stored as `adjustsChargeId`) links a
  **waiver** to the line it waives: it must be negative, target an active
  positive charge of the same student, and is allocated to that line
  first (§3.3), so the line shows as waived. The UI's _Waive…_ on a line
  pre-fills it with the line's uncovered amount. An adjustment can be
  voided with a reason (stored in `voidNote`, §9). System
  charges (`LESSON`, `TERM`) **can't** be voided by hand, because the next
  sync would recreate them. To waive one, the admin adds a negative
  adjustment, or fixes the cause (price, membership, cancellation).
- Every write in §4 holds the billing lock (refund checks read the balance).

### 4.5 Audit

Every payment change is written to `AuditLog` in the same transaction
(`entityType` `Payment` or `Charge`). The admin's **reasons** are part of
the audit (`reason`, `voidNote`); the payment's `note` and `reference` are
**not** copied into `data` (they stay on the row only):

| Action                                                | `data`                                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `payment.recorded` / `payment.refunded`               | `{ studentId, kind, amountMinor, currency, method, receivedOn, provider, refundOfId }` |
| `payment.voided`                                      | `{ studentId, kind, amountMinor, currency, reason }`                                   |
| `payment.corrected`                                   | `{ studentId, from: { id, amountMinor, receivedOn, method }, to: { id, … } }`          |
| `charge.adjustment_added`                             | `{ studentId, amountMinor, currency, serviceDate, reason, adjustsChargeId }`           |
| `charge.adjustment_voided`                            | `{ studentId, amountMinor, currency, serviceDate, adjustsChargeId, voidNote }`         |
| `price.created` / `.updated` / `.deleted` / `.copied` | §2.6                                                                                   |
| `billing.recalculated`                                | §2.5                                                                                   |
| `billing.currency_changed`                            | `{ from, to }`                                                                         |

### 4.6 Payment provider abstraction

```ts
type PaymentProviderId = "MANUAL"; // later e.g. "STRIPE" | "GOPAY"; stored as text

interface PaymentProvider {
  id: PaymentProviderId;
  /** Admin records it by hand (MANUAL) vs the provider reports it. */
  capabilities: {
    manualRecord: boolean;
    checkout: boolean;
    apiRefund: boolean;
  };
  /** Extra checks on a manual record (e.g. method must not be ONLINE). */
  validateRecord(input: RecordPaymentInput): ProviderReason[];
  // Later providers add, without schema changes:
  // createCheckout(student, amountMinor, currency): Promise<{ redirectUrl, providerReference }>
  // parseWebhook(request): Promise<ProviderEvent[]>   → upsert Payment by (provider, providerReference)
  // refund(payment, amountMinor): Promise<{ providerReference, status }>
}
```

- `Payment.provider` is **text**, not an enum, so adding a provider needs no
  migration. Its valid values are the registry's ids, checked in the
  service.
- `Payment.status`: `PENDING`, `SUCCEEDED` or `FAILED`. Manual payments are
  created `SUCCEEDED`. A provider's checkout would create `PENDING` and its
  webhook would move it on. Only `SUCCEEDED` counts (§3.2). This is the
  design's "paid online" state.
- `providerReference` (text, unique per `(school_id, provider)` when set)
  makes webhook handling idempotent. `providerData` (JSON) holds the
  provider's raw details. Both are null for `MANUAL`.
- v1 registers **only `MANUAL`**. No code path makes an outbound request.
  A unit test asserts the registry contains exactly `MANUAL`, and that
  `src/server/billing/**` imports no HTTP client.

Adding a real provider later means implementing the interface, registering
it, adding the webhook route and, if needed, a new additive table for raw
webhook events. Existing columns don't change.

### 4.7 Notifications

There are none in v1. No new `NotificationType`. Payment reminders would be
time-based, and there is no scheduler. Overdue balances show on the admin
overview and the student's home card instead.

## 5. Reports

### 5.1 Common rules

- **Admin only, own school only.** Every report is admin only and scoped to
  the admin's school (§6). The page and the CSV call the same
  `loadReport(report, input)`.
- **Input** (zod): `report`, `from` / `to` (local dates, inclusive), or
  `termId` (which sets `from` / `to` to the term's dates), plus the filters
  of §5.2–§5.5. Lessons are selected by `startsAt ∈ [from 00:00, to + 1
00:00)` in the school's time zone, published terms only.
- **Limits.** The range covers at most `REPORT_MAX_RANGE_DAYS` (366)
  days, counted inclusively (`to − from + 1 ≤ 366`; otherwise
  `RANGE_TOO_LONG`) and `from ≤ to` (otherwise `INVALID_RANGE`). A CSV with
  more than `REPORT_MAX_ROWS` (50,000) data rows is refused with
  `TOO_MANY_ROWS` and the row count, so the admin narrows the filters. A CSV
  is never silently truncated. The page shows 50 rows per page (keyset on
  the sort key), with totals computed over all rows.
- **Ended lessons only.** Attendance and teacher hours count lessons with
  `endsAt ≤ now`. A range that reaches into the future shows the lessons
  that have happened so far (the UI says "until today").
- **Current state.** Reports read the data as it is now. A correction made
  later (a voided payment, a recorded substitute, a deleted absence) changes
  past figures. The page says "Figures reflect corrections made since"
  (UX copy). There is no period closing in v1 (§12).

### 5.2 Attendance

There is no attendance record (owner decision), so "attended" means the
same as in ratings (phase5-rules.md §4.1): the student was a member and
didn't report an absence. The report says so in its caption ("Based on
reported absences. Attendance is not taken in class.").

**Grain:** one row per (student, group) with at least one expected lesson in
range. Filters: `groupId?`, `teacherId?` (the lesson's **effective** teacher),
`studentId?`.

| Column             | Definition (ended lessons in range only)                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expected`         | Lessons of the group with `billableFor(s, L)` (§2.2), with the price ignored                                                                                                |
| `absent`           | `expected` lessons with an `AbsenceReport` of _s_                                                                                                                           |
| `absentWithCredit` | … of which earned a `MakeupCredit`                                                                                                                                          |
| `absentLate`       | `absent − absentWithCredit`                                                                                                                                                 |
| `attended`         | `expected − absent`                                                                                                                                                         |
| `attendanceRate`   | `attended / expected` as a percentage with one decimal, rounded half up in integer arithmetic (`roundHalfUpDiv(attended × 1000, expected)` ÷ 10). Empty when `expected = 0` |
| `makeupsAttended`  | Ended, non-cancelled lessons that _s_ attended as a makeup (an active replacement into them, or a credit-backed reschedule) **whose credit came from this group**           |

The student, group and level are snapshotted from the current names. Sort
order: group name, student name, then ids.

### 5.3 Teacher hours

**Grain (summary):** one row per teacher with any minutes in range. Filters:
`teacherId?`, `groupId?`.

With `ended` = ended, non-cancelled lessons in range (and in the group, if
filtered):

| Column                   | Definition                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `totalMinutes`           | `teachingMinutes(ended, t, range)` — the Phase 5 definition, unchanged (phase5-rules.md §3.4)                               |
| `regularMinutes`         | `teachingMinutes(ended.filter(l => l.substituteTeacherId === null), t, range)`                                              |
| `substituteMinutes`      | `teachingMinutes(ended.filter(l => l.substituteTeacherId !== null), t, range)` (_t_ covering someone else)                  |
| `coveredByOthersMinutes` | Σ minutes of `ended` lessons where `teacherId = t` and someone else substituted. For information only, **not** in the total |
| `lessons`                | Number of `ended` lessons with effective teacher _t_                                                                        |
| `hours`                  | `totalMinutes / 60` as a decimal string with 2 places, rounded half up in integers                                          |

- **Substitute hours count for the substitute, not the regular teacher**
  (`teachingMinutes` uses the effective teacher). Invariants:
  `totalMinutes = regularMinutes + substituteMinutes`, and the total over all
  teachers equals Σ minutes of `ended`, so every lesson is counted exactly
  once.
- Archived teachers are listed, because their past hours still count.

**Lesson detail export** (`teacher-hours-lessons`): one row per ended,
non-cancelled lesson. Columns: `date`, `start`, `end`, `minutes`, `teacher`
(effective), `role` (`REGULAR` / `SUBSTITUTE`), `regularTeacher`, `group`,
`level`, `room`, `lessonId`. This is the one that can hit the row limit.

### 5.4 Revenue

**Grain:** one row per local calendar month that overlaps the range. Filter:
`termId` / range only. A group or teacher filter isn't offered, because
payments aren't tied to groups (§3.3), so "collected per group" doesn't
exist (§11).

| Column          | Definition                                                             |
| --------------- | ---------------------------------------------------------------------- |
| `billedLessons` | Σ active `LESSON` charges with `serviceDate` in the month              |
| `billedTerms`   | Σ active `TERM` charges with `serviceDate` in the month                |
| `adjustments`   | Σ active `ADJUSTMENT` charges (signed) with `serviceDate` in the month |
| `billedTotal`   | Sum of the three                                                       |
| `collected`     | Σ `SUCCEEDED`, not voided `PAYMENT`s with `receivedOn` in the month    |
| `refunded`      | Σ the same for `REFUND`s                                               |
| `netCollected`  | `collected − refunded`                                                 |
| `currency`      | School currency                                                        |

The first and last month count only the days inside the range. A sync runs
first (§2.5). A `TERM` charge counts in the month of the student's first
lesson of the term (its `serviceDate`), so a late joiner's fee lands in the
month they joined; a later proration (§2.4) changes the amount, not the
month.

### 5.5 Outstanding

**Grain:** one row per student whose balance ≠ 0, as of **now** (this report
ignores the range). Filters: `groupId?` (students who were members of the
group at any time in the selected term, or currently when there is no term)
and `status?` (§3.3, default `DUE` + `OVERDUE`).

Columns: `student`, `email`, `groups` (current group names, `; `-separated),
`chargedTotal`, `paidNet` (payments − refunds), `balance`, `overdue`,
`oldestOverdueDate`, `lastPaymentOn`, `status`, `currency`. Sorted by
`overdue` descending, then `balance` descending, then name and id. A sync
runs first.

### 5.6 CSV format

- Route: `GET /api/admin/reports/<report>.csv?<same query as the page>`,
  where `<report>` ∈ `attendance`, `teacher-hours`, `teacher-hours-lessons`,
  `revenue`, `outstanding`. Each request runs `requireRole("ADMIN")` and
  `getSchoolScopedDb()`, and parses the input with the page's zod schema.
  Another school's ids in the filters give `NOT_FOUND`, a teacher or
  student gets **403**, and a signed-out request gets 401.
- Headers: `Content-Type: text/csv; charset=utf-8`, `Content-Disposition:
attachment; filename="<report>_<from>_<to>.csv"`, `Cache-Control: no-store`.
- Body: UTF-8 **with BOM** (so Excel reads it as UTF-8), comma separator,
  CRLF line endings, RFC 4180 quoting (quote fields containing `,` `"` CR
  or LF, and double the quotes).
- **Header row** in the user's locale via next-intl
  (`reports.csv.<report>.<column>`). Column **order** is the order in the
  tables above. It is fixed and covered by a snapshot test.
- **Values are machine-readable, not localised.** Dates are `YYYY-MM-DD`
  and times are `HH:mm`, both in the school's time zone. Money is a decimal
  string in major units with `.` (e.g. `125.50`) via `toDecimalString`,
  with a separate `currency` column. Percentages are `87.5`. Enums are the
  code (`SUBSTITUTE`, `OVERDUE`). Integer columns are plain integers.
- **Formula injection guard:** every text cell starting with `=`, `+`, `-`,
  `@`, TAB or CR gets a leading `'`. Student names are user input.
  Numeric columns are written by the writer itself and are never prefixed.
- No totals row in the CSV (the page shows totals). An empty result is a
  header-only file.
- Audit: `report.exported` with `{ report, input, rows }`. Viewing a page is
  not audited.

## 6. Permissions

### 6.1 Matrix

| Action / data                                                  | Admin (own school) | Teacher | Student             |
| -------------------------------------------------------------- | ------------------ | ------- | ------------------- |
| Prices: view, create, edit, delete, copy                       | ✓                  | ✗       | ✗                   |
| Any student's balance, statement, payments, adjustments        | ✓                  | ✗       | Own only, read only |
| Record payment / refund, void, correct, add or void adjustment | ✓                  | ✗       | ✗                   |
| Overview of outstanding balances, _Needs pricing_              | ✓                  | ✗       | ✗                   |
| Reports and CSV exports                                        | ✓                  | ✗       | ✗                   |
| Billing settings (`currency`, `paymentTermDays`)               | ✓                  | ✗       | ✗                   |

- **Teachers see no payment data at all.** That covers balances, statuses,
  "owes money" flags on rosters, dashboard counts and notifications. No
  teacher DTO contains a money field. This mirrors the rule for ratings
  (phase5-rules.md §4.3).
- **Another school's admin** gets `NOT_FOUND` for any id (as everywhere).
  A teacher or student calling an admin action or route gets **403**
  (`FORBIDDEN`) through `requireRole("ADMIN")`.

### 6.2 Server-side enforcement

- `src/server/billing/admin.ts` and `src/server/reports/admin.ts` hold every
  function that reads or writes other people's money or report data. Each
  starts with `requireRole("ADMIN")` and uses `getSchoolScopedDb()`.
- **Import allow-list** (like ratings): only files under `src/app/admin/**`,
  `src/app/api/admin/reports/**`, `src/server/billing/**`,
  `src/server/reports/**` and `scripts/billing-sync.ts` may import those
  files. A unit test scans the rest of `src/` and fails if any other file
  does.
- `src/server/billing/sync.ts` (§2.5) is **ungated** and has a stricter
  allow-list: only `billing/admin.ts`, `billing/student.ts`,
  `reports/admin.ts` and `scripts/billing-sync.ts`. `student.ts` passes
  only the viewer's own `StudentProfile` id, never an id from input; a
  unit test covers that call site. The same import-guard test enforces it.
- Every action validates its input with zod, re-reads the `Membership` (as
  every request does), and writes `AuditLog` in the same transaction.

### 6.3 What the student sees

`src/server/billing/student.ts` reads only rows where `studentId` = the
viewer's `StudentProfile` and returns a student DTO:

- the balance, status, `overdueMinor` and `dueSoon` (the next due date)
- **active** charges with their snapshotted description, amount, due date
  and allocation state (§3.3)
- _Upcoming this term_ (§2.4)
- **active**, `SUCCEEDED` payments and refunds: `receivedOn`, `kind`,
  `method`, `amountMinor`, `reference`

It **never** returns voided rows, `note`, `voidReason`, adjustment `reason`
text, `recordedById` / admin names ("Recorded by the school office"),
`providerData`, `clientRequestId`, or anything about another student. A
guessed id of another student's row gives `NOT_FOUND`.

## 7. Settings

`School` gets two billing columns. Only admins can edit them, through the
existing school settings action:

| Column            | Default | Range / rule                                                                         |
| ----------------- | ------- | ------------------------------------------------------------------------------------ |
| `currency`        | `EUR`   | ISO 4217, `CURRENCY_LOCKED` once money rows exist (§3.1)                             |
| `paymentTermDays` | 14      | 0–90. A change applies to charges posted **afterwards** (due dates are stored, §2.4) |

## 8. Interaction with earlier phases

| Area                                           | Effect on billing                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Timetable editor, holidays, generator          | Lessons that are cancelled or deleted stop being billable. The next sync voids their charges (`NO_LONGER_BILLABLE`) |
| Absences (replacements.md §3)                  | None for group lessons. A 1-on-1 `STUDENT_CANCELLED` is still billed (§2.2)                                         |
| Replacements, reschedules (§6, §7)             | Makeups are never billed. Releasing or expiring a credit changes nothing                                            |
| Substitutes (phase5-rules.md §3)               | No effect on charges. They do affect teacher hours (§5.3)                                                           |
| Group membership edits (`joinedAt` / `leftAt`) | Change which lessons are billable and the `PER_TERM` share. The sync reposts                                        |
| Term deleted                                   | Already impossible once a term has lessons (`onDelete: Restrict`). `Price` uses `Restrict` too                      |
| Student archived                               | Charges and payments stay. The student page is unreachable (no sign-in), the admin pages still work                 |

## 9. Schema

The changes are additive, and no existing column changes. Every new table
has `school_id`, `@@unique([schoolId, id])` and composite foreign keys to
tenant tables, so `src/server/data-model.test.ts` keeps passing. References
to users are plain foreign keys, as elsewhere.

```prisma
enum PriceUnit {
  PER_LESSON
  PER_TERM
}

enum ChargeKind {
  LESSON
  TERM
  ADJUSTMENT
}

enum PaymentKind {
  PAYMENT
  REFUND
}

enum PaymentMethod {
  CASH
  BANK_TRANSFER
  CARD
  ONLINE
  OTHER
}

enum PaymentStatus {
  PENDING
  SUCCEEDED
  FAILED
}

/// A term's price for a course or group, optionally a per-student override
/// (docs/architecture/phase6-rules.md §2.3).
model Price {
  id          String    @id @default(uuid()) @db.Uuid
  schoolId    String    @map("school_id") @db.Uuid
  termId      String    @map("term_id") @db.Uuid
  /// Exactly one of courseId / groupId (CHECK).
  courseId    String?   @map("course_id") @db.Uuid
  groupId     String?   @map("group_id") @db.Uuid
  /// Set = per-student override.
  studentId   String?   @map("student_id") @db.Uuid
  unit        PriceUnit
  /// 0 – 10,000,000 (CHECK).
  amountMinor Int       @map("amount_minor")
  currency    String    @db.Char(3)
  createdById String?   @map("created_by_id") @db.Uuid
  createdAt   DateTime  @default(now()) @map("created_at")
  updatedAt   DateTime  @updatedAt @map("updated_at")

  school    School          @relation(fields: [schoolId], references: [id], onDelete: Cascade)
  term      Term            @relation(fields: [schoolId, termId], references: [schoolId, id], onDelete: Restrict)
  course    Course?         @relation(fields: [schoolId, courseId], references: [schoolId, id], onDelete: Restrict)
  group     Group?          @relation(fields: [schoolId, groupId], references: [schoolId, id], onDelete: Restrict)
  student   StudentProfile? @relation(fields: [schoolId, studentId], references: [schoolId, id], onDelete: Restrict)
  createdBy User?           @relation(fields: [createdById], references: [id], onDelete: SetNull)

  @@unique([schoolId, id])
  @@index([schoolId, termId])
  @@map("prices")
}
// CHECK ((course_id IS NULL) <> (group_id IS NULL));
// CHECK (amount_minor BETWEEN 0 AND 10000000);
// Partial unique indexes (one price per term + target + student-or-none):
//   (school_id, term_id, course_id) WHERE course_id IS NOT NULL AND student_id IS NULL
//   (school_id, term_id, group_id)  WHERE group_id  IS NOT NULL AND student_id IS NULL
//   (school_id, term_id, course_id, student_id) WHERE course_id IS NOT NULL AND student_id IS NOT NULL
//   (school_id, term_id, group_id,  student_id) WHERE group_id  IS NOT NULL AND student_id IS NOT NULL

/// One line on a student's account (§2.4). Never updated except to void.
model Charge {
  id               String     @id @default(uuid()) @db.Uuid
  schoolId         String     @map("school_id") @db.Uuid
  studentId        String     @map("student_id") @db.Uuid
  kind             ChargeKind
  /// lesson:<id> | term:<termId>:group:<groupId> | adjustment:<uuid>
  sourceKey        String     @map("source_key")
  lessonId         String?    @map("lesson_id") @db.Uuid
  groupId          String?    @map("group_id") @db.Uuid
  termId           String?    @map("term_id") @db.Uuid
  priceId          String?    @map("price_id") @db.Uuid
  /// Signed; LESSON/TERM > 0, ADJUSTMENT ≠ 0 (CHECK). |amount| ≤ 100,000,000.
  amountMinor      Int        @map("amount_minor")
  currency         String     @db.Char(3)
  /// Snapshot for display: { group, lessonStartsAt, unit, priceSource, memberLessons, termLessons, term }.
  description      Json       @default("{}")
  serviceDate      DateTime   @map("service_date") @db.Date
  postedAt         DateTime   @map("posted_at")
  dueDate          DateTime   @map("due_date") @db.Date
  /// ADJUSTMENT only (CHECK): required reason, optional waived charge.
  reason           String?
  adjustsChargeId  String?    @map("adjusts_charge_id") @db.Uuid
  createdById      String?    @map("created_by_id") @db.Uuid
  /// Set when a recalculation reposted an earlier row (§2.5).
  replacesChargeId String?    @map("replaces_charge_id") @db.Uuid
  voidedAt         DateTime?  @map("voided_at")
  voidedById       String?    @map("voided_by_id") @db.Uuid
  /// NO_LONGER_BILLABLE | NO_PRICE | RECALCULATED | ADMIN_VOID (code)
  voidReason       String?    @map("void_reason")
  /// The admin's free-text reason, ADMIN_VOID only (CHECK), ≤ 300.
  voidNote         String?    @map("void_note")
  createdAt        DateTime   @default(now()) @map("created_at")

  school        School         @relation(fields: [schoolId], references: [id], onDelete: Cascade)
  student       StudentProfile @relation(fields: [schoolId, studentId], references: [schoolId, id], onDelete: Restrict)
  /// No FK to Lesson/Group/Term/Price: money history must never block or
  /// follow timetable or price deletions; ids + description snapshot are enough.
  createdBy     User?          @relation("ChargeCreatedBy", fields: [createdById], references: [id], onDelete: SetNull)
  voidedBy      User?          @relation("ChargeVoidedBy", fields: [voidedById], references: [id], onDelete: SetNull)

  @@unique([schoolId, id])
  @@index([schoolId, studentId, dueDate])
  @@index([schoolId, serviceDate])
  @@index([schoolId, lessonId])
  @@map("charges")
}
// CREATE UNIQUE INDEX charges_one_active ON charges (school_id, student_id, source_key)
//   WHERE voided_at IS NULL;
// CHECK (kind = 'ADJUSTMENT' OR amount_minor > 0); CHECK (amount_minor <> 0);
// CHECK (abs(amount_minor) <= 100000000);
// CHECK (kind <> 'ADJUSTMENT' OR reason IS NOT NULL);
// CHECK ((voided_at IS NULL) = (void_reason IS NULL));
// CHECK ((void_reason = 'ADMIN_VOID') = (void_note IS NOT NULL)); -- NULL-safe form in the migration
// CHECK (char_length(void_note) <= 300);
// CHECK (adjusts_charge_id IS NULL OR (kind = 'ADJUSTMENT' AND amount_minor < 0));

/// Money received from (PAYMENT) or paid back to (REFUND) a student (§4).
model Payment {
  id                String        @id @default(uuid()) @db.Uuid
  schoolId          String        @map("school_id") @db.Uuid
  studentId         String        @map("student_id") @db.Uuid
  kind              PaymentKind
  status            PaymentStatus @default(SUCCEEDED)
  /// > 0, ≤ 100,000,000 (CHECK).
  amountMinor       Int           @map("amount_minor")
  currency          String        @db.Char(3)
  method            PaymentMethod
  receivedOn        DateTime      @map("received_on") @db.Date
  reference         String?
  note              String?
  /// Registry id (text, not enum): MANUAL in v1 (§4.6).
  provider          String        @default("MANUAL")
  providerReference String?       @map("provider_reference")
  providerData      Json?         @map("provider_data")
  /// Form-generated idempotency key (§4.2).
  clientRequestId   String?       @map("client_request_id") @db.Uuid
  refundOfId        String?       @map("refund_of_id") @db.Uuid
  correctsId        String?       @map("corrects_id") @db.Uuid
  recordedById      String?       @map("recorded_by_id") @db.Uuid
  createdAt         DateTime      @default(now()) @map("created_at")
  voidedAt          DateTime?     @map("voided_at")
  voidedById        String?       @map("voided_by_id") @db.Uuid
  voidReason        String?       @map("void_reason")

  school     School         @relation(fields: [schoolId], references: [id], onDelete: Cascade)
  student    StudentProfile @relation(fields: [schoolId, studentId], references: [schoolId, id], onDelete: Restrict)
  refundOf   Payment?       @relation("PaymentRefund", fields: [schoolId, refundOfId], references: [schoolId, id], onDelete: Restrict)
  refunds    Payment[]      @relation("PaymentRefund")
  corrects   Payment?       @relation("PaymentCorrection", fields: [schoolId, correctsId], references: [schoolId, id], onDelete: Restrict)
  correctedBy Payment[]     @relation("PaymentCorrection")
  recordedBy User?          @relation("PaymentRecordedBy", fields: [recordedById], references: [id], onDelete: SetNull)
  voidedBy   User?          @relation("PaymentVoidedBy", fields: [voidedById], references: [id], onDelete: SetNull)

  @@unique([schoolId, id])
  @@unique([schoolId, clientRequestId])
  @@index([schoolId, studentId, receivedOn])
  @@index([schoolId, receivedOn])
  @@map("payments")
}
// CHECK (amount_minor BETWEEN 1 AND 100000000);
// CHECK (refund_of_id IS NULL OR kind = 'REFUND');
// CHECK ((voided_at IS NULL) = (void_reason IS NULL));
// CHECK (char_length(reference) <= 100 AND char_length(note) <= 500);
// CREATE UNIQUE INDEX payments_provider_ref ON payments (school_id, provider, provider_reference)
//   WHERE provider_reference IS NOT NULL;
```

Changes to existing models:

- `School`: `currency String @default("EUR") @db.Char(3)` and
  `paymentTermDays Int @default(14) @map("payment_term_days")` (CHECK
  0–90), plus back-relations `prices`, `charges` and `payments`.
- Back-relations on `Term`, `Course`, `Group` and `User` (named relations
  for the created / voided / recorded-by FKs), and on `StudentProfile`
  (`prices`, `charges`, `payments`).
- No change to `Lesson`, `AbsenceReport` or `MakeupCredit`. Billing reads
  them.
- `Charge` has **no** foreign key to `Lesson` / `Group` / `Term` / `Price`, on purpose
  (as `Notification`, phase5-rules.md §2.4). Charges must never block a
  lesson deletion that the timetable editor does or a price deletion (its
  voided lines keep the old `priceId`), and the description snapshot
  (amount source, unit, counts) keeps the line readable. `Price` does reference `Term` / `Course` /
  `Group` with `Restrict`. Deleting a course or group that has prices is
  refused (`HAS_PRICES`). Groups are soft-deleted anyway.
- `StudentProfile` relations use `Restrict`: a student with money history
  can't be hard-deleted (they are archived instead, as today).

## 10. Tests stages 2 and 3 must add

Unit (pure, no database):

- `billing/money.test.ts`: `parseMoney` for every accepted and rejected
  form, including EUR and JPY, grouping separators, too many decimals, sign
  and exponent. `toDecimalString` round-trip. `roundHalfUpDiv` at exact
  halves and with large values (bigint).
- `billing/rules.test.ts`: every row of the §2.2 table; `isMakeupLesson`
  over student reschedules, re-reschedules, admin reschedules of regular
  lessons and of makeups, _Book with credit_, and slot-split successors.
  Also: every `resolvePrice` level and the unpriced case; `PER_TERM`
  proration (join, leave, lessons cancelled by the school, zero lessons);
  posting times at the boundary (`endsAt = now` posts); due dates across
  DST; `planChargeSync`, each row of §2.5; reposting keeps
  `postedAt`/`dueDate`; `allocate` (including linked waivers: the waived line goes `WAIVED` while an older line stays overdue, a waiver larger than its line, a waiver on a voided line), status in first-match order, and overdue boundaries
  (`dueDate = today` is not overdue); and output independent of input order.
- `billing/rules.property.test.ts` on the realistic fixtures (20 teachers,
  60 groups, 15 rooms; seeded, with absences, replacements, reschedules,
  substitutes and membership changes):
  - sync twice gives an empty second plan
  - a random sequence of timetable, absence and price operations followed
    by a sync gives the same charges as a sync from scratch
  - every billable lesson is charged at most once per student
  - no makeup is ever charged
  - the allocation identity of §3.3 holds, with random linked and
    unlinked waivers
  - `PER_TERM` charges for full-term members equal the price exactly
- `reports/rules.test.ts`: every column definition, ended-only, the range
  boundaries in the school's time zone, filters, sort order, and the
  `TOO_MANY_ROWS` / `RANGE_TOO_LONG` errors. Teacher hours: `regular +
substitute = total`, Σ over teachers = Σ lesson minutes, a covered lesson
  counted for the substitute only, and `totalMinutes` equal to
  `teachingMinutes` (property test on the fixtures).
- `reports/csv.test.ts`: quoting, CRLF, BOM, the formula guard (and that
  numeric columns are never prefixed), a header-only empty result, a column
  order snapshot per report, and parsing the output back with a CSV parser.
- Import allow-list test (§6.2) and provider registry test (§4.6).

Database (`*.db.test.ts`, cleanup scoped to the spec's own `suffix`):

- payment, refund, void and correction each write exactly one audit row in
  the same transaction, and none after a rollback
- a double submit with the same `clientRequestId` stores one payment
- two concurrent syncs post each line once
- a price edit reprices in the same transaction, and `PREVIEW_OUT_OF_DATE`
  is refused
- `CURRENCY_LOCKED`
- refund checks against a concurrently recorded payment (billing lock)
- a no-op sync takes no lock and makes no writes; a sync with work
  re-plans under the lock
- school A's admin can't read, void or export school B's rows
  (`NOT_FOUND`)
- the whole-school sync budget of §2.5

The e2e permission cases are CARM-74's scope.

## 11. Points the design spec (CARM-70) must agree on

| #   | Point             | Rule here                                                                                                                                                                                                                                          |
| --- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Price setup       | Prices are set **per term**, per course or group, with optional per-student overrides. The unit is per lesson or per term. There is _Copy prices from {term}_, a _Needs pricing_ list, and a change preview with the count and delta before saving |
| B2  | Statement lines   | Lesson, term and adjustment lines, each with a paid / partially paid / unpaid state and a due date. Voided lines are shown to admins only, struck through, with the reason. Plus an _Upcoming this term_ section                                   |
| B3  | Recording         | Amount, method, date received, optional reference and note. Refunds can link to a payment. The refund-over-credit warning needs an acknowledgement. "Edit" is void + new                                                                           |
| B4  | Corrections       | Payments, refunds and adjustments are voided with a required reason. System charges have no void action; _Waive…_ is a negative adjustment linked to the line, allocated to it first (state `WAIVED` / partly waived, §3.3)                        |
| B5  | Statuses          | `NOTHING_DUE`, `SETTLED`, `IN_CREDIT`, `DUE`, `OVERDUE`. "Paid online" is a future `provider` ≠ `MANUAL` with a `PENDING` / `FAILED` status; no UI flow in v1                                                                                      |
| B6  | Student page      | Balance, status, next due date, active lines, payments and refunds. No notes, no void reasons, no admin names                                                                                                                                      |
| B7  | Report filters    | Attendance: term/range, group, teacher, student. Teacher hours: term/range, teacher, group, plus a lesson-detail export. Revenue: term/range **only**. Outstanding: as of now, with group and status filters                                       |
| B8  | Limits and states | Range ≤ 366 days; CSV > 50,000 rows refused with the count; range in the future = "until today"; attendance caption about reported absences; "figures reflect later corrections"                                                                   |
| B9  | Money formatting  | Through next-intl currency formatting from decimal strings. The CSV uses `125.50` + a currency column, not localised                                                                                                                               |

## 12. Defaults proposed for the owner to confirm

Each of these is one rule or one constant to change later:

1. **Missed lessons are billed, makeups are free** (§2.1). The alternative
   (not billing a missed lesson that earned a credit, and billing the
   makeup instead) would make the bill depend on whether the credit is ever
   used.
2. **Prices are per term** (not dated versions). A price change in the
   middle of a term is made with an adjustment or by editing that term's
   price, which reprices it with a preview.
3. **Per-lesson charges post when the lesson ends. Per-term charges post
   when the student's first lesson of the term starts**, and are prorated
   by lessons on joining or leaving.
4. **Payment term of 14 days**, and overdue = an unpaid share past its due
   date (oldest charges are paid first).
5. **Not in v1:** invoices or invoice numbers, VAT or tax, closing a period
   (a locked month), multiple currencies, payment reminders, discounts as
   percentages (use an override price or an adjustment), online payments,
   and parent accounts.
