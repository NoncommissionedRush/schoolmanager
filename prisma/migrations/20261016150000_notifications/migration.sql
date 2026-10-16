-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('LESSON_CANCELLED', 'LESSON_MOVED', 'SUBSTITUTE_ASSIGNED', 'SUBSTITUTE_REMOVED', 'ABSENCE_REPORTED', 'REPLACEMENT_BOOKED', 'REPLACEMENT_ENDED', 'REPLACEMENT_MOVED', 'REPLACEMENT_REVIEW_PENDING', 'TIMETABLE_PUBLISHED', 'TIMETABLE_CHANGED', 'CALENDAR_FEED_REVOKED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "audience" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "link" JSONB,
    "source_key" TEXT NOT NULL,
    "coalesce_key" TEXT,
    "actor_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMP(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_school_id_recipient_id_created_at_id_idx" ON "notifications"("school_id", "recipient_id", "created_at" DESC, "id");

-- CreateIndex
CREATE INDEX "notifications_school_id_recipient_id_read_at_idx" ON "notifications"("school_id", "recipient_id", "read_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_school_id_id_key" ON "notifications"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_school_id_recipient_id_source_key_key" ON "notifications"("school_id", "recipient_id", "source_key");

-- CreateIndex
CREATE INDEX "notification_deliveries_school_id_status_created_at_idx" ON "notification_deliveries"("school_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_school_id_id_key" ON "notification_deliveries"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_notification_id_channel_key" ON "notification_deliveries"("notification_id", "channel");

-- CreateIndex
CREATE INDEX "lessons_school_id_substitute_teacher_id_starts_at_idx" ON "lessons"("school_id", "substitute_teacher_id", "starts_at");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_school_id_notification_id_fkey" FOREIGN KEY ("school_id", "notification_id") REFERENCES "notifications"("school_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One unread notification per recipient and coalesce key: new events about
-- the same subject update it (docs/architecture/phase5-rules.md §2.5).
CREATE UNIQUE INDEX "notifications_unread_coalesce" ON "notifications"("school_id", "recipient_id", "coalesce_key") WHERE "read_at" IS NULL AND "coalesce_key" IS NOT NULL;

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_audience_check" CHECK ("audience" IN ('teacher', 'regular', 'substitute', 'student', 'admin'));

-- IN_APP is the notification row itself (§2.6).
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_channel_check" CHECK ("channel" <> 'IN_APP');
