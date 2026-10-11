-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "customerContactId" TEXT;

-- AlterTable
ALTER TABLE "CallSession" ADD COLUMN     "customerContactId" TEXT;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "customerContactId" TEXT;

-- CreateTable
CREATE TABLE "CustomerContact" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "displayName" TEXT,
    "phoneE164" TEXT,
    "email" TEXT,
    "phoneState" TEXT NOT NULL DEFAULT 'unknown',
    "emailState" TEXT NOT NULL DEFAULT 'unknown',
    "phoneVerifiedAt" TIMESTAMP(3),
    "emailVerifiedAt" TIMESTAMP(3),
    "source" TEXT NOT NULL,
    "emailTransactionalAllowed" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerContact_businessId_idx" ON "CustomerContact"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerContact_businessId_phoneE164_key" ON "CustomerContact"("businessId", "phoneE164");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerContact_businessId_email_key" ON "CustomerContact"("businessId", "email");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_customerContactId_fkey" FOREIGN KEY ("customerContactId") REFERENCES "CustomerContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerContact" ADD CONSTRAINT "CustomerContact_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_customerContactId_fkey" FOREIGN KEY ("customerContactId") REFERENCES "CustomerContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_customerContactId_fkey" FOREIGN KEY ("customerContactId") REFERENCES "CustomerContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A contact with neither a phone nor an email is not a contact: there would
-- be no way to reach the person and nothing to recognise them by later.
ALTER TABLE "CustomerContact"
  ADD CONSTRAINT "CustomerContact_has_a_contact_method"
  CHECK ("phoneE164" IS NOT NULL OR "email" IS NOT NULL);

-- Verification timestamps belong to the "verified" state alone. Without this
-- a row could claim a verification date while still only "provided", which is
-- exactly the overclaim this layer exists to prevent.
ALTER TABLE "CustomerContact"
  ADD CONSTRAINT "CustomerContact_verified_states_coherent"
  CHECK (
    ("phoneVerifiedAt" IS NULL OR "phoneState" = 'verified')
    AND ("emailVerifiedAt" IS NULL OR "emailState" = 'verified')
  );
