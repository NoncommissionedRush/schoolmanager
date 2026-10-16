-- CreateTable
CREATE TABLE "teacher_ratings" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "teacher_id" UUID NOT NULL,
    "term_id" UUID NOT NULL,
    "score" INTEGER NOT NULL,
    "comment" TEXT,
    "hidden_at" TIMESTAMP(3),
    "hidden_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teacher_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_feeds" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "salt" BYTEA NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "calendar_feeds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "teacher_ratings_school_id_teacher_id_term_id_idx" ON "teacher_ratings"("school_id", "teacher_id", "term_id");

-- CreateIndex
CREATE UNIQUE INDEX "teacher_ratings_school_id_id_key" ON "teacher_ratings"("school_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "teacher_ratings_school_id_student_id_teacher_id_term_id_key" ON "teacher_ratings"("school_id", "student_id", "teacher_id", "term_id");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_feeds_token_hash_key" ON "calendar_feeds"("token_hash");

-- CreateIndex
CREATE INDEX "calendar_feeds_school_id_user_id_idx" ON "calendar_feeds"("school_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_feeds_school_id_id_key" ON "calendar_feeds"("school_id", "id");

-- AddForeignKey
ALTER TABLE "teacher_ratings" ADD CONSTRAINT "teacher_ratings_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_ratings" ADD CONSTRAINT "teacher_ratings_school_id_student_id_fkey" FOREIGN KEY ("school_id", "student_id") REFERENCES "student_profiles"("school_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_ratings" ADD CONSTRAINT "teacher_ratings_school_id_teacher_id_fkey" FOREIGN KEY ("school_id", "teacher_id") REFERENCES "teacher_profiles"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_ratings" ADD CONSTRAINT "teacher_ratings_school_id_term_id_fkey" FOREIGN KEY ("school_id", "term_id") REFERENCES "terms"("school_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_ratings" ADD CONSTRAINT "teacher_ratings_hidden_by_id_fkey" FOREIGN KEY ("hidden_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- docs/architecture/phase5-rules.md §4.2 / §6.
ALTER TABLE "teacher_ratings" ADD CONSTRAINT "teacher_ratings_score_check" CHECK ("score" BETWEEN 1 AND 5);
ALTER TABLE "teacher_ratings" ADD CONSTRAINT "teacher_ratings_comment_check" CHECK (char_length("comment") <= 1000);
-- The admin who hid a rating may be deleted later, which nulls hidden_by_id.
ALTER TABLE "teacher_ratings" ADD CONSTRAINT "teacher_ratings_hidden_check" CHECK ("hidden_by_id" IS NULL OR "hidden_at" IS NOT NULL);

-- One active calendar link per user and school (§5.1).
CREATE UNIQUE INDEX "calendar_feeds_one_active" ON "calendar_feeds"("school_id", "user_id") WHERE "revoked_at" IS NULL;
