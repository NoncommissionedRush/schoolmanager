-- Phase 2 (CARM-35, docs/design/lessons.md §11): homework is one text on
-- the lesson log; attendance and assignments are no longer tracked.
-- DropForeignKey
ALTER TABLE "assignments" DROP CONSTRAINT "assignments_school_id_author_id_fkey";

-- DropForeignKey
ALTER TABLE "assignments" DROP CONSTRAINT "assignments_school_id_due_lesson_id_fkey";

-- DropForeignKey
ALTER TABLE "assignments" DROP CONSTRAINT "assignments_school_id_fkey";

-- DropForeignKey
ALTER TABLE "assignments" DROP CONSTRAINT "assignments_school_id_group_id_fkey";

-- DropForeignKey
ALTER TABLE "assignments" DROP CONSTRAINT "assignments_school_id_lesson_id_fkey";

-- DropForeignKey
ALTER TABLE "attendance" DROP CONSTRAINT "attendance_recorded_by_id_fkey";

-- DropForeignKey
ALTER TABLE "attendance" DROP CONSTRAINT "attendance_school_id_fkey";

-- DropForeignKey
ALTER TABLE "attendance" DROP CONSTRAINT "attendance_school_id_lesson_id_fkey";

-- DropForeignKey
ALTER TABLE "attendance" DROP CONSTRAINT "attendance_school_id_student_id_fkey";

-- AlterTable: existing logs were last saved by their author.
ALTER TABLE "lesson_logs" ADD COLUMN     "homework" TEXT,
ADD COLUMN     "updated_by_id" UUID,
ALTER COLUMN "content" DROP NOT NULL;
UPDATE "lesson_logs" SET "updated_by_id" = "author_id";
ALTER TABLE "lesson_logs" ALTER COLUMN "updated_by_id" SET NOT NULL;

-- A log with both texts empty is deleted, never stored. Limits mirror the
-- zod schemas (covered ≤ 5,000, homework ≤ 2,000, note ≤ 2,000).
ALTER TABLE "lesson_logs" ADD CONSTRAINT "lesson_logs_not_empty"
  CHECK ("content" IS NOT NULL OR "homework" IS NOT NULL);
ALTER TABLE "lesson_logs" ADD CONSTRAINT "lesson_logs_content_length"
  CHECK (char_length("content") <= 5000);
ALTER TABLE "lesson_logs" ADD CONSTRAINT "lesson_logs_homework_length"
  CHECK (char_length("homework") <= 2000);
ALTER TABLE "teacher_notes" ADD CONSTRAINT "teacher_notes_body_length"
  CHECK (char_length("body") <= 2000);

-- DropTable
DROP TABLE "assignments";

-- DropTable
DROP TABLE "attendance";

-- DropEnum
DROP TYPE "AttendanceStatus";

-- CreateIndex
CREATE INDEX "teacher_notes_school_id_group_id_idx" ON "teacher_notes"("school_id", "group_id");

-- CreateIndex
CREATE INDEX "teacher_notes_school_id_lesson_id_idx" ON "teacher_notes"("school_id", "lesson_id");

-- AddForeignKey
ALTER TABLE "lesson_logs" ADD CONSTRAINT "lesson_logs_school_id_updated_by_id_fkey" FOREIGN KEY ("school_id", "updated_by_id") REFERENCES "teacher_profiles"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
