-- Every user belongs to exactly one school (decision 2026-10-14, CARM-33).
-- Fails if a user already has more than one membership.

-- DropIndex
DROP INDEX "memberships_user_id_idx";

-- CreateIndex
CREATE UNIQUE INDEX "memberships_user_id_key" ON "memberships"("user_id");
