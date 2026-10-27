-- CreateEnum
CREATE TYPE "AvailabilityRequestKind" AS ENUM ('ADD_WEEKLY', 'EDIT_WEEKLY', 'ADD_EXCEPTION', 'DELETE_RULE');

-- CreateEnum
CREATE TYPE "AvailabilityRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'AVAILABILITY_REQUEST_PENDING';
ALTER TYPE "NotificationType" ADD VALUE 'AVAILABILITY_REQUEST_DECIDED';

-- CreateTable
CREATE TABLE "availability_requests" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "teacher_id" UUID NOT NULL,
    "kind" "AvailabilityRequestKind" NOT NULL,
    "target_id" UUID,
    "payload" JSONB NOT NULL,
    "status" "AvailabilityRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "review_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "availability_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "availability_requests_school_id_teacher_id_status_idx" ON "availability_requests"("school_id", "teacher_id", "status");

-- CreateIndex
CREATE INDEX "availability_requests_school_id_status_idx" ON "availability_requests"("school_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "availability_requests_school_id_id_key" ON "availability_requests"("school_id", "id");

-- AddForeignKey
ALTER TABLE "availability_requests" ADD CONSTRAINT "availability_requests_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_requests" ADD CONSTRAINT "availability_requests_school_id_teacher_id_fkey" FOREIGN KEY ("school_id", "teacher_id") REFERENCES "teacher_profiles"("school_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_requests" ADD CONSTRAINT "availability_requests_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CHECK constraints (hand-written; Prisma does not model or diff them)
ALTER TABLE "availability_requests"
  ADD CONSTRAINT "availability_requests_target_check" CHECK (
    ("kind" IN ('EDIT_WEEKLY', 'DELETE_RULE')) = ("target_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "availability_requests_reviewed_check" CHECK (
    ("status" IN ('APPROVED', 'REJECTED')) = ("reviewed_at" IS NOT NULL)
  );
