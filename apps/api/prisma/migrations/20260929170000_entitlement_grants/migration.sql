-- CreateTable
CREATE TABLE "EntitlementGrant" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entitlement" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "grantedByUserId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EntitlementGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EntitlementGrant_businessId_idx" ON "EntitlementGrant"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "EntitlementGrant_businessId_entitlement_key" ON "EntitlementGrant"("businessId", "entitlement");

-- AddForeignKey
ALTER TABLE "EntitlementGrant" ADD CONSTRAINT "EntitlementGrant_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

