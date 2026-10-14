-- DropForeignKey
ALTER TABLE "holidays" DROP CONSTRAINT "holidays_school_id_term_id_fkey";

-- DropForeignKey
ALTER TABLE "lessons" DROP CONSTRAINT "lessons_school_id_term_id_fkey";

-- AlterTable
ALTER TABLE "schools" ADD COLUMN     "day_end_minute" INTEGER NOT NULL DEFAULT 1260,
ADD COLUMN     "day_start_minute" INTEGER NOT NULL DEFAULT 420,
ADD COLUMN     "teaching_weekdays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5, 6]::INTEGER[];

-- AlterTable
ALTER TABLE "timetable_slots" ADD COLUMN     "valid_from" DATE,
ADD COLUMN     "valid_until" DATE;

-- AddForeignKey
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_school_id_term_id_fkey" FOREIGN KEY ("school_id", "term_id") REFERENCES "terms"("school_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_school_id_term_id_fkey" FOREIGN KEY ("school_id", "term_id") REFERENCES "terms"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written (Prisma does not model NOT NULL arrays or CHECK constraints)
-- ---------------------------------------------------------------------------

-- Prisma lists cannot be optional, so the column must not be either.
ALTER TABLE "schools" ALTER COLUMN "teaching_weekdays" SET NOT NULL;

ALTER TABLE "schools"
  ADD CONSTRAINT "schools_teaching_weekdays_check" CHECK (
    cardinality("teaching_weekdays") >= 1
    AND "teaching_weekdays" <@ ARRAY[1, 2, 3, 4, 5, 6, 7]
  ),
  ADD CONSTRAINT "schools_day_minutes_check" CHECK (
    0 <= "day_start_minute" AND "day_start_minute" < "day_end_minute" AND "day_end_minute" <= 1440
  );

-- No CHECK on valid_from <= valid_until: a slot edited before its first
-- lesson whose only remaining lessons are cancelled ones is kept with an empty
-- range (never in effect) so those lessons keep their slot. See
-- docs/architecture/scheduling.md.
CREATE INDEX "timetable_slots_school_id_group_id_idx" ON "timetable_slots"("school_id", "group_id");
