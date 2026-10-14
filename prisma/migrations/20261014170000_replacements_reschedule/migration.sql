-- Phase 3: replacement booking, admin review and 1-on-1 reschedule
-- (CARM-43, docs/architecture/replacements.md §6, §7, §9).

-- AlterEnum
ALTER TYPE "ReplacementStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "lessons" ADD COLUMN     "rescheduled_from_id" UUID;

-- AlterTable
ALTER TABLE "makeup_credits" ADD COLUMN     "rescheduled_lesson_id" UUID;

-- Every booking spends a credit (v1). Fails if older rows lack one; no data
-- uses this table before Phase 3.
-- AlterTable
ALTER TABLE "replacement_requests" ADD COLUMN     "cancel_reason" TEXT,
ADD COLUMN     "cancelled_at" TIMESTAMP(3),
ALTER COLUMN "makeup_credit_id" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "lessons_school_id_rescheduled_from_id_key" ON "lessons"("school_id", "rescheduled_from_id");

-- CreateIndex
CREATE UNIQUE INDEX "makeup_credits_school_id_rescheduled_lesson_id_key" ON "makeup_credits"("school_id", "rescheduled_lesson_id");

-- CreateIndex
CREATE INDEX "replacement_requests_school_id_original_lesson_id_idx" ON "replacement_requests"("school_id", "original_lesson_id");

-- AddForeignKey
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_school_id_rescheduled_from_id_fkey" FOREIGN KEY ("school_id", "rescheduled_from_id") REFERENCES "lessons"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "makeup_credits" ADD CONSTRAINT "makeup_credits_school_id_rescheduled_lesson_id_fkey" FOREIGN KEY ("school_id", "rescheduled_lesson_id") REFERENCES "lessons"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Partial unique indexes (hand-written; Prisma does not model them).

-- A credit backs at most one active booking.
CREATE UNIQUE INDEX "replacement_requests_active_credit_key"
  ON "replacement_requests"("makeup_credit_id")
  WHERE "status" IN ('AUTO_APPROVED', 'APPROVED', 'OVERRIDDEN');

-- No double booking of the same lesson.
CREATE UNIQUE INDEX "replacement_requests_active_student_target_key"
  ON "replacement_requests"("student_id", "target_lesson_id")
  WHERE "status" IN ('AUTO_APPROVED', 'APPROVED', 'OVERRIDDEN');

-- CHECK constraints (hand-written; Prisma does not model or diff them).
-- `status::text`: the new enum value can't be used as a literal in the
-- transaction that adds it.

ALTER TABLE "replacement_requests"
  ADD CONSTRAINT "replacement_requests_cancelled_check"
    CHECK (("cancelled_at" IS NOT NULL) = ("status"::text = 'CANCELLED')),
  ADD CONSTRAINT "replacement_requests_cancel_reason_check"
    CHECK ("cancel_reason" IS NULL OR "cancel_reason" IN ('STUDENT', 'STUDENT_LATE', 'LESSON_CANCELLED')),
  ADD CONSTRAINT "replacement_requests_review_note_length_check"
    CHECK ("review_note" IS NULL OR char_length("review_note") <= 300);

ALTER TABLE "makeup_credits"
  ADD CONSTRAINT "makeup_credits_rescheduled_lesson_check"
    CHECK ("rescheduled_lesson_id" IS NULL OR "status" = 'USED');

-- Only ad-hoc lessons are reschedules.
ALTER TABLE "lessons"
  ADD CONSTRAINT "lessons_rescheduled_from_check"
    CHECK ("rescheduled_from_id" IS NULL OR "timetable_slot_id" IS NULL),
  ADD CONSTRAINT "lessons_rescheduled_from_self_check"
    CHECK ("rescheduled_from_id" IS NULL OR "rescheduled_from_id" <> "id");
