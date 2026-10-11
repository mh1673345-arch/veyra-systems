-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "recipientEmail" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Notification_eventId_recipientEmail_channel_key" ON "Notification"("eventId", "recipientEmail", "channel");


-- A notification goes to a member or to an external address, never both and
-- never neither. Prisma cannot express a CHECK, so it lives here: without it
-- "recipient" would be a convention that any future code path could break,
-- and an ambiguous recipient is how someone gets another tenant's mail.
ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_recipient_exclusive"
  CHECK (("userId" IS NULL) <> ("recipientEmail" IS NULL));
