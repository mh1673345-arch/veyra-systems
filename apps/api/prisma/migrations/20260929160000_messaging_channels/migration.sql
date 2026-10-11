-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "channel" TEXT NOT NULL DEFAULT 'web',
ADD COLUMN     "customerRef" TEXT;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "deliveryDetail" TEXT,
ADD COLUMN     "deliveryStatus" TEXT,
ADD COLUMN     "deliveryUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "providerMessageId" TEXT,
ADD COLUMN     "recipientPhone" TEXT;

-- CreateTable
CREATE TABLE "MessagingSettings" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "smsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "whatsappEnabled" BOOLEAN NOT NULL DEFAULT false,
    "smsProvider" TEXT,
    "whatsappProvider" TEXT,
    "smsSender" TEXT,
    "whatsappSender" TEXT,
    "defaultCountry" TEXT,
    "customerMessagingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "operatorMessagingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessagingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessagingNumber" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerNumberId" TEXT,
    "phoneE164" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessagingNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessagingConsent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'unknown',
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessagingConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "providerTemplateId" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "variables" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessagingWebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "detail" TEXT,
    "notificationId" TEXT,
    "businessId" TEXT,
    "eventAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessagingWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessagingSettings_businessId_key" ON "MessagingSettings"("businessId");

-- CreateIndex
CREATE INDEX "MessagingNumber_businessId_idx" ON "MessagingNumber"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "MessagingNumber_channel_provider_phoneE164_key" ON "MessagingNumber"("channel", "provider", "phoneE164");

-- CreateIndex
CREATE INDEX "MessagingConsent_businessId_channel_idx" ON "MessagingConsent"("businessId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "MessagingConsent_businessId_channel_phoneE164_key" ON "MessagingConsent"("businessId", "channel", "phoneE164");

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplate_businessId_channel_key_language_key" ON "MessageTemplate"("businessId", "channel", "key", "language");

-- CreateIndex
CREATE INDEX "MessagingWebhookEvent_notificationId_idx" ON "MessagingWebhookEvent"("notificationId");

-- CreateIndex
CREATE UNIQUE INDEX "MessagingWebhookEvent_provider_externalEventId_key" ON "MessagingWebhookEvent"("provider", "externalEventId");

-- CreateIndex
CREATE INDEX "Conversation_businessId_channel_customerRef_idx" ON "Conversation"("businessId", "channel", "customerRef");

-- CreateIndex
CREATE INDEX "Notification_providerMessageId_idx" ON "Notification"("providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_eventId_recipientPhone_channel_key" ON "Notification"("eventId", "recipientPhone", "channel");

-- AddForeignKey
ALTER TABLE "MessagingSettings" ADD CONSTRAINT "MessagingSettings_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessagingNumber" ADD CONSTRAINT "MessagingNumber_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessagingConsent" ADD CONSTRAINT "MessagingConsent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The recipient invariant now has three arms rather than two: a member, an
-- email address, or a phone number — exactly one, never two, never none.
ALTER TABLE "Notification" DROP CONSTRAINT "Notification_recipient_exclusive";
ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_recipient_exclusive"
  CHECK (
    (CASE WHEN "userId"         IS NOT NULL THEN 1 ELSE 0 END)
  + (CASE WHEN "recipientEmail" IS NOT NULL THEN 1 ELSE 0 END)
  + (CASE WHEN "recipientPhone" IS NOT NULL THEN 1 ELSE 0 END)
  = 1
  );

-- A phone number is only a destination on a channel that can reach a phone,
-- and those channels have nowhere else to send. Without this, an sms row
-- addressed to a member would reach the worker with nothing to dial.
ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_phone_channel_coherent"
  CHECK (
    ("channel" IN ('sms', 'whatsapp')) = ("recipientPhone" IS NOT NULL)
  );
