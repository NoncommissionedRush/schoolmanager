-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'TEACHER', 'STUDENT');

-- CreateEnum
CREATE TYPE "GroupType" AS ENUM ('GROUP', 'ONE_ON_ONE');

-- CreateEnum
CREATE TYPE "RoomKind" AS ENUM ('PHYSICAL', 'ONLINE');

-- CreateEnum
CREATE TYPE "AvailabilityKind" AS ENUM ('WEEKLY_UNAVAILABLE', 'DATE_UNAVAILABLE', 'DATE_AVAILABLE');

-- CreateEnum
CREATE TYPE "LessonStatus" AS ENUM ('SCHEDULED', 'CANCELLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'LATE', 'ABSENT', 'EXCUSED');

-- CreateEnum
CREATE TYPE "ReplacementStatus" AS ENUM ('AUTO_APPROVED', 'APPROVED', 'REJECTED', 'OVERRIDDEN');

-- CreateEnum
CREATE TYPE "MakeupCreditStatus" AS ENUM ('AVAILABLE', 'USED', 'EXPIRED');

-- AlterTable
ALTER TABLE "schools" ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Europe/Bratislava';

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teacher_profiles" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "bio" TEXT,
    "color" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teacher_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_profiles" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "level_id" UUID,
    "phone" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "levels" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courses" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "level_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "groups" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "course_id" UUID,
    "level_id" UUID NOT NULL,
    "type" "GroupType" NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_memberships" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "RoomKind" NOT NULL,
    "capacity" INTEGER,
    "meeting_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "terms" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "timetable_published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holidays" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "term_id" UUID,
    "name" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teacher_availability" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "teacher_id" UUID NOT NULL,
    "kind" "AvailabilityKind" NOT NULL,
    "weekday" INTEGER,
    "date" DATE,
    "start_minute" INTEGER,
    "end_minute" INTEGER,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teacher_availability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timetable_slots" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "term_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "teacher_id" UUID NOT NULL,
    "room_id" UUID,
    "weekday" INTEGER NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "timetable_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lessons" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "term_id" UUID NOT NULL,
    "timetable_slot_id" UUID,
    "group_id" UUID NOT NULL,
    "teacher_id" UUID NOT NULL,
    "substitute_teacher_id" UUID,
    "room_id" UUID,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "LessonStatus" NOT NULL DEFAULT 'SCHEDULED',
    "cancel_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lessons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "lesson_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "note" TEXT,
    "recorded_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lesson_logs" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "lesson_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lesson_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignments" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "lesson_id" UUID,
    "due_lesson_id" UUID,
    "due_date" DATE,
    "author_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teacher_notes" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "student_id" UUID,
    "group_id" UUID,
    "lesson_id" UUID,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teacher_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "absence_reports" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "lesson_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "reported_by_id" UUID,
    "reason" TEXT,
    "reported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "absence_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "makeup_credits" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "source_lesson_id" UUID NOT NULL,
    "absence_report_id" UUID,
    "status" "MakeupCreditStatus" NOT NULL DEFAULT 'AVAILABLE',
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "makeup_credits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "replacement_requests" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "original_lesson_id" UUID NOT NULL,
    "target_lesson_id" UUID NOT NULL,
    "makeup_credit_id" UUID,
    "status" "ReplacementStatus" NOT NULL DEFAULT 'AUTO_APPROVED',
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "review_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "replacement_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "memberships_user_id_idx" ON "memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_school_id_user_id_role_key" ON "memberships"("school_id", "user_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_school_id_id_key" ON "memberships"("school_id", "id");

-- CreateIndex
CREATE INDEX "teacher_profiles_user_id_idx" ON "teacher_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "teacher_profiles_school_id_user_id_key" ON "teacher_profiles"("school_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "teacher_profiles_school_id_id_key" ON "teacher_profiles"("school_id", "id");

-- CreateIndex
CREATE INDEX "student_profiles_user_id_idx" ON "student_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_profiles_school_id_user_id_key" ON "student_profiles"("school_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_profiles_school_id_id_key" ON "student_profiles"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "levels_school_id_code_key" ON "levels"("school_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "levels_school_id_rank_key" ON "levels"("school_id", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "levels_school_id_id_key" ON "levels"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "courses_school_id_name_key" ON "courses"("school_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "courses_school_id_id_key" ON "courses"("school_id", "id");

-- CreateIndex
CREATE INDEX "groups_school_id_level_id_idx" ON "groups"("school_id", "level_id");

-- CreateIndex
CREATE UNIQUE INDEX "groups_school_id_name_key" ON "groups"("school_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "groups_school_id_id_key" ON "groups"("school_id", "id");

-- CreateIndex
CREATE INDEX "group_memberships_school_id_student_id_idx" ON "group_memberships"("school_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_memberships_group_id_student_id_key" ON "group_memberships"("group_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_memberships_school_id_id_key" ON "group_memberships"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_school_id_name_key" ON "rooms"("school_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_school_id_id_key" ON "rooms"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "terms_school_id_name_key" ON "terms"("school_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "terms_school_id_id_key" ON "terms"("school_id", "id");

-- CreateIndex
CREATE INDEX "holidays_school_id_start_date_idx" ON "holidays"("school_id", "start_date");

-- CreateIndex
CREATE UNIQUE INDEX "holidays_school_id_id_key" ON "holidays"("school_id", "id");

-- CreateIndex
CREATE INDEX "teacher_availability_school_id_teacher_id_idx" ON "teacher_availability"("school_id", "teacher_id");

-- CreateIndex
CREATE UNIQUE INDEX "teacher_availability_school_id_id_key" ON "teacher_availability"("school_id", "id");

-- CreateIndex
CREATE INDEX "timetable_slots_school_id_term_id_weekday_idx" ON "timetable_slots"("school_id", "term_id", "weekday");

-- CreateIndex
CREATE INDEX "timetable_slots_school_id_teacher_id_idx" ON "timetable_slots"("school_id", "teacher_id");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_slots_school_id_id_key" ON "timetable_slots"("school_id", "id");

-- CreateIndex
CREATE INDEX "lessons_school_id_starts_at_idx" ON "lessons"("school_id", "starts_at");

-- CreateIndex
CREATE INDEX "lessons_school_id_group_id_starts_at_idx" ON "lessons"("school_id", "group_id", "starts_at");

-- CreateIndex
CREATE INDEX "lessons_school_id_teacher_id_starts_at_idx" ON "lessons"("school_id", "teacher_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "lessons_timetable_slot_id_starts_at_key" ON "lessons"("timetable_slot_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "lessons_school_id_id_key" ON "lessons"("school_id", "id");

-- CreateIndex
CREATE INDEX "attendance_school_id_student_id_idx" ON "attendance"("school_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_lesson_id_student_id_key" ON "attendance"("lesson_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_school_id_id_key" ON "attendance"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lesson_logs_school_id_lesson_id_key" ON "lesson_logs"("school_id", "lesson_id");

-- CreateIndex
CREATE UNIQUE INDEX "lesson_logs_school_id_id_key" ON "lesson_logs"("school_id", "id");

-- CreateIndex
CREATE INDEX "assignments_school_id_group_id_idx" ON "assignments"("school_id", "group_id");

-- CreateIndex
CREATE UNIQUE INDEX "assignments_school_id_id_key" ON "assignments"("school_id", "id");

-- CreateIndex
CREATE INDEX "teacher_notes_school_id_student_id_idx" ON "teacher_notes"("school_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "teacher_notes_school_id_id_key" ON "teacher_notes"("school_id", "id");

-- CreateIndex
CREATE INDEX "absence_reports_school_id_student_id_idx" ON "absence_reports"("school_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "absence_reports_lesson_id_student_id_key" ON "absence_reports"("lesson_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "absence_reports_school_id_id_key" ON "absence_reports"("school_id", "id");

-- CreateIndex
CREATE INDEX "makeup_credits_school_id_student_id_status_idx" ON "makeup_credits"("school_id", "student_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "makeup_credits_student_id_source_lesson_id_key" ON "makeup_credits"("student_id", "source_lesson_id");

-- CreateIndex
CREATE UNIQUE INDEX "makeup_credits_school_id_id_key" ON "makeup_credits"("school_id", "id");

-- CreateIndex
CREATE INDEX "replacement_requests_school_id_status_idx" ON "replacement_requests"("school_id", "status");

-- CreateIndex
CREATE INDEX "replacement_requests_school_id_target_lesson_id_idx" ON "replacement_requests"("school_id", "target_lesson_id");

-- CreateIndex
CREATE INDEX "replacement_requests_school_id_student_id_idx" ON "replacement_requests"("school_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "replacement_requests_school_id_id_key" ON "replacement_requests"("school_id", "id");

-- CreateIndex
CREATE INDEX "audit_logs_school_id_entity_type_entity_id_idx" ON "audit_logs"("school_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_school_id_created_at_idx" ON "audit_logs"("school_id", "created_at");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_profiles" ADD CONSTRAINT "teacher_profiles_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_profiles" ADD CONSTRAINT "teacher_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_school_id_level_id_fkey" FOREIGN KEY ("school_id", "level_id") REFERENCES "levels"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "levels" ADD CONSTRAINT "levels_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_school_id_level_id_fkey" FOREIGN KEY ("school_id", "level_id") REFERENCES "levels"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_school_id_course_id_fkey" FOREIGN KEY ("school_id", "course_id") REFERENCES "courses"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_school_id_level_id_fkey" FOREIGN KEY ("school_id", "level_id") REFERENCES "levels"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_school_id_group_id_fkey" FOREIGN KEY ("school_id", "group_id") REFERENCES "groups"("school_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_school_id_student_id_fkey" FOREIGN KEY ("school_id", "student_id") REFERENCES "student_profiles"("school_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terms" ADD CONSTRAINT "terms_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_school_id_term_id_fkey" FOREIGN KEY ("school_id", "term_id") REFERENCES "terms"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_availability" ADD CONSTRAINT "teacher_availability_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_availability" ADD CONSTRAINT "teacher_availability_school_id_teacher_id_fkey" FOREIGN KEY ("school_id", "teacher_id") REFERENCES "teacher_profiles"("school_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_school_id_term_id_fkey" FOREIGN KEY ("school_id", "term_id") REFERENCES "terms"("school_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_school_id_group_id_fkey" FOREIGN KEY ("school_id", "group_id") REFERENCES "groups"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_school_id_teacher_id_fkey" FOREIGN KEY ("school_id", "teacher_id") REFERENCES "teacher_profiles"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_school_id_room_id_fkey" FOREIGN KEY ("school_id", "room_id") REFERENCES "rooms"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_school_id_term_id_fkey" FOREIGN KEY ("school_id", "term_id") REFERENCES "terms"("school_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_school_id_timetable_slot_id_fkey" FOREIGN KEY ("school_id", "timetable_slot_id") REFERENCES "timetable_slots"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_school_id_group_id_fkey" FOREIGN KEY ("school_id", "group_id") REFERENCES "groups"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_school_id_teacher_id_fkey" FOREIGN KEY ("school_id", "teacher_id") REFERENCES "teacher_profiles"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_school_id_substitute_teacher_id_fkey" FOREIGN KEY ("school_id", "substitute_teacher_id") REFERENCES "teacher_profiles"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_school_id_room_id_fkey" FOREIGN KEY ("school_id", "room_id") REFERENCES "rooms"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_school_id_lesson_id_fkey" FOREIGN KEY ("school_id", "lesson_id") REFERENCES "lessons"("school_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_school_id_student_id_fkey" FOREIGN KEY ("school_id", "student_id") REFERENCES "student_profiles"("school_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_logs" ADD CONSTRAINT "lesson_logs_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_logs" ADD CONSTRAINT "lesson_logs_school_id_lesson_id_fkey" FOREIGN KEY ("school_id", "lesson_id") REFERENCES "lessons"("school_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_logs" ADD CONSTRAINT "lesson_logs_school_id_author_id_fkey" FOREIGN KEY ("school_id", "author_id") REFERENCES "teacher_profiles"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_school_id_group_id_fkey" FOREIGN KEY ("school_id", "group_id") REFERENCES "groups"("school_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_school_id_lesson_id_fkey" FOREIGN KEY ("school_id", "lesson_id") REFERENCES "lessons"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_school_id_due_lesson_id_fkey" FOREIGN KEY ("school_id", "due_lesson_id") REFERENCES "lessons"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_school_id_author_id_fkey" FOREIGN KEY ("school_id", "author_id") REFERENCES "teacher_profiles"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_notes" ADD CONSTRAINT "teacher_notes_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_notes" ADD CONSTRAINT "teacher_notes_school_id_author_id_fkey" FOREIGN KEY ("school_id", "author_id") REFERENCES "teacher_profiles"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_notes" ADD CONSTRAINT "teacher_notes_school_id_student_id_fkey" FOREIGN KEY ("school_id", "student_id") REFERENCES "student_profiles"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_notes" ADD CONSTRAINT "teacher_notes_school_id_group_id_fkey" FOREIGN KEY ("school_id", "group_id") REFERENCES "groups"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_notes" ADD CONSTRAINT "teacher_notes_school_id_lesson_id_fkey" FOREIGN KEY ("school_id", "lesson_id") REFERENCES "lessons"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "absence_reports" ADD CONSTRAINT "absence_reports_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "absence_reports" ADD CONSTRAINT "absence_reports_school_id_lesson_id_fkey" FOREIGN KEY ("school_id", "lesson_id") REFERENCES "lessons"("school_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "absence_reports" ADD CONSTRAINT "absence_reports_school_id_student_id_fkey" FOREIGN KEY ("school_id", "student_id") REFERENCES "student_profiles"("school_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "absence_reports" ADD CONSTRAINT "absence_reports_reported_by_id_fkey" FOREIGN KEY ("reported_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "makeup_credits" ADD CONSTRAINT "makeup_credits_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "makeup_credits" ADD CONSTRAINT "makeup_credits_school_id_student_id_fkey" FOREIGN KEY ("school_id", "student_id") REFERENCES "student_profiles"("school_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "makeup_credits" ADD CONSTRAINT "makeup_credits_school_id_source_lesson_id_fkey" FOREIGN KEY ("school_id", "source_lesson_id") REFERENCES "lessons"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "makeup_credits" ADD CONSTRAINT "makeup_credits_school_id_absence_report_id_fkey" FOREIGN KEY ("school_id", "absence_report_id") REFERENCES "absence_reports"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replacement_requests" ADD CONSTRAINT "replacement_requests_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replacement_requests" ADD CONSTRAINT "replacement_requests_school_id_student_id_fkey" FOREIGN KEY ("school_id", "student_id") REFERENCES "student_profiles"("school_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replacement_requests" ADD CONSTRAINT "replacement_requests_school_id_original_lesson_id_fkey" FOREIGN KEY ("school_id", "original_lesson_id") REFERENCES "lessons"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replacement_requests" ADD CONSTRAINT "replacement_requests_school_id_target_lesson_id_fkey" FOREIGN KEY ("school_id", "target_lesson_id") REFERENCES "lessons"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replacement_requests" ADD CONSTRAINT "replacement_requests_school_id_makeup_credit_id_fkey" FOREIGN KEY ("school_id", "makeup_credit_id") REFERENCES "makeup_credits"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replacement_requests" ADD CONSTRAINT "replacement_requests_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- CHECK constraints (hand-written; Prisma does not model or diff them)
-- ---------------------------------------------------------------------------

ALTER TABLE "groups"
  ADD CONSTRAINT "groups_capacity_check" CHECK ("capacity" >= 1),
  ADD CONSTRAINT "groups_one_on_one_capacity_check" CHECK ("type" <> 'ONE_ON_ONE' OR "capacity" = 1);

ALTER TABLE "rooms"
  ADD CONSTRAINT "rooms_capacity_check" CHECK ("capacity" IS NULL OR "capacity" >= 1);

ALTER TABLE "terms"
  ADD CONSTRAINT "terms_dates_check" CHECK ("start_date" <= "end_date");

ALTER TABLE "holidays"
  ADD CONSTRAINT "holidays_dates_check" CHECK ("start_date" <= "end_date");

ALTER TABLE "timetable_slots"
  ADD CONSTRAINT "timetable_slots_weekday_check" CHECK ("weekday" BETWEEN 1 AND 7),
  ADD CONSTRAINT "timetable_slots_minutes_check" CHECK (0 <= "start_minute" AND "start_minute" < "end_minute" AND "end_minute" <= 1440);

ALTER TABLE "teacher_availability"
  ADD CONSTRAINT "teacher_availability_minutes_check" CHECK (
    ("start_minute" IS NULL AND "end_minute" IS NULL)
    OR (0 <= "start_minute" AND "start_minute" < "end_minute" AND "end_minute" <= 1440)
  ),
  ADD CONSTRAINT "teacher_availability_shape_check" CHECK (
    CASE "kind"
      WHEN 'WEEKLY_UNAVAILABLE' THEN "weekday" BETWEEN 1 AND 7 AND "date" IS NULL AND "start_minute" IS NOT NULL
      ELSE "weekday" IS NULL AND "date" IS NOT NULL
    END
  );

ALTER TABLE "lessons"
  ADD CONSTRAINT "lessons_time_check" CHECK ("starts_at" < "ends_at"),
  ADD CONSTRAINT "lessons_substitute_check" CHECK ("substitute_teacher_id" IS NULL OR "substitute_teacher_id" <> "teacher_id");

ALTER TABLE "assignments"
  ADD CONSTRAINT "assignments_due_check" CHECK ("due_lesson_id" IS NOT NULL OR "due_date" IS NOT NULL);

ALTER TABLE "teacher_notes"
  ADD CONSTRAINT "teacher_notes_subject_check" CHECK ("student_id" IS NOT NULL OR "group_id" IS NOT NULL OR "lesson_id" IS NOT NULL);

ALTER TABLE "replacement_requests"
  ADD CONSTRAINT "replacement_requests_lessons_check" CHECK ("original_lesson_id" <> "target_lesson_id");
