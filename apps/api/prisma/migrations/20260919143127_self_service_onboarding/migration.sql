-- CreateEnum
CREATE TYPE "ReceptionStatus" AS ENUM ('draft', 'active', 'paused');

-- CreateEnum
CREATE TYPE "ReceptionTone" AS ENUM ('professional', 'warm', 'concise', 'premium');

-- CreateEnum
CREATE TYPE "ClosingStyle" AS ENUM ('none', 'offer_help', 'thank_you');

-- DropIndex
DROP INDEX "BusinessHour_businessId_dayOfWeek_key";

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "assistantName" TEXT,
ADD COLUMN     "closingStyle" "ClosingStyle" NOT NULL DEFAULT 'none',
ADD COLUMN     "escalationEmail" TEXT,
ADD COLUMN     "escalationFallbackMessage" TEXT,
ADD COLUMN     "escalationPhone" TEXT,
ADD COLUMN     "industry" TEXT NOT NULL DEFAULT 'general',
ADD COLUMN     "receptionStatus" "ReceptionStatus" NOT NULL DEFAULT 'active',
ADD COLUMN     "receptionStatusChangedAt" TIMESTAMP(3),
ADD COLUMN     "receptionTone" "ReceptionTone" NOT NULL DEFAULT 'professional',
ADD COLUMN     "website" TEXT;

-- AlterTable
ALTER TABLE "Faq" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "category" TEXT,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "bookable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "priceNote" TEXT,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "OnboardingProgress" (
    "businessId" TEXT NOT NULL,
    "completedSteps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "skippedSteps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingProgress_pkey" PRIMARY KEY ("businessId")
);

-- CreateTable
CREATE TABLE "ConfigAuditEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "changeType" TEXT NOT NULL,
    "changedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConfigAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConfigAuditEvent_businessId_createdAt_idx" ON "ConfigAuditEvent"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "BusinessHour_businessId_dayOfWeek_idx" ON "BusinessHour"("businessId", "dayOfWeek");


-- Backfill: businesses that existed before self-service onboarding were set
-- up by hand and are already live, so their onboarding is recorded as done.
-- (receptionStatus defaults to 'active' for them; self-service workspaces are
-- created as 'draft' explicitly.)
INSERT INTO "OnboardingProgress" ("businessId", "completedSteps", "skippedSteps", "completedAt", "updatedAt")
SELECT b."id",
       ARRAY['business_details','services','knowledge','hours','booking','escalation','team','integrations','review','go_live'],
       ARRAY[]::TEXT[],
       NOW(),
       NOW()
FROM "Business" b
WHERE NOT EXISTS (SELECT 1 FROM "OnboardingProgress" o WHERE o."businessId" = b."id");
