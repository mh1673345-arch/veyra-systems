-- CreateEnum
CREATE TYPE "PlanCode" AS ENUM ('STARTER', 'PRO', 'MAX');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('trialing', 'active', 'past_due', 'cancelled', 'expired');

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "plan" "PlanCode" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "trialEndsAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "billingProvider" TEXT,
    "externalBillingCustomerId" TEXT,
    "externalBillingSubscriptionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "previousPlan" "PlanCode",
    "newPlan" "PlanCode" NOT NULL,
    "previousStatus" "SubscriptionStatus",
    "newStatus" "SubscriptionStatus" NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorUserId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_businessId_key" ON "Subscription"("businessId");

-- CreateIndex
CREATE INDEX "SubscriptionEvent_businessId_createdAt_idx" ON "SubscriptionEvent"("businessId", "createdAt");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionEvent" ADD CONSTRAINT "SubscriptionEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionEvent" ADD CONSTRAINT "SubscriptionEvent_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: every business existing before subscriptions gets an explicit
-- Starter subscription (the core plan) rather than silently having none. The
-- change is audited like any other plan change.
INSERT INTO "Subscription" ("id", "businessId", "plan", "status", "startsAt", "currentPeriodStart", "createdAt", "updatedAt")
SELECT 'sub_' || md5(random()::text || b."id"), b."id", 'STARTER', 'active', NOW(), NOW(), NOW(), NOW()
FROM "Business" b
WHERE NOT EXISTS (SELECT 1 FROM "Subscription" s WHERE s."businessId" = b."id");

INSERT INTO "SubscriptionEvent" ("id", "businessId", "subscriptionId", "previousPlan", "newPlan", "previousStatus", "newStatus", "actorType", "reason", "createdAt")
SELECT 'subev_' || md5(random()::text || s."id"), s."businessId", s."id", NULL, s."plan", NULL, s."status", 'migration', 'Existing business given a Starter subscription when plans were introduced', NOW()
FROM "Subscription" s
WHERE NOT EXISTS (SELECT 1 FROM "SubscriptionEvent" e WHERE e."subscriptionId" = s."id");
