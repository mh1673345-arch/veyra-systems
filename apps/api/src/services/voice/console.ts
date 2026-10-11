import type { CallSession } from "@prisma/client";
import {
  AFTER_HOURS_BEHAVIORS,
  type AfterHoursBehavior,
  type CallDetail,
  type CallSummary,
  type CallTurnDto,
  type RecordingPolicy,
  type TranscriptPolicy,
  VOICE_PROFILES,
  type VoiceOverview,
  type VoiceProfileName,
  type VoiceSettingsDto,
  lowestPlanWith
} from "@veyra/shared";
import { prisma } from "../../db/client.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { accessFor, getPlanLimits } from "../access/accessService.js";
import { voiceMinutesUsed, voiceSettingsFor } from "./access.js";
import { speechHealth, voiceProvider } from "./registry.js";

/**
 * What the Console is allowed to know about voice.
 *
 * Two rules here: never show a phone number that does not exist, and never
 * claim voice is live when any of the four conditions (plan, direction,
 * configuration, provider) is missing. `blockedReason` says which one.
 */

/** Enough of a number to recognise a caller, not enough to hand out. */
export function maskNumber(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length <= 4) return trimmed;
  return `${trimmed.slice(0, Math.min(3, trimmed.length - 4))}…${trimmed.slice(-4)}`;
}

export function toVoiceSettingsDto(settings: {
  businessId: string;
  enabled: boolean;
  provider: string | null;
  businessPhoneNumber: string | null;
  callerId: string | null;
  language: string;
  voiceProfile: string;
  greeting: string | null;
  afterHoursBehavior: string;
  handoffNumber: string | null;
  voicemailGreeting: string | null;
  maxCallSeconds: number;
  recordingPolicy: string;
  transcriptPolicy: string;
}): VoiceSettingsDto {
  return {
    businessId: settings.businessId,
    enabled: settings.enabled,
    provider: settings.provider,
    businessPhoneNumber: settings.businessPhoneNumber,
    callerId: settings.callerId,
    language: settings.language,
    voiceProfile: settings.voiceProfile as VoiceProfileName,
    greeting: settings.greeting,
    afterHoursBehavior: settings.afterHoursBehavior as AfterHoursBehavior,
    handoffNumber: settings.handoffNumber,
    voicemailGreeting: settings.voicemailGreeting,
    maxCallSeconds: settings.maxCallSeconds,
    recordingPolicy: settings.recordingPolicy as RecordingPolicy,
    transcriptPolicy: settings.transcriptPolicy as TranscriptPolicy
  };
}

export async function voiceOverview(businessId: string, canManage: boolean): Promise<VoiceOverview> {
  const [access, settings, provider, limits] = await Promise.all([
    accessFor(businessId),
    voiceSettingsFor(businessId),
    Promise.resolve(voiceProvider()),
    getPlanLimits(businessId)
  ]);

  const entitled = access.entitlements.has("voice_reception");
  const speech = await speechHealth();
  const health = provider ? await provider.health().catch(() => ({ ok: false, detail: "The voice provider could not be reached." })) : null;

  const [minutes, calls] = await Promise.all([
    voiceMinutesUsed(businessId),
    prisma.callSession.count({ where: { businessId } })
  ]);

  const blockedReason = !entitled
    ? "Voice is part of Max. This plan doesn't include it."
    : !provider
      ? "No voice provider is configured on this server yet."
      : health && !health.ok
        ? `The voice provider is not available: ${health.detail}`
        : !settings?.enabled
          ? "Voice is switched off for this business."
          : !settings.businessPhoneNumber
            ? "No phone number is configured for Veyra to answer."
            : // Speech is configured separately from the carrier, and a call
              // needs both halves: without recognition Veyra cannot hear, and
              // without synthesis it cannot answer.
              !speech.stt.ok
              ? `Speech recognition is not available: ${speech.stt.detail}`
              : !speech.tts.ok
                ? `Speech synthesis is not available: ${speech.tts.detail}`
                : null;

  const voiceLimit = limits.monthly_voice_minutes;

  return {
    businessId,
    entitled,
    requiredPlan: entitled ? null : lowestPlanWith("voice_reception"),
    plan: access.plan,
    settings: settings ? toVoiceSettingsDto(settings) : null,
    provider: {
      name: provider?.name ?? null,
      configured: provider !== null,
      healthy: health?.ok ?? false,
      detail: health?.detail ?? "No voice provider is configured on this server.",
      simulated: provider?.name === "fake"
    },
    speech: {
      stt: { name: speech.stt.name, configured: speech.stt.configured, healthy: speech.stt.ok, detail: speech.stt.detail, simulated: speech.stt.simulated },
      tts: { name: speech.tts.name, configured: speech.tts.configured, healthy: speech.tts.ok, detail: speech.tts.detail, simulated: speech.tts.simulated }
    },
    live: blockedReason === null,
    blockedReason,
    usage: {
      minutesThisPeriod: minutes,
      limit: voiceLimit.kind === "count" ? voiceLimit.value : null,
      calls
    },
    canManage
  };
}

/* ------------------------------------------------------------------ *
 * Settings updates
 * ------------------------------------------------------------------ */

const E164 = /^\+?[0-9 ().-]{6,20}$/;

function optionalText(value: unknown, field: string, max = 500): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(400, `${field} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new HttpError(400, `${field} must be ${max} characters or fewer.`);
  return trimmed || null;
}

function optionalNumber(value: unknown, field: string): string | null | undefined {
  const text = optionalText(value, field, 20);
  if (text === undefined || text === null) return text;
  if (!E164.test(text)) throw new HttpError(400, `${field} must be a valid phone number.`);
  return text;
}

export async function updateVoiceSettings(params: {
  businessId: string;
  patch: Record<string, unknown>;
}): Promise<VoiceSettingsDto> {
  const { patch } = params;
  const data: Record<string, unknown> = {};

  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false.");
    data.enabled = patch.enabled;
  }

  const phone = optionalNumber(patch.businessPhoneNumber, "businessPhoneNumber");
  if (phone !== undefined) {
    if (phone) {
      // One number, one business: inbound routing has to be unambiguous.
      const clash = await prisma.voiceSettings.findFirst({
        where: { businessPhoneNumber: phone, NOT: { businessId: params.businessId } },
        select: { businessId: true }
      });
      if (clash) throw new HttpError(409, "That phone number is already used by another business.");
    }
    data.businessPhoneNumber = phone;
  }

  const callerId = optionalNumber(patch.callerId, "callerId");
  if (callerId !== undefined) data.callerId = callerId;

  const handoff = optionalNumber(patch.handoffNumber, "handoffNumber");
  if (handoff !== undefined) data.handoffNumber = handoff;

  const greeting = optionalText(patch.greeting, "greeting", 500);
  if (greeting !== undefined) data.greeting = greeting;

  const voicemail = optionalText(patch.voicemailGreeting, "voicemailGreeting", 500);
  if (voicemail !== undefined) data.voicemailGreeting = voicemail;

  if (patch.language !== undefined) {
    const language = optionalText(patch.language, "language", 16);
    // A BCP-47-ish tag only; never arbitrary text passed to a speech vendor.
    if (language && !/^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/.test(language)) {
      throw new HttpError(400, "language must be a language tag such as en-US.");
    }
    data.language = language ?? "en-US";
  }

  if (patch.voiceProfile !== undefined) {
    if (typeof patch.voiceProfile !== "string" || !(VOICE_PROFILES as readonly string[]).includes(patch.voiceProfile)) {
      throw new HttpError(400, `voiceProfile must be one of ${VOICE_PROFILES.join(", ")}.`);
    }
    data.voiceProfile = patch.voiceProfile;
  }

  if (patch.afterHoursBehavior !== undefined) {
    if (
      typeof patch.afterHoursBehavior !== "string" ||
      !(AFTER_HOURS_BEHAVIORS as readonly string[]).includes(patch.afterHoursBehavior)
    ) {
      throw new HttpError(400, `afterHoursBehavior must be one of ${AFTER_HOURS_BEHAVIORS.join(", ")}.`);
    }
    data.afterHoursBehavior = patch.afterHoursBehavior;
  }

  if (patch.maxCallSeconds !== undefined) {
    const seconds = Number(patch.maxCallSeconds);
    if (!Number.isInteger(seconds) || seconds < 60 || seconds > 3600) {
      throw new HttpError(400, "maxCallSeconds must be between 60 and 3600.");
    }
    data.maxCallSeconds = seconds;
  }

  if (patch.transcriptPolicy !== undefined) {
    if (patch.transcriptPolicy !== "store" && patch.transcriptPolicy !== "metadata_only") {
      throw new HttpError(400, "transcriptPolicy must be store or metadata_only.");
    }
    data.transcriptPolicy = patch.transcriptPolicy;
  }

  if (patch.recordingPolicy !== undefined) {
    if (patch.recordingPolicy !== "disabled" && patch.recordingPolicy !== "enabled") {
      throw new HttpError(400, "recordingPolicy must be disabled or enabled.");
    }
    // Recording is off unless a business turns it on deliberately; there is no
    // default-on path and nothing enables it implicitly.
    data.recordingPolicy = patch.recordingPolicy;
  }

  if (Object.keys(data).length === 0) throw new HttpError(400, "No voice settings were supplied.");

  const saved = await prisma.voiceSettings.upsert({
    where: { businessId: params.businessId },
    create: { businessId: params.businessId, ...data },
    update: data
  });
  return toVoiceSettingsDto(saved);
}

/* ------------------------------------------------------------------ *
 * Calls
 * ------------------------------------------------------------------ */

function outcomeOf(
  session: CallSession,
  links: { bookingId: string | null; escalationId: string | null }
): CallSummary["outcome"] {
  if (session.status === "missed") return "missed";
  if (session.status === "failed") return "failed";
  if (links.bookingId) return "booking";
  if (session.handoffOccurred || links.escalationId) return "handoff";
  if (session.conversationId) return "answered";
  return "no_outcome";
}

async function linksFor(session: CallSession): Promise<{ bookingId: string | null; escalationId: string | null }> {
  if (!session.conversationId) return { bookingId: null, escalationId: null };
  const [booking, escalation] = await Promise.all([
    prisma.appointment.findFirst({
      where: { conversationId: session.conversationId },
      orderBy: { createdAt: "desc" },
      select: { id: true }
    }),
    prisma.escalation.findFirst({
      where: { conversationId: session.conversationId },
      orderBy: { createdAt: "desc" },
      select: { id: true }
    })
  ]);
  return { bookingId: booking?.id ?? null, escalationId: escalation?.id ?? null };
}

export async function listCalls(businessId: string, limit = 100): Promise<CallSummary[]> {
  const sessions = await prisma.callSession.findMany({
    where: { businessId },
    orderBy: { startedAt: "desc" },
    take: Math.min(limit, 200)
  });

  return Promise.all(
    sessions.map(async (session) => {
      const links = await linksFor(session);
      return {
        id: session.id,
        businessId: session.businessId,
        conversationId: session.conversationId,
        direction: session.direction,
        status: session.status,
        callerNumber: maskNumber(session.callerNumber),
        startedAt: session.startedAt.toISOString(),
        endedAt: session.endedAt?.toISOString() ?? null,
        durationSeconds: session.durationSeconds,
        handoffOccurred: session.handoffOccurred,
        outcome: outcomeOf(session, links),
        ...links
      };
    })
  );
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index];
}

export async function callDetail(businessId: string, callId: string): Promise<CallDetail> {
  // Scoped: another business's call does not exist here.
  const session = await prisma.callSession.findFirst({ where: { id: callId, businessId } });
  if (!session) throw new HttpError(404, "Call not found");

  const [settings, links, turnRows, messages] = await Promise.all([
    voiceSettingsFor(businessId),
    linksFor(session),
    prisma.callTurn.findMany({ where: { callSessionId: session.id }, orderBy: { createdAt: "asc" } }),
    session.conversationId
      ? prisma.message.findMany({ where: { conversationId: session.conversationId }, orderBy: { createdAt: "asc" } })
      : Promise.resolve([])
  ]);

  const latencyByMessage = new Map(turnRows.filter((turn) => turn.messageId).map((turn) => [turn.messageId!, turn]));

  const turns: CallTurnDto[] = messages.map((message) => {
    const turn = latencyByMessage.get(message.id);
    return {
      at: message.createdAt.toISOString(),
      speaker: message.sender === "receptionist" ? "veyra" : "caller",
      text: message.text,
      intent: message.intent,
      action: message.action,
      // Operator-facing timings only. No prompt, no reasoning, no provider
      // payload — those are never stored, so they cannot be exposed here.
      latency: turn
        ? { responderMs: turn.responderMs, actionMs: turn.actionMs, ttsMs: turn.ttsMs, totalMs: turn.totalMs }
        : null,
      interrupted: turn?.interrupted ?? false
    };
  });

  const totals = turnRows.map((turn) => turn.totalMs).filter((value): value is number => value !== null);

  return {
    id: session.id,
    businessId: session.businessId,
    conversationId: session.conversationId,
    direction: session.direction,
    status: session.status,
    callerNumber: maskNumber(session.callerNumber),
    businessNumber: maskNumber(session.businessNumber),
    startedAt: session.startedAt.toISOString(),
    endedAt: session.endedAt?.toISOString() ?? null,
    durationSeconds: session.durationSeconds,
    handoffOccurred: session.handoffOccurred,
    hangupReason: session.hangupReason,
    provider: session.provider,
    outcome: outcomeOf(session, links),
    ...links,
    turns,
    transcriptStored: (settings?.transcriptPolicy ?? "store") === "store",
    recordingEnabled: (settings?.recordingPolicy ?? "disabled") === "enabled",
    latencySummary: {
      turns: turnRows.length,
      medianTotalMs: percentile(totals, 0.5),
      p95TotalMs: percentile(totals, 0.95)
    }
  };
}
