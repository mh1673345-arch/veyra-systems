import type { CallSession, CallStatus, VoiceSettings } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { localParts } from "../calendar/rules.js";
import { EntitlementError } from "../access/accessService.js";
import { handleReceptionTurn } from "../reception/turn.js";
import { unavailableMessage } from "../ai/presentation.js";
import { requireVoiceAccess, VoiceUnavailableError } from "./access.js";
import { assertCallTransition, isTerminalCallStatus } from "./callState.js";
import { textToSpeechProvider } from "./registry.js";
import { type CallInstruction, type VoiceEvent, type VoiceProvider, VoiceProviderError } from "./types.js";

/**
 * A phone call, as Veyra experiences it.
 *
 * The rule this file exists to keep: **voice adds no business logic**. A call
 * is a Conversation with audio on both ends. Answering a pricing question,
 * checking a calendar, holding a slot, creating an escalation — all of it
 * happens in `handleReceptionTurn`, exactly as it does for someone typing.
 * What lives here is the part that is genuinely about telephony: resolving
 * which business was dialled, tracking call state, turning a reply into an
 * instruction for the line, and recording how long each turn took.
 */

/** A neutral line for a caller Veyra must not serve. Says nothing about plans. */
const CANNOT_TAKE_CALLS = "Sorry — this number can't take automated calls right now. Please try again later.";

export interface VoiceWebhookResult {
  outcome: "processed" | "ignored" | "duplicate";
  detail?: string;
  callSessionId?: string;
  /** What the provider should do next, when this event calls for anything. */
  instruction?: CallInstruction;
  /**
   * Set when this event was a new inbound call Veyra accepted. Carriers that
   * drive the call from their HTTP response use it to start the media stream.
   */
  answeredCall?: { externalCallId: string; businessId: string };
}

/* ------------------------------------------------------------------ *
 * Webhook entry point
 * ------------------------------------------------------------------ */

/**
 * Verifies and applies one provider event.
 *
 * The event id is claimed before any work, so a carrier retrying a delivery
 * cannot create a second call, a second transcript turn, a second booking or a
 * second escalation. If processing fails the claim is released, so the retry
 * that follows is handled properly rather than silently swallowed.
 */
export async function processVoiceWebhook(params: {
  provider: VoiceProvider;
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  url: string;
  now?: Date;
}): Promise<VoiceWebhookResult> {
  const { provider } = params;
  // Throws VoiceWebhookVerificationError for anything unverified; the route
  // answers 400 and nothing is recorded.
  const event = provider.verifyWebhook({ rawBody: params.rawBody, headers: params.headers, url: params.url });

  let claimed;
  try {
    claimed = await prisma.voiceWebhookEvent.create({
      data: {
        provider: provider.name,
        externalEventId: event.id,
        type: event.providerType.slice(0, 80),
        outcome: "processing",
        eventAt: event.occurredAt
      }
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { outcome: "duplicate" };
    }
    throw err;
  }

  try {
    const result = await applyVoiceEvent(provider, event, params.now ?? new Date());
    await prisma.voiceWebhookEvent.update({
      where: { id: claimed.id },
      data: {
        outcome: result.outcome === "duplicate" ? "duplicate" : result.outcome,
        detail: result.detail ?? null,
        callSessionId: result.callSessionId ?? null
      }
    });
    return result;
  } catch (err) {
    // Release the claim so the provider's retry is processed rather than
    // dismissed as a duplicate of a delivery that never actually landed.
    await prisma.voiceWebhookEvent.delete({ where: { id: claimed.id } }).catch(() => undefined);
    throw err;
  }
}

async function applyVoiceEvent(provider: VoiceProvider, event: VoiceEvent, now: Date): Promise<VoiceWebhookResult> {
  switch (event.type) {
    case "call.incoming":
      return beginInboundCall(provider, event, now);
    case "call.ringing":
      return updateStatus(provider, event, "ringing");
    case "call.answered":
      return markAnswered(provider, event, now);
    case "transcript.final":
      return handleCallerUtterance(provider, event, now);
    case "speech.interrupted":
      return handleInterruption(provider, event);
    case "call.transferred":
      return markTransferred(provider, event);
    case "call.completed":
      return endCall(provider, event, now, "completed");
    case "call.failed":
      return endCall(provider, event, now, "failed");
    default:
      return { outcome: "ignored", detail: "Event type Veyra does not act on." };
  }
}

/* ------------------------------------------------------------------ *
 * Inbound
 * ------------------------------------------------------------------ */

async function beginInboundCall(provider: VoiceProvider, event: VoiceEvent, now: Date): Promise<VoiceWebhookResult> {
  const dialled = event.to?.trim();
  if (!dialled) return { outcome: "ignored", detail: "No dialled number on the event." };

  // Which business was called. The number is unique, so this is unambiguous.
  const settings = await prisma.voiceSettings.findUnique({ where: { businessPhoneNumber: dialled } });
  if (!settings) {
    return { outcome: "ignored", detail: "No business is configured for the dialled number." };
  }

  // An already-recorded call id means this is a retry of the incoming event.
  const existing = await prisma.callSession.findUnique({
    where: { provider_externalCallId: { provider: provider.name, externalCallId: event.externalCallId } }
  });
  if (existing) return { outcome: "duplicate", callSessionId: existing.id };

  // Plan, direction, configuration, provider — all four, every call.
  try {
    await requireVoiceAccess({ businessId: settings.businessId, direction: "inbound", startingNewCall: true });
  } catch (err) {
    const reason =
      err instanceof EntitlementError
        ? "entitlement"
        : err instanceof VoiceUnavailableError
          ? "not_configured"
          : "limit";
    // Recorded as missed, with the reason kept internally. Reception
    // automation never starts, and the caller hears a neutral line rather than
    // anything about plans or limits.
    const session = await prisma.callSession.create({
      data: {
        businessId: settings.businessId,
        provider: provider.name,
        externalCallId: event.externalCallId,
        direction: "inbound",
        status: "missed",
        callerNumber: event.from ?? null,
        businessNumber: dialled,
        startedAt: now,
        endedAt: now,
        durationSeconds: 0,
        hangupReason: `voice_unavailable:${reason}`
      }
    });
    return {
      outcome: "processed",
      detail: `Voice unavailable (${reason}); the call was not answered by Veyra.`,
      callSessionId: session.id,
      instruction: { kind: "hangup", sayFirst: CANNOT_TAKE_CALLS }
    };
  }

  const business = await prisma.business.findUniqueOrThrow({ where: { id: settings.businessId } });

  // The conversation is an ordinary Veyra conversation. Everything downstream —
  // transcript, intents, actions, pilot metrics — therefore works unchanged.
  const conversation = await prisma.conversation.create({
    data: { businessId: settings.businessId, callerName: null }
  });

  const session = await prisma.callSession.create({
    data: {
      businessId: settings.businessId,
      conversationId: conversation.id,
      provider: provider.name,
      externalCallId: event.externalCallId,
      direction: "inbound",
      status: "ringing",
      callerNumber: event.from ?? null,
      businessNumber: dialled,
      startedAt: now
    }
  });

  const greeting = await spokenGreeting(settings, business, now);
  await prisma.message.create({
    data: { conversationId: conversation.id, sender: "receptionist", text: greeting.text }
  });

  return {
    outcome: "processed",
    callSessionId: session.id,
    detail: greeting.afterHours ? "Answered outside opening hours." : undefined,
    instruction: { kind: "say", text: greeting.text, then: greeting.then },
    // Only when Veyra will actually hold a conversation: a greeting that ends
    // in a hangup (Reception paused) has nothing to stream.
    answeredCall: greeting.then === "listen" ? { externalCallId: event.externalCallId, businessId: settings.businessId } : undefined
  };
}

/**
 * What Veyra says when it picks up.
 *
 * Reception being paused or in draft wins over everything: the caller gets the
 * business's own "contact us directly" message, the same one the text channel
 * uses. Otherwise the business's voice greeting, its written greeting, or —
 * outside opening hours — whatever it configured for after hours.
 */
async function spokenGreeting(
  settings: VoiceSettings,
  business: { greeting: string; name: string; receptionStatus: string; contactPhone: string | null; contactEmail: string | null; escalationFallbackMessage: string | null; timezone: string },
  now: Date
): Promise<{ text: string; then: "listen" | "hangup"; afterHours: boolean }> {
  if (business.receptionStatus !== "active") {
    return { text: unavailableMessage(business as never), then: "hangup", afterHours: false };
  }

  const base = settings.greeting?.trim() || business.greeting;
  const openNow = await isWithinOpeningHours(settings.businessId, business.timezone, now);
  if (openNow) return { text: base, then: "listen", afterHours: false };

  switch (settings.afterHoursBehavior) {
    case "voicemail":
      return {
        text: settings.voicemailGreeting?.trim() || `Thanks for calling ${business.name}. We're closed right now — please leave a message after the tone.`,
        then: "hangup",
        afterHours: true
      };
    case "handoff":
      // Only claim a transfer when there is somewhere to transfer to.
      return settings.handoffNumber
        ? { text: `Thanks for calling ${business.name}. We're closed, so I'll put you through to the on-call number.`, then: "listen", afterHours: true }
        : { text: `${base} We're closed at the moment, but I can still help or take a message.`, then: "listen", afterHours: true };
    case "booking_request":
    case "callback":
      return {
        text: `${base} We're closed right now, but I can take your details and have the team come back to you.`,
        then: "listen",
        afterHours: true
      };
    case "continue":
    default:
      return { text: base, then: "listen", afterHours: true };
  }
}

/** Reuses the business's configured weekly schedule — no second definition of "open". */
export async function isWithinOpeningHours(businessId: string, timezone: string, now: Date): Promise<boolean> {
  const hours = await prisma.businessHour.findMany({ where: { businessId } });
  if (hours.length === 0) return true; // Nothing configured: never treat callers as out of hours.
  const local = localParts(now, timezone);
  return hours.some(
    (period) =>
      period.dayOfWeek === local.weekday &&
      local.minuteOfDay >= period.opensMinute &&
      local.minuteOfDay < period.closesMinute
  );
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

async function sessionFor(provider: VoiceProvider, event: VoiceEvent): Promise<CallSession | null> {
  return prisma.callSession.findUnique({
    where: { provider_externalCallId: { provider: provider.name, externalCallId: event.externalCallId } }
  });
}

async function updateStatus(provider: VoiceProvider, event: VoiceEvent, to: CallStatus): Promise<VoiceWebhookResult> {
  const session = await sessionFor(provider, event);
  if (!session) return { outcome: "ignored", detail: "Unknown call." };
  if (session.status === to) return { outcome: "ignored", detail: "Already in that state.", callSessionId: session.id };
  assertCallTransition(session.status, to);
  await prisma.callSession.update({ where: { id: session.id }, data: { status: to } });
  return { outcome: "processed", callSessionId: session.id };
}

async function markAnswered(provider: VoiceProvider, event: VoiceEvent, now: Date): Promise<VoiceWebhookResult> {
  const session = await sessionFor(provider, event);
  if (!session) return { outcome: "ignored", detail: "Unknown call." };
  if (isTerminalCallStatus(session.status)) {
    return { outcome: "ignored", detail: "The call has already ended.", callSessionId: session.id };
  }
  if (session.status === "active") return { outcome: "ignored", detail: "Already answered.", callSessionId: session.id };

  assertCallTransition(session.status, "active");
  await prisma.callSession.update({
    where: { id: session.id },
    data: { status: "active", answeredAt: session.answeredAt ?? now }
  });
  return { outcome: "processed", callSessionId: session.id };
}

async function markTransferred(provider: VoiceProvider, event: VoiceEvent): Promise<VoiceWebhookResult> {
  const session = await sessionFor(provider, event);
  if (!session) return { outcome: "ignored", detail: "Unknown call." };
  if (isTerminalCallStatus(session.status)) {
    return { outcome: "ignored", detail: "The call has already ended.", callSessionId: session.id };
  }
  assertCallTransition(session.status, "transferring");
  await prisma.callSession.update({
    where: { id: session.id },
    data: { status: "transferring", handoffOccurred: true }
  });
  return { outcome: "processed", callSessionId: session.id };
}

async function endCall(
  provider: VoiceProvider,
  event: VoiceEvent,
  now: Date,
  status: "completed" | "failed"
): Promise<VoiceWebhookResult> {
  const session = await sessionFor(provider, event);
  if (!session) return { outcome: "ignored", detail: "Unknown call." };
  if (isTerminalCallStatus(session.status)) {
    // A carrier re-sending the hangup must not double-count the minutes.
    return { outcome: "ignored", detail: "The call has already ended.", callSessionId: session.id };
  }

  assertCallTransition(session.status, status);
  const durationSeconds =
    event.durationSeconds ?? Math.max(0, Math.round((now.getTime() - session.startedAt.getTime()) / 1000));

  await prisma.callSession.update({
    where: { id: session.id },
    data: {
      status,
      endedAt: now,
      durationSeconds,
      hangupReason: event.hangupCause ?? (status === "failed" ? "failed" : "caller_hangup")
    }
  });

  await applyTranscriptPolicy(session);
  return { outcome: "processed", callSessionId: session.id };
}

/**
 * Honours the business's transcript policy once the call is over.
 *
 * With `metadata_only`, what was said is replaced with a placeholder when the
 * call ends: Veyra needs the words during the call to hold a conversation at
 * all, but nothing is kept afterwards. Intents, actions and outcomes remain,
 * so metrics and pilot review still work without storing anyone's words.
 */
async function applyTranscriptPolicy(session: CallSession): Promise<void> {
  if (!session.conversationId) return;
  const settings = await prisma.voiceSettings.findUnique({ where: { businessId: session.businessId } });
  if (!settings || settings.transcriptPolicy !== "metadata_only") return;

  await prisma.message.updateMany({
    where: { conversationId: session.conversationId },
    data: { text: "[not stored: this business keeps call metadata only]" }
  });
}

/* ------------------------------------------------------------------ *
 * A turn
 * ------------------------------------------------------------------ */

async function handleInterruption(provider: VoiceProvider, event: VoiceEvent): Promise<VoiceWebhookResult> {
  const session = await sessionFor(provider, event);
  if (!session) return { outcome: "ignored", detail: "Unknown call." };
  if (session.status !== "active") {
    return { outcome: "ignored", detail: "Not a live call.", callSessionId: session.id };
  }

  // Barge-in: stop talking immediately. The caller's words arrive as the next
  // transcript event and are handled as an ordinary turn.
  await provider.cancelSpeech(session.externalCallId).catch((err) => {
    console.error("[veyra:voice] could not stop speech for an interruption", err instanceof Error ? err.message : err);
  });
  const lastTurn = await prisma.callTurn.findFirst({
    where: { callSessionId: session.id },
    orderBy: { createdAt: "desc" }
  });
  if (lastTurn) await prisma.callTurn.update({ where: { id: lastTurn.id }, data: { interrupted: true } });

  return { outcome: "processed", callSessionId: session.id, detail: "Caller interrupted; speech cancelled." };
}

/**
 * The caller said something.
 *
 * This is the whole point of the phase: the words go into the same Reception
 * pipeline as a typed message, and whatever comes back is spoken. Booking,
 * rescheduling, cancelling and escalating all happen inside that pipeline with
 * their existing confirmation rules — a caller saying "Monday at three" gets
 * an offer, and only an explicit yes books anything.
 */
async function handleCallerUtterance(provider: VoiceProvider, event: VoiceEvent, now: Date): Promise<VoiceWebhookResult> {
  const session = await sessionFor(provider, event);
  if (!session) return { outcome: "ignored", detail: "Unknown call." };
  if (session.status !== "active" || !session.conversationId) {
    return { outcome: "ignored", detail: "Not a live answered call.", callSessionId: session.id };
  }
  const transcript = event.transcript?.trim();
  if (!transcript) {
    // Recognition produced nothing usable: ask rather than guess.
    return {
      outcome: "processed",
      callSessionId: session.id,
      detail: "Empty transcript; asked the caller to repeat.",
      instruction: { kind: "say", text: "Sorry, I didn't catch that. Could you say it again?", then: "listen" }
    };
  }

  const settings = await prisma.voiceSettings.findUnique({ where: { businessId: session.businessId } });

  // A hard ceiling, so a call cannot run forever.
  const elapsedSeconds = Math.round((now.getTime() - session.startedAt.getTime()) / 1000);
  if (settings && elapsedSeconds > settings.maxCallSeconds) {
    await provider.hangup({ externalCallId: session.externalCallId, reason: "timeout" }).catch(() => undefined);
    return {
      outcome: "processed",
      callSessionId: session.id,
      detail: "Call exceeded its maximum duration.",
      instruction: { kind: "hangup", sayFirst: "I need to end the call here, but the team can pick this up. Thanks for calling." }
    };
  }

  const turnStartedAt = Date.now();
  const turn = await handleReceptionTurn({ conversationId: session.conversationId, callerText: transcript });
  const replyText = turn.receptionistMessage.text;

  // Synthesis is measured but never allowed to lose the turn: if it fails, the
  // provider still speaks the same words.
  let ttsMs: number | null = null;
  const tts = textToSpeechProvider();
  if (tts && settings) {
    const startedAt = Date.now();
    try {
      await tts.synthesize({ text: replyText, voiceProfile: settings.voiceProfile, language: settings.language });
      ttsMs = Date.now() - startedAt;
    } catch (err) {
      console.error("[veyra:voice] speech synthesis failed; falling back to the provider's own voice", err instanceof Error ? err.message : err);
    }
  }

  const instruction = await instructionFor({ turn, session, settings, provider });

  await prisma.callTurn.create({
    data: {
      callSessionId: session.id,
      messageId: turn.receptionistMessage.id,
      responderMs: turn.timings.responderMs,
      actionMs: turn.timings.actionMs,
      ttsMs,
      totalMs: Date.now() - turnStartedAt
    }
  });

  if (instruction.kind === "transfer") {
    await prisma.callSession.update({ where: { id: session.id }, data: { handoffOccurred: true } });
  }

  return { outcome: "processed", callSessionId: session.id, instruction };
}

/**
 * Turns a Reception reply into something the line should do.
 *
 * The only voice-specific decision in the whole flow: whether a handoff can be
 * an actual transfer. If it cannot — no number, or a provider that can't do it
 * — the escalation the pipeline already created stands, and the caller is told
 * the truth rather than being promised a transfer that will not happen.
 */
async function instructionFor(params: {
  turn: Awaited<ReturnType<typeof handleReceptionTurn>>;
  session: CallSession;
  settings: VoiceSettings | null;
  provider: VoiceProvider;
}): Promise<CallInstruction> {
  const { turn, settings, provider } = params;
  const replyText = turn.receptionistMessage.text;

  const escalating =
    turn.actionResult.action === "escalate_to_human" &&
    (turn.actionResult.status === "completed" || turn.actionResult.status === "pending");

  if (escalating && settings?.handoffNumber && provider.supportsTransfer) {
    return {
      kind: "transfer",
      to: settings.handoffNumber,
      sayFirst: "Let me put you through to someone now."
    };
  }
  if (escalating) {
    // No transfer available. The escalation exists, the team has been
    // notified, and the caller hears exactly that — never a pretend transfer.
    return { kind: "say", text: replyText, then: "listen" };
  }

  if (turn.status === "unavailable") {
    return { kind: "hangup", sayFirst: replyText };
  }
  return { kind: "say", text: replyText, then: "listen" };
}

/* ------------------------------------------------------------------ *
 * Outbound
 * ------------------------------------------------------------------ */

/**
 * Places a call.
 *
 * Deliberately conservative for this phase: an operator or admin asks for a
 * specific call to a specific number, and Veyra places exactly that one. There
 * is no scheduler, no queue and no campaign runner — nothing in Veyra can
 * decide by itself to ring somebody.
 */
export async function startOutboundCall(params: {
  businessId: string;
  to: string;
  actorUserId: string;
  now?: Date;
}): Promise<CallSession> {
  const now = params.now ?? new Date();
  const { settings, provider } = await requireVoiceAccess({
    businessId: params.businessId,
    direction: "outbound",
    startingNewCall: true
  });

  const from = settings.callerId?.trim() || settings.businessPhoneNumber?.trim();
  if (!from) {
    throw new VoiceUnavailableError("This business has no caller ID or phone number to call from.");
  }

  let placed;
  try {
    placed = await provider.startOutboundCall({ to: params.to, from, businessId: params.businessId });
  } catch (err) {
    if (err instanceof VoiceProviderError) {
      throw new VoiceUnavailableError(`The voice provider could not place the call: ${err.message}`);
    }
    throw err;
  }

  const conversation = await prisma.conversation.create({
    data: { businessId: params.businessId, callerName: null }
  });

  return prisma.callSession.create({
    data: {
      businessId: params.businessId,
      conversationId: conversation.id,
      provider: provider.name,
      externalCallId: placed.externalCallId,
      direction: "outbound",
      status: "initiated",
      callerNumber: params.to,
      businessNumber: from,
      startedAt: now
    }
  });
}
