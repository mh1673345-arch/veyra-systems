import type { Appointment, Conversation, Escalation, Message } from "@prisma/client";
import {
  CONVERSATION_OUTCOMES,
  type ConversationOutcome,
  type ConversationOutcomeState
} from "@veyra/shared";

/**
 * What happened in a conversation.
 *
 * Derived from records Veyra actually holds — bookings, escalations, the
 * intents and action outcomes already stored on each reply — and computed at
 * read time so analytics can never drift from the underlying rows.
 *
 * When the evidence does not support a classification, the answer is
 * `undetermined`. That is deliberate: a guess here would quietly become a
 * pilot statistic. An operator can correct any conversation, and their
 * correction always wins.
 */

export interface OutcomeEvidence {
  conversation: Pick<Conversation, "id" | "status" | "createdAt" | "outcomeOverride" | "outcomeOverrideNote" | "outcomeOverrideAt">;
  messages: Pick<Message, "sender" | "intent" | "action" | "actionStatus" | "createdAt">[];
  appointments: Pick<Appointment, "status" | "mode">[];
  escalations: Pick<Escalation, "status">[];
  /** An operator marked a reply incorrect or "needed a human". */
  hasNegativeFeedback?: boolean;
  /** An operator changed a booking or escalation in this conversation. */
  hasOperatorAction?: boolean;
  overriddenBy?: string | null;
}

export function isConversationOutcome(value: string): value is ConversationOutcome {
  return (CONVERSATION_OUTCOMES as string[]).includes(value);
}

export function deriveOutcome(evidence: OutcomeEvidence): ConversationOutcomeState {
  const { conversation, messages, appointments, escalations } = evidence;

  if (conversation.outcomeOverride && isConversationOutcome(conversation.outcomeOverride)) {
    return {
      outcome: conversation.outcomeOverride,
      source: "operator",
      evidence: "Set by an operator.",
      overriddenBy: evidence.overriddenBy ?? null,
      overriddenAt: conversation.outcomeOverrideAt?.toISOString() ?? null,
      note: conversation.outcomeOverrideNote ?? null
    };
  }

  const callerMessages = messages.filter((m) => m.sender === "caller");
  const replies = messages.filter((m) => m.sender === "receptionist");

  // A caller who never said anything did not have a conversation.
  if (callerMessages.length === 0) {
    return { outcome: "abandoned", source: "derived", evidence: "The caller never sent a message." };
  }

  // Strongest evidence first: something concrete happened.
  if (appointments.some((a) => a.status === "confirmed")) {
    return { outcome: "booking_confirmed", source: "derived", evidence: "A booking was confirmed in this conversation." };
  }
  if (escalations.length > 0) {
    return { outcome: "escalated", source: "derived", evidence: "A handoff to a person was created." };
  }
  if (appointments.length > 0) {
    return { outcome: "booking_requested", source: "derived", evidence: "An appointment request was collected." };
  }

  // A human had to step in, even though nothing was booked or escalated.
  if (evidence.hasNegativeFeedback || evidence.hasOperatorAction) {
    return {
      outcome: "human_intervention",
      source: "derived",
      evidence: evidence.hasNegativeFeedback
        ? "An operator marked a reply as incorrect or needing a person."
        : "An operator acted on this conversation."
    };
  }

  // A failed action that reached the caller is a failure, not an answer.
  if (replies.some((m) => m.actionStatus === "failed")) {
    return { outcome: "failed", source: "derived", evidence: "An action failed during the conversation." };
  }

  if (replies.length === 0) {
    return { outcome: "undetermined", source: "derived", evidence: "The caller wrote, but no reply was recorded." };
  }

  // Every reply was "I don't have that on file": Veyra did not help.
  const answered = replies.filter((m) => m.intent && m.intent !== "out_of_scope" && m.intent !== "acknowledgement" && m.intent !== "greeting");
  const outOfScope = replies.filter((m) => m.intent === "out_of_scope");
  if (outOfScope.length > 0 && answered.length === 0) {
    return { outcome: "out_of_scope", source: "derived", evidence: "Every substantive reply was outside what Veyra knows." };
  }

  if (answered.length > 0) {
    return {
      outcome: "answered",
      source: "derived",
      evidence: `Veyra answered ${answered.length} question${answered.length === 1 ? "" : "s"} from the business's own information.`
    };
  }

  // Greetings and "thanks" only — nothing was actually asked.
  return { outcome: "undetermined", source: "derived", evidence: "Nothing was asked that Veyra could act on." };
}
