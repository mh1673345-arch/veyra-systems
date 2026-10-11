import type { ActionResult } from "@veyra/shared";
import type { Message } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { loadBusinessContext } from "../businessContext.js";
import { createAiResponder } from "../ai/index.js";
import { executeAssistantAction } from "../actions/actionExecutor.js";
import { resolveCalendarAction } from "../actions/calendarActions.js";
import { unavailableMessage, withClosing } from "../ai/presentation.js";
import type { BusinessContext, ConversationTurn } from "../ai/types.js";
import { recordKnowledgeGap } from "../pilot/knowledgeGaps.js";

/**
 * One turn of Reception, whatever channel it arrived on.
 *
 * This is the single path from "a caller said something" to "Veyra answered
 * and, if allowed, did something". The HTTP chat endpoint calls it; so does a
 * phone call. That is deliberate and load-bearing: a voice caller asking the
 * price of a service must get the same grounded answer, from the same business
 * information, through the same action boundary, as anyone typing — and a
 * second implementation would inevitably drift from the first.
 *
 * Channels are responsible only for getting text in and rendering what comes
 * out. Nothing about audio, sockets or telephony belongs here.
 */

/** Bounded conversation memory: how many prior messages get sent to the AI provider. */
const MAX_HISTORY_MESSAGES = 12;

export interface ReceptionTurn {
  /** "unavailable" when Reception is paused or still in draft. */
  status: "answered" | "unavailable";
  callerMessage: Message;
  receptionistMessage: Message;
  actionResult: ActionResult;
  context: BusinessContext | null;
  /**
   * Where the time went inside Veyra. Channels that care about perceived
   * responsiveness (voice) record it; the text channel ignores it.
   */
  timings: { responderMs: number; actionMs: number; totalMs: number };
}

export async function handleReceptionTurn(params: {
  conversationId: string;
  callerText: string;
}): Promise<ReceptionTurn> {
  const startedAt = Date.now();

  const conversation = await prisma.conversation.findUnique({
    where: { id: params.conversationId },
    include: { business: true }
  });
  if (!conversation) throw new HttpError(404, "Conversation not found");

  // Paused (or still in draft): no AI, no actions, no bookings — just the
  // business's contact details. Read fresh, so pausing takes effect on the
  // very next message.
  if (conversation.business.receptionStatus !== "active") {
    const [callerMessage, receptionistMessage] = await prisma.$transaction([
      prisma.message.create({
        data: { conversationId: conversation.id, sender: "caller", text: params.callerText }
      }),
      prisma.message.create({
        data: {
          conversationId: conversation.id,
          sender: "receptionist",
          text: unavailableMessage(conversation.business),
          action: "none"
        }
      })
    ]);
    return {
      status: "unavailable",
      callerMessage,
      receptionistMessage,
      actionResult: {
        action: "none",
        status: "not_required",
        metadata: { receptionStatus: conversation.business.receptionStatus }
      },
      context: null,
      timings: { responderMs: 0, actionMs: 0, totalMs: Date.now() - startedAt }
    };
  }

  const priorMessages = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "desc" },
    take: MAX_HISTORY_MESSAGES
  });
  const history: ConversationTurn[] = priorMessages
    .reverse()
    .map((m) => ({ role: m.sender === "receptionist" ? "receptionist" : "caller", text: m.text }));

  const callerMessage = await prisma.message.create({
    data: { conversationId: conversation.id, sender: "caller", text: params.callerText }
  });

  const context = await loadBusinessContext(conversation.businessId);
  const responder = createAiResponder();
  const responderStartedAt = Date.now();
  const { result: reply, trace } = await responder.respondTraced({
    callerText: params.callerText,
    history,
    context
  });
  const responderMs = Date.now() - responderStartedAt;

  // What the turn really is, decided by the application: a "yes" only
  // confirms when a slot is actually held, and a booking turn only becomes an
  // availability check when a time can be parsed and the calendar is live.
  const actionStartedAt = Date.now();
  const requestedAction = await resolveCalendarAction({
    requestedAction: reply.action,
    callerText: params.callerText,
    conversationId: conversation.id,
    businessId: conversation.businessId,
    capabilities: context.capabilities
  });

  // The AI only *requests* an action; the executor decides what may happen.
  const actionResult = await executeAssistantAction({
    action: requestedAction,
    conversationId: conversation.id,
    businessId: conversation.businessId,
    capabilities: context.capabilities,
    callerText: params.callerText
  });
  const actionMs = Date.now() - actionStartedAt;

  // An action the business can't support must not be advertised as available.
  const effectiveAction = actionResult.status === "unsupported" ? "none" : (requestedAction as typeof reply.action);

  // Anything factual — availability, a confirmation, a cancellation — is
  // worded by the application, not the model, so the caller is never told
  // something the calendar did not actually say.
  const replyText =
    actionResult.callerMessage ?? withClosing(reply.message, reply.intent, context.closingStyle, context.name);

  // Server-side only, opt-in via VEYRA_DEBUG_INTENT — never returned to any
  // client. Caller text is only included at verbose level.
  const debugLevel = process.env.VEYRA_DEBUG_INTENT;
  if (debugLevel === "1" || debugLevel === "verbose") {
    console.log(
      "[veyra:intent] business=%s responder=%s fallbackReason=%s intent=%s confidence=%s " +
        "requestedAction=%s validatedAction=%s actionStatus=%s clarify=%s historyTurns=%d%s",
      context.name,
      trace.responder,
      trace.fallbackReason ?? "-",
      reply.intent,
      reply.confidence.toFixed(2),
      reply.action,
      effectiveAction,
      actionResult.status,
      reply.requiresClarification,
      history.length,
      debugLevel === "verbose" ? ` message=${JSON.stringify(params.callerText)}` : ""
    );
  }

  const receptionistMessage = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      sender: "receptionist",
      text: replyText,
      intent: reply.intent,
      action: effectiveAction,
      confidence: reply.confidence,
      requiresClarification: reply.requiresClarification,
      // Operator-visible diagnostics for pilot review. Which responder
      // answered and why the primary one was skipped — never the prompt, the
      // model's reasoning or anything provider-specific.
      responder: trace.responder === "anthropic" ? "anthropic" : "rule_based",
      fallbackReason: trace.fallbackReason ?? null,
      actionStatus: actionResult.status
    }
  });

  // A question Veyra could not answer from the business's own information is
  // recorded as a knowledge gap, so the pilot can show what to add. Never
  // allowed to affect the caller's turn.
  await recordKnowledgeGap({
    businessId: conversation.businessId,
    conversationId: conversation.id,
    messageId: receptionistMessage.id,
    callerText: params.callerText,
    intent: reply.intent,
    context
  }).catch((err) => console.error("[veyra:pilot] knowledge gap capture failed", err));

  return {
    status: "answered",
    callerMessage,
    receptionistMessage,
    actionResult,
    context,
    timings: { responderMs, actionMs, totalMs: Date.now() - startedAt }
  };
}
