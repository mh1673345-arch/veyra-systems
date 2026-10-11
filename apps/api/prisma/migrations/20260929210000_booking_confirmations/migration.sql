-- AlterTable
ALTER TABLE "MessagingSettings" ADD COLUMN     "bookingCancellationNotificationEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "bookingConfirmationEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "bookingRescheduleNotificationEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "transactionalChannelPreference" TEXT NOT NULL DEFAULT 'origin_channel',
ADD COLUMN     "transactionalFallbackEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "BookingConfirmation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "transition" TEXT NOT NULL,
    "transitionKey" TEXT NOT NULL DEFAULT '',
    "channel" TEXT NOT NULL,
    "recipient" TEXT,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "notificationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingConfirmation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingConfirmation_businessId_createdAt_idx" ON "BookingConfirmation"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "BookingConfirmation_notificationId_idx" ON "BookingConfirmation"("notificationId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingConfirmation_appointmentId_transition_transitionKey__key" ON "BookingConfirmation"("appointmentId", "transition", "transitionKey", "channel");

-- AddForeignKey
ALTER TABLE "BookingConfirmation" ADD CONSTRAINT "BookingConfirmation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingConfirmation" ADD CONSTRAINT "BookingConfirmation_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

