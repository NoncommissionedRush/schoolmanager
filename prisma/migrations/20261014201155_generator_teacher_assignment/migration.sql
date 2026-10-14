-- CreateEnum
CREATE TYPE "DraftMode" AS ENUM ('REPLACE', 'FILL', 'REPLAN_FROM');

-- CreateEnum
CREATE TYPE "DraftAssignmentOrigin" AS ENUM ('GENERATED', 'MANUAL', 'IMPORTED');

-- CreateEnum
CREATE TYPE "GeneratorRunStatus" AS ENUM ('RUNNING', 'DONE', 'CANCELLED', 'FAILED');

-- AlterTable
ALTER TABLE "teacher_profiles" ADD COLUMN     "max_minutes_per_week" INTEGER;

-- CreateTable
CREATE TABLE "group_lesson_times" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    "room_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_lesson_times_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_term_skips" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "term_id" UUID NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_term_skips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teacher_levels" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "teacher_id" UUID NOT NULL,
    "level_id" UUID NOT NULL,

    CONSTRAINT "teacher_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timetable_drafts" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "term_id" UUID NOT NULL,
    "mode" "DraftMode" NOT NULL,
    "effective_from" DATE,
    "version" INTEGER NOT NULL DEFAULT 0,
    "input_fingerprint" TEXT,
    "generated_at" TIMESTAMP(3),
    "summary" JSONB,
    "unassigned" JSONB NOT NULL DEFAULT '[]',
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "run_stats" JSONB,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "timetable_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timetable_draft_assignments" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "teacher_id" UUID,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "origin" "DraftAssignmentOrigin" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "timetable_draft_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generator_runs" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "term_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "status" "GeneratorRunStatus" NOT NULL DEFAULT 'RUNNING',
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "max_iterations" INTEGER NOT NULL,
    "time_limit_ms" INTEGER NOT NULL,
    "progress" JSONB,
    "heartbeat_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result" JSONB,
    "error_code" TEXT,
    "started_by_id" UUID,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "generator_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "group_lesson_times_school_id_group_id_idx" ON "group_lesson_times"("school_id", "group_id");

-- CreateIndex
CREATE INDEX "group_lesson_times_school_id_room_id_weekday_idx" ON "group_lesson_times"("school_id", "room_id", "weekday");

-- CreateIndex
CREATE UNIQUE INDEX "group_lesson_times_school_id_id_key" ON "group_lesson_times"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "group_term_skips_school_id_group_id_term_id_key" ON "group_term_skips"("school_id", "group_id", "term_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_term_skips_school_id_id_key" ON "group_term_skips"("school_id", "id");

-- CreateIndex
CREATE INDEX "teacher_levels_school_id_level_id_idx" ON "teacher_levels"("school_id", "level_id");

-- CreateIndex
CREATE UNIQUE INDEX "teacher_levels_school_id_teacher_id_level_id_key" ON "teacher_levels"("school_id", "teacher_id", "level_id");

-- CreateIndex
CREATE UNIQUE INDEX "teacher_levels_school_id_id_key" ON "teacher_levels"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_drafts_school_id_term_id_key" ON "timetable_drafts"("school_id", "term_id");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_drafts_school_id_id_key" ON "timetable_drafts"("school_id", "id");

-- CreateIndex
CREATE INDEX "timetable_draft_assignments_school_id_teacher_id_idx" ON "timetable_draft_assignments"("school_id", "teacher_id");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_draft_assignments_draft_id_group_id_key" ON "timetable_draft_assignments"("draft_id", "group_id");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_draft_assignments_school_id_id_key" ON "timetable_draft_assignments"("school_id", "id");

-- CreateIndex
CREATE INDEX "generator_runs_school_id_term_id_started_at_idx" ON "generator_runs"("school_id", "term_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "generator_runs_school_id_id_key" ON "generator_runs"("school_id", "id");

-- AddForeignKey
ALTER TABLE "group_lesson_times" ADD CONSTRAINT "group_lesson_times_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_lesson_times" ADD CONSTRAINT "group_lesson_times_school_id_group_id_fkey" FOREIGN KEY ("school_id", "group_id") REFERENCES "groups"("school_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_lesson_times" ADD CONSTRAINT "group_lesson_times_school_id_room_id_fkey" FOREIGN KEY ("school_id", "room_id") REFERENCES "rooms"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_term_skips" ADD CONSTRAINT "group_term_skips_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_term_skips" ADD CONSTRAINT "group_term_skips_school_id_group_id_fkey" FOREIGN KEY ("school_id", "group_id") REFERENCES "groups"("school_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_term_skips" ADD CONSTRAINT "group_term_skips_school_id_term_id_fkey" FOREIGN KEY ("school_id", "term_id") REFERENCES "terms"("school_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_term_skips" ADD CONSTRAINT "group_term_skips_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_levels" ADD CONSTRAINT "teacher_levels_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_levels" ADD CONSTRAINT "teacher_levels_school_id_teacher_id_fkey" FOREIGN KEY ("school_id", "teacher_id") REFERENCES "teacher_profiles"("school_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_levels" ADD CONSTRAINT "teacher_levels_school_id_level_id_fkey" FOREIGN KEY ("school_id", "level_id") REFERENCES "levels"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_drafts" ADD CONSTRAINT "timetable_drafts_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_drafts" ADD CONSTRAINT "timetable_drafts_school_id_term_id_fkey" FOREIGN KEY ("school_id", "term_id") REFERENCES "terms"("school_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_drafts" ADD CONSTRAINT "timetable_drafts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_draft_assignments" ADD CONSTRAINT "timetable_draft_assignments_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_draft_assignments" ADD CONSTRAINT "timetable_draft_assignments_school_id_draft_id_fkey" FOREIGN KEY ("school_id", "draft_id") REFERENCES "timetable_drafts"("school_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_draft_assignments" ADD CONSTRAINT "timetable_draft_assignments_school_id_group_id_fkey" FOREIGN KEY ("school_id", "group_id") REFERENCES "groups"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_draft_assignments" ADD CONSTRAINT "timetable_draft_assignments_school_id_teacher_id_fkey" FOREIGN KEY ("school_id", "teacher_id") REFERENCES "teacher_profiles"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generator_runs" ADD CONSTRAINT "generator_runs_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generator_runs" ADD CONSTRAINT "generator_runs_school_id_term_id_fkey" FOREIGN KEY ("school_id", "term_id") REFERENCES "terms"("school_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generator_runs" ADD CONSTRAINT "generator_runs_school_id_draft_id_fkey" FOREIGN KEY ("school_id", "draft_id") REFERENCES "timetable_drafts"("school_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generator_runs" ADD CONSTRAINT "generator_runs_started_by_id_fkey" FOREIGN KEY ("started_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written: Prisma does not model CHECK constraints or partial indexes
-- (docs/architecture/generator.md §8). "At most 7 lesson times per group" and
-- "no overlap within a group" are cross-row; the service enforces them.
ALTER TABLE "group_lesson_times"
  ADD CONSTRAINT "group_lesson_times_time_check" CHECK (
    "weekday" BETWEEN 1 AND 7
    AND 0 <= "start_minute"
    AND "start_minute" < "end_minute"
    AND "end_minute" <= 1440
    AND "start_minute" % 5 = 0
    AND "end_minute" % 5 = 0
  );

ALTER TABLE "teacher_profiles"
  ADD CONSTRAINT "teacher_profiles_max_minutes_check" CHECK (
    "max_minutes_per_week" IS NULL
    OR "max_minutes_per_week" BETWEEN 15 AND 6000
  );

ALTER TABLE "timetable_drafts"
  ADD CONSTRAINT "timetable_drafts_effective_from_check" CHECK (
    ("mode" <> 'REPLACE') = ("effective_from" IS NOT NULL)
  );

-- One running generator run per term.
CREATE UNIQUE INDEX "generator_runs_one_running_per_term"
  ON "generator_runs" ("school_id", "term_id")
  WHERE "status" = 'RUNNING';
