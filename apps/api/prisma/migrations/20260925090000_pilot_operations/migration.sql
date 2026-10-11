-- CreateEnum
CREATE TYPE "PilotStatus" AS ENUM ('none', 'preparing', 'active', 'paused', 'completed');

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "allowAutoBooking" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowAutoCancellation" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowAutoReschedule" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowEscalation" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowNotifications" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "pilotEndedAt" TIMESTAMP(3),
ADD COLUMN     "pilotLabel" TEXT,
ADD COLUMN     "pilotNotes" TEXT,
ADD COLUMN     "pilotStartedAt" TIMESTAMP(3),
ADD COLUMN     "pilotStatus" "PilotStatus" NOT NULL DEFAULT 'none';

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "outcomeOverride" TEXT,
ADD COLUMN     "outcomeOverrideAt" TIMESTAMP(3),
ADD COLUMN     "outcomeOverrideNote" TEXT,
ADD COLUMN     "outcomeOverrideUserId" TEXT;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "actionStatus" TEXT,
ADD COLUMN     "fallbackReason" TEXT,
ADD COLUMN     "responder" TEXT;

-- CreateTable
CREATE TABLE "PilotIssue" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "conversationId" TEXT,
    "messageId" TEXT,
    "category" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolutionNote" TEXT,
    "reportedByUserId" TEXT,
    "resolvedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PilotIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationFeedback" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT,
    "rating" TEXT NOT NULL,
    "note" TEXT,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeGapSignal" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "conversationId" TEXT,
    "messageId" TEXT,
    "kind" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeGapSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PilotTarget" (
    "businessId" TEXT NOT NULL,
    "targetConversations" INTEGER,
    "targetBookingRequests" INTEGER,
    "targetConfirmedBookings" INTEGER,
    "maxHumanInterventionRate" DOUBLE PRECISION,
    "maxUnresolvedIssues" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PilotTarget_pkey" PRIMARY KEY ("businessId")
);

-- CreateIndex
CREATE INDEX "PilotIssue_businessId_status_createdAt_idx" ON "PilotIssue"("businessId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ConversationFeedback_businessId_createdAt_idx" ON "ConversationFeedback"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "ConversationFeedback_conversationId_idx" ON "ConversationFeedback"("conversationId");

-- CreateIndex
CREATE INDEX "KnowledgeGapSignal_businessId_createdAt_idx" ON "KnowledgeGapSignal"("businessId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeGapSignal_conversationId_kind_topic_key" ON "KnowledgeGapSignal"("conversationId", "kind", "topic");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_outcomeOverrideUserId_fkey" FOREIGN KEY ("outcomeOverrideUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PilotIssue" ADD CONSTRAINT "PilotIssue_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PilotIssue" ADD CONSTRAINT "PilotIssue_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PilotIssue" ADD CONSTRAINT "PilotIssue_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PilotIssue" ADD CONSTRAINT "PilotIssue_reportedByUserId_fkey" FOREIGN KEY ("reportedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PilotIssue" ADD CONSTRAINT "PilotIssue_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationFeedback" ADD CONSTRAINT "ConversationFeedback_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationFeedback" ADD CONSTRAINT "ConversationFeedback_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationFeedback" ADD CONSTRAINT "ConversationFeedback_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationFeedback" ADD CONSTRAINT "ConversationFeedback_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeGapSignal" ADD CONSTRAINT "KnowledgeGapSignal_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeGapSignal" ADD CONSTRAINT "KnowledgeGapSignal_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeGapSignal" ADD CONSTRAINT "KnowledgeGapSignal_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PilotTarget" ADD CONSTRAINT "PilotTarget_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

