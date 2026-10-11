-- CreateEnum
CREATE TYPE "CallDirection" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('initiated', 'ringing', 'active', 'transferring', 'completed', 'failed', 'missed');

-- CreateTable
CREATE TABLE "VoiceSettings" (
    "businessId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT,
    "businessPhoneNumber" TEXT,
    "callerId" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en-US',
    "voiceProfile" TEXT NOT NULL DEFAULT 'neutral',
    "greeting" TEXT,
    "afterHoursBehavior" TEXT NOT NULL DEFAULT 'continue',
    "handoffNumber" TEXT,
    "voicemailGreeting" TEXT,
    "maxCallSeconds" INTEGER NOT NULL DEFAULT 600,
    "recordingPolicy" TEXT NOT NULL DEFAULT 'disabled',
    "transcriptPolicy" TEXT NOT NULL DEFAULT 'store',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceSettings_pkey" PRIMARY KEY ("businessId")
);

-- CreateTable
CREATE TABLE "CallSession" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "conversationId" TEXT,
    "provider" TEXT NOT NULL,
    "externalCallId" TEXT NOT NULL,
    "direction" "CallDirection" NOT NULL,
    "status" "CallStatus" NOT NULL DEFAULT 'initiated',
    "callerNumber" TEXT,
    "businessNumber" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "hangupReason" TEXT,
    "handoffOccurred" BOOLEAN NOT NULL DEFAULT false,
    "recordingReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallTurn" (
    "id" TEXT NOT NULL,
    "callSessionId" TEXT NOT NULL,
    "messageId" TEXT,
    "sttMs" INTEGER,
    "responderMs" INTEGER,
    "actionMs" INTEGER,
    "ttsMs" INTEGER,
    "totalMs" INTEGER,
    "interrupted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallTurn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceWebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "detail" TEXT,
    "callSessionId" TEXT,
    "businessId" TEXT,
    "eventAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VoiceSettings_businessPhoneNumber_key" ON "VoiceSettings"("businessPhoneNumber");

-- CreateIndex
CREATE INDEX "CallSession_businessId_startedAt_idx" ON "CallSession"("businessId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CallSession_provider_externalCallId_key" ON "CallSession"("provider", "externalCallId");

-- CreateIndex
CREATE INDEX "CallTurn_callSessionId_createdAt_idx" ON "CallTurn"("callSessionId", "createdAt");

-- CreateIndex
CREATE INDEX "VoiceWebhookEvent_callSessionId_idx" ON "VoiceWebhookEvent"("callSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "VoiceWebhookEvent_provider_externalEventId_key" ON "VoiceWebhookEvent"("provider", "externalEventId");

-- AddForeignKey
ALTER TABLE "VoiceSettings" ADD CONSTRAINT "VoiceSettings_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallTurn" ADD CONSTRAINT "CallTurn_callSessionId_fkey" FOREIGN KEY ("callSessionId") REFERENCES "CallSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceWebhookEvent" ADD CONSTRAINT "VoiceWebhookEvent_callSessionId_fkey" FOREIGN KEY ("callSessionId") REFERENCES "CallSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

