-- Phase 3: absence reporting, makeup credits and their school settings
-- (CARM-42, docs/architecture/replacements.md §2, §9).

-- One timestamp per report: `created_at` is when it was reported.
UPDATE "absence_reports" SET "created_at" = "reported_at";

-- AlterTable
ALTER TABLE "absence_reports" DROP COLUMN "reported_at";

-- Every credit comes from an absence and expires (v1). Fails if older rows
-- lack either; no data uses these tables before Phase 3.
-- AlterTable
ALTER TABLE "makeup_credits" ADD COLUMN     "used_at" TIMESTAMP(3),
ALTER COLUMN "absence_report_id" SET NOT NULL,
ALTER COLUMN "expires_at" SET NOT NULL;

-- AlterTable
ALTER TABLE "schools" ADD COLUMN     "absence_cutoff_minutes" INTEGER NOT NULL DEFAULT 1440,
ADD COLUMN     "makeup_credit_valid_days" INTEGER NOT NULL DEFAULT 30;

-- CreateIndex (the lazy expiry update, §4)
CREATE INDEX "makeup_credits_school_id_status_expires_at_idx" ON "makeup_credits"("school_id", "status", "expires_at");

-- CreateIndex (one credit per absence)
CREATE UNIQUE INDEX "makeup_credits_school_id_absence_report_id_key" ON "makeup_credits"("school_id", "absence_report_id");

-- CHECK constraints (hand-written; Prisma does not model or diff them)

ALTER TABLE "schools"
  ADD CONSTRAINT "schools_absence_cutoff_minutes_check" CHECK ("absence_cutoff_minutes" BETWEEN 0 AND 20160),
  ADD CONSTRAINT "schools_makeup_credit_valid_days_check" CHECK ("makeup_credit_valid_days" BETWEEN 1 AND 365);

ALTER TABLE "makeup_credits"
  ADD CONSTRAINT "makeup_credits_used_at_check" CHECK ("used_at" IS NULL OR "status" = 'USED');

ALTER TABLE "absence_reports"
  ADD CONSTRAINT "absence_reports_reason_length_check" CHECK ("reason" IS NULL OR char_length("reason") <= 300);
