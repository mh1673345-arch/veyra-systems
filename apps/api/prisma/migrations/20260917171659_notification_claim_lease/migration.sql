-- DropIndex
DROP INDEX "Notification_status_nextAttemptAt_claimedAt_idx";

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "claimToken" TEXT,
ADD COLUMN     "leaseExpiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Notification_status_nextAttemptAt_leaseExpiresAt_idx" ON "Notification"("status", "nextAttemptAt", "leaseExpiresAt");

-- Backfill: a row claimed by the pre-lease code keeps the protection it had
-- (claimedAt + the old 2-minute TTL) instead of becoming instantly reclaimable.
UPDATE "Notification"
SET "leaseExpiresAt" = "claimedAt" + INTERVAL '2 minutes'
WHERE "claimedAt" IS NOT NULL AND "status" = 'pending';
