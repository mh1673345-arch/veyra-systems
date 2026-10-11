import type {
  ConversationOutcome,
  PilotIntentCount,
  PilotMetric,
  PilotMetrics,
  PilotRange,
  PilotSeriesPoint
} from "@veyra/shared";
import { CONVERSATION_OUTCOME_LABELS, PILOT_ALERT_DEFAULTS } from "@veyra/shared";
import { prisma } from "../../db/client.js";
import { deriveOutcome } from "./outcomes.js";
import { localDay, localDays, rangeWindow } from "./range.js";

/**
 * Pilot measurement, derived entirely from records Veyra already holds.
 *
 * Two rules, applied everywhere below:
 *
 *   - A metric that cannot be derived is `null`, with a reason. It is never 0.
 *     "No data yet" and "zero happened" are different claims, and a pilot
 *     review that confuses them is worse than no dashboard at all.
 *   - A rate is only reported when its denominator is explicit and big enough
 *     to mean anything (PILOT_ALERT_DEFAULTS.minimumSampleForRates). The
 *     definition travels with the number, so nobody has to guess what
 *     "self-service resolution" counts.
 *
 * Nothing here measures revenue, time saved or satisfaction. Those need real
 * pilot evidence from the customer, not rows in this database.
 */

const metric = (
  key: string,
  label: string,
  value: number | null,
  definition: string,
  extra: Partial<PilotMetric> = {}
): PilotMetric => ({ key, label, value, definition, ...extra });

const unavailable = (key: string, label: string, definition: string, reason: string): PilotMetric =>
  metric(key, label, null, definition, { unavailableReason: reason });

export interface PilotMetricsResult extends PilotMetrics {
  /** Reused by the report and alerts so nothing is counted twice. */
  raw: RawCounts;
}

export interface RawCounts {
  conversations: number;
  conversationsWithCallerMessage: number;
  callerMessages: number;
  receptionistReplies: number;
  fallbackReplies: number;
  outOfScopeReplies: number;
  bookingRequests: number;
  confirmedBookings: number;
  cancelledBookings: number;
  escalations: number;
  resolvedEscalations: number;
  humanInterventions: number;
  notifications: number;
  failedNotifications: number;
  // Contact coverage: can Veyra actually tell these customers anything?
  // Operational counts only - no ratio is published from them, because a
  // business that never needs to message anyone is not failing at it.
  bookingsWithContact: number;
  bookingsMissingContact: number;
  // Transactional confirmations actually attempted for this window. Counted
  // from the decision records, so a transition Veyra never considered is not
  // silently counted as a success.
  bookingConfirmationsQueued: number;
  bookingConfirmationsDelivered: number;
  bookingConfirmationsFailed: number;
  bookingConfirmationsNoDestination: number;
  /** Messaging channels, counted from the same notification rows. */
  smsMessagesSent: number;
  smsMessagesDelivered: number;
  smsFailures: number;
  whatsappMessagesSent: number;
  whatsappMessagesDelivered: number;
  whatsappFailures: number;
  activeOperators: number;
  /** The voice channel, measured from the same records as everything else. */
  voiceCalls: number;
  voiceAnsweredCalls: number;
  voiceBookings: number;
  voiceHandoffs: number;
  voiceMinutes: number;
  outcomes: Record<ConversationOutcome, number>;
  /** Escalation resolution durations, in seconds. */
  resolutionSeconds: number[];
  firstResponseSeconds: number[];
}

export async function collectRawCounts(businessId: string, range: PilotRange): Promise<RawCounts> {
  const window = rangeWindow(range);

  const [conversations, appointments, escalations, notifications, feedback, statusEvents, confirmations, calls] = await Promise.all([
    prisma.conversation.findMany({
      where: { businessId, createdAt: window },
      select: {
        id: true,
        status: true,
        createdAt: true,
        outcomeOverride: true,
        outcomeOverrideNote: true,
        outcomeOverrideAt: true,
        messages: {
          orderBy: { createdAt: "asc" },
          select: { sender: true, intent: true, action: true, actionStatus: true, responder: true, fallbackReason: true, createdAt: true }
        },
        appointments: { select: { status: true, mode: true } },
        escalations: { select: { status: true } }
      }
    }),
    prisma.appointment.findMany({
      where: { businessId, createdAt: window },
      select: { status: true, mode: true, confirmedAt: true, cancelledAt: true, customerContactId: true }
    }),
    prisma.escalation.findMany({
      where: { businessId, createdAt: window },
      select: { status: true, createdAt: true, resolvedAt: true }
    }),
    prisma.notification.findMany({
      where: { businessId, createdAt: window },
      select: { id: true, status: true, channel: true, deliveryStatus: true }
    }),
    prisma.conversationFeedback.findMany({
      where: { businessId, createdAt: window },
      select: { conversationId: true, rating: true }
    }),
    prisma.statusEvent.findMany({
      where: { businessId, createdAt: window, actorUserId: { not: null } },
      select: { actorUserId: true, entityType: true, entityId: true }
    }),
    // What Veyra decided to tell each customer, including the transitions it
    // could not tell anyone about.
    prisma.bookingConfirmation.findMany({
      where: { businessId, createdAt: window },
      select: { outcome: true, notificationId: true }
    }),
    // Voice is a channel over the same conversations, so its calls are counted
    // here rather than in a separate analytics stack.
    prisma.callSession.findMany({
      where: { businessId, startedAt: window },
      select: { id: true, status: true, conversationId: true, durationSeconds: true, handoffOccurred: true }
    })
  ]);

  // Delivery is only ever a provider receipt, so it is looked up rather
  // than inferred from the confirmation record.
  const deliveredNotificationIds = new Set(
    notifications.filter((n) => n.deliveryStatus === "delivered").map((n) => n.id)
  );

  const negativeFeedbackConversations = new Set(
    feedback.filter((f) => f.rating === "incorrect" || f.rating === "needed_human").map((f) => f.conversationId)
  );

  const outcomes = Object.fromEntries(
    Object.keys(CONVERSATION_OUTCOME_LABELS).map((key) => [key, 0])
  ) as Record<ConversationOutcome, number>;

  let callerMessages = 0;
  let receptionistReplies = 0;
  let fallbackReplies = 0;
  let outOfScopeReplies = 0;
  let conversationsWithCallerMessage = 0;
  let humanInterventions = 0;
  const firstResponseSeconds: number[] = [];

  for (const conversation of conversations) {
    const callers = conversation.messages.filter((m) => m.sender === "caller");
    const replies = conversation.messages.filter((m) => m.sender === "receptionist");
    callerMessages += callers.length;
    receptionistReplies += replies.length;
    // Only replies that recorded which responder answered can be judged; older
    // rows (before this was tracked) are excluded from the denominator too.
    fallbackReplies += replies.filter((m) => m.responder === "rule_based" && m.fallbackReason && m.fallbackReason !== "no_api_key").length;
    outOfScopeReplies += replies.filter((m) => m.intent === "out_of_scope").length;
    if (callers.length > 0) conversationsWithCallerMessage += 1;

    // First response: the first reply after the caller's first message.
    const firstCaller = callers[0];
    if (firstCaller) {
      const firstReply = replies.find((m) => m.createdAt > firstCaller.createdAt);
      if (firstReply) {
        firstResponseSeconds.push((firstReply.createdAt.getTime() - firstCaller.createdAt.getTime()) / 1000);
      }
    }

    const outcome = deriveOutcome({
      conversation,
      messages: conversation.messages,
      appointments: conversation.appointments,
      escalations: conversation.escalations,
      hasNegativeFeedback: negativeFeedbackConversations.has(conversation.id),
      hasOperatorAction: false
    });
    outcomes[outcome.outcome] += 1;
  }

  // A human stepped in: a handoff was created, an operator moved a booking or
  // escalation along, or an operator marked a reply wrong.
  const operatorTouchedConversations = new Set(negativeFeedbackConversations);
  humanInterventions =
    escalations.length +
    statusEvents.filter((event) => event.entityType === "booking" || event.entityType === "escalation").length +
    operatorTouchedConversations.size;

  // A voice booking is an ordinary booking that happened to arrive by phone:
  // matched through the call's conversation, never counted twice.
  const voiceConversationIds = new Set(calls.map((call) => call.conversationId).filter((id): id is string => Boolean(id)));
  const voiceBookings = await prisma.appointment.count({
    where: { businessId, createdAt: window, conversationId: { in: [...voiceConversationIds] } }
  });
  const voiceEscalations = await prisma.escalation.count({
    where: { businessId, createdAt: window, conversationId: { in: [...voiceConversationIds] } }
  });

  const resolutionSeconds = escalations
    .filter((escalation) => escalation.resolvedAt)
    .map((escalation) => (escalation.resolvedAt!.getTime() - escalation.createdAt.getTime()) / 1000);

  return {
    conversations: conversations.length,
    conversationsWithCallerMessage,
    callerMessages,
    receptionistReplies,
    fallbackReplies,
    outOfScopeReplies,
    bookingRequests: appointments.length,
    confirmedBookings: appointments.filter((a) => a.status === "confirmed").length,
    cancelledBookings: appointments.filter((a) => a.status === "cancelled").length,
    escalations: escalations.length,
    resolvedEscalations: escalations.filter((e) => e.status === "resolved").length,
    humanInterventions,
    notifications: notifications.length,
    failedNotifications: notifications.filter((n) => n.status === "failed").length,
    // Whether a booking has anyone to confirm to. Counted, never turned into
    // a score: plenty of bookings legitimately need no message at all.
    bookingsWithContact: appointments.filter((a) => a.customerContactId !== null).length,
    bookingsMissingContact: appointments.filter((a) => a.customerContactId === null).length,
    // Confirmations are counted from what Veyra decided, and delivery only
    // from a provider receipt — a queued message is not a delivered one.
    bookingConfirmationsQueued: confirmations.filter((c) => c.outcome === "queued").length,
    bookingConfirmationsDelivered: confirmations.filter(
      (c) => c.notificationId !== null && deliveredNotificationIds.has(c.notificationId)
    ).length,
    bookingConfirmationsFailed: confirmations.filter((c) => c.outcome === "blocked").length,
    bookingConfirmationsNoDestination: confirmations.filter((c) => c.outcome === "no_destination").length,
    // Messaging is measured from the same rows as every other notification,
    // so there is no second analytics stack to drift. "Sent" means Veyra's
    // worker handed it over; "delivered" means the provider said a handset
    // got it — a receipt, never an assumption.
    ...messagingCounts(notifications),
    activeOperators: new Set(statusEvents.map((event) => event.actorUserId)).size,
    voiceCalls: calls.length,
    voiceAnsweredCalls: calls.filter((call) => call.status !== "missed" && call.status !== "failed").length,
    voiceBookings,
    voiceHandoffs: calls.filter((call) => call.handoffOccurred).length + voiceEscalations,
    voiceMinutes: Math.ceil(calls.reduce((total, call) => total + (call.durationSeconds ?? 0), 0) / 60),
    outcomes,
    resolutionSeconds,
    firstResponseSeconds
  };
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator < PILOT_ALERT_DEFAULTS.minimumSampleForRates) return null;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

export async function pilotMetrics(businessId: string, range: PilotRange): Promise<PilotMetricsResult> {
  const raw = await collectRawCounts(businessId, range);
  const sample = `Needs at least ${PILOT_ALERT_DEFAULTS.minimumSampleForRates} in the period before a rate means anything.`;

  const voiceMetrics: PilotMetric[] =
    raw.voiceCalls === 0
      ? []
      : [
          metric("voice_calls", "Phone calls", raw.voiceCalls, "Calls that reached Veyra in the period."),
          metric("voice_answered", "Calls answered", raw.voiceAnsweredCalls, "Calls Veyra actually picked up, rather than missing or failing."),
          metric("voice_minutes", "Voice minutes", raw.voiceMinutes, "Minutes of connected call time, rounded up per call."),
          metric("voice_bookings", "Bookings by phone", raw.voiceBookings, "Appointments created in a conversation that came from a call."),
          metric("voice_handoffs", "Handoffs by phone", raw.voiceHandoffs, "Calls transferred to a person, or that created an escalation.")
        ];

  const activity: PilotMetric[] = [
    metric("conversations", "Conversations", raw.conversations, "Conversations started in the period."),
    metric(
      "engaged_conversations",
      "Conversations with a caller message",
      raw.conversationsWithCallerMessage,
      "Conversations where the caller actually said something — the rest are opened and abandoned."
    ),
    metric("caller_messages", "Caller messages", raw.callerMessages, "Messages sent by callers."),
    metric("replies", "Veyra replies", raw.receptionistReplies, "Replies Veyra sent."),
    metric("notifications", "Notifications generated", raw.notifications, "Notification records created for this business."),
    metric("active_operators", "Active operators", raw.activeOperators, "People who moved a booking or escalation along in the period."),
    ...voiceMetrics
  ];

  const outcomes: PilotMetric[] = [
    metric("booking_requests", "Booking requests", raw.bookingRequests, "Appointment records created in the period, both request-mode and calendar."),
    metric("confirmed_bookings", "Confirmed bookings", raw.confirmedBookings, "Appointments now in the confirmed state."),
    metric("cancelled_bookings", "Cancelled bookings", raw.cancelledBookings, "Appointments now in the cancelled state."),
    metric("escalations", "Handoffs to a person", raw.escalations, "Escalations created in the period."),
    metric("resolved_escalations", "Handoffs resolved", raw.resolvedEscalations, "Escalations now resolved."),
    metric("human_interventions", "Human interventions", raw.humanInterventions, "Handoffs created, plus operator changes to bookings or handoffs, plus replies an operator marked wrong."),
    metric("fallback_replies", "Fallback replies", raw.fallbackReplies, "Replies where the primary responder was unavailable and the deterministic responder answered instead."),
    metric("out_of_scope_replies", "Out-of-scope replies", raw.outOfScopeReplies, "Replies where Veyra had nothing on file to answer with.")
  ];

  const bookingConversion = rate(raw.bookingRequests, raw.conversationsWithCallerMessage);
  const interventionRate = rate(raw.humanInterventions, raw.conversationsWithCallerMessage);
  const fallbackRate = rate(raw.fallbackReplies, raw.receptionistReplies);
  const selfServed =
    raw.outcomes.answered + raw.outcomes.booking_confirmed + raw.outcomes.booking_requested;
  const selfServiceRate = rate(selfServed, raw.conversationsWithCallerMessage);

  const derived: PilotMetric[] = [
    bookingConversion === null
      ? unavailable("booking_conversion", "Booking conversion", "Booking requests ÷ conversations where the caller said something.", sample)
      : metric("booking_conversion", "Booking conversion", bookingConversion, "Booking requests ÷ conversations where the caller said something.", { unit: "percent" }),
    interventionRate === null
      ? unavailable("human_intervention_rate", "Human intervention rate", "Human interventions ÷ conversations where the caller said something.", sample)
      : metric("human_intervention_rate", "Human intervention rate", interventionRate, "Human interventions ÷ conversations where the caller said something.", { unit: "percent" }),
    fallbackRate === null
      ? unavailable("fallback_rate", "Fallback rate", "Fallback replies ÷ all Veyra replies.", sample)
      : metric("fallback_rate", "Fallback rate", fallbackRate, "Fallback replies ÷ all Veyra replies.", { unit: "percent" }),
    selfServiceRate === null
      ? unavailable(
          "self_service_rate",
          "Self-service resolution",
          "Conversations that ended answered, booked or with a booking request ÷ conversations where the caller said something. It does not mean the caller was satisfied.",
          sample
        )
      : metric(
          "self_service_rate",
          "Self-service resolution",
          selfServiceRate,
          "Conversations that ended answered, booked or with a booking request ÷ conversations where the caller said something. It does not mean the caller was satisfied.",
          { unit: "percent" }
        ),
    raw.firstResponseSeconds.length === 0
      ? unavailable("first_response", "Average first response", "Time from the caller's first message to Veyra's first reply.", "No completed exchanges in the period.")
      : metric("first_response", "Average first response", average(raw.firstResponseSeconds), "Time from the caller's first message to Veyra's first reply.", { unit: "seconds" }),
    raw.resolutionSeconds.length === 0
      ? unavailable("escalation_resolution", "Average handoff resolution", "Time from a handoff being created to an operator resolving it.", "No handoffs were resolved in the period.")
      : metric("escalation_resolution", "Average handoff resolution", average(raw.resolutionSeconds), "Time from a handoff being created to an operator resolving it.", { unit: "seconds" })
  ];

  return { range, activity, outcomes, derived, raw };
}

/** Daily counts for the charts. Every day in the range appears, including empty ones. */
export async function pilotSeries(businessId: string, range: PilotRange): Promise<PilotSeriesPoint[]> {
  const window = rangeWindow(range);
  const [conversations, appointments, escalations] = await Promise.all([
    prisma.conversation.findMany({ where: { businessId, createdAt: window }, select: { createdAt: true } }),
    prisma.appointment.findMany({ where: { businessId, createdAt: window }, select: { createdAt: true } }),
    prisma.escalation.findMany({ where: { businessId, createdAt: window }, select: { createdAt: true } })
  ]);

  const points = new Map<string, PilotSeriesPoint>(
    localDays(range).map((date) => [date, { date, conversations: 0, bookings: 0, escalations: 0 }])
  );
  const bump = (at: Date, field: "conversations" | "bookings" | "escalations") => {
    const point = points.get(localDay(at, range.timezone));
    if (point) point[field] += 1;
  };
  for (const row of conversations) bump(row.createdAt, "conversations");
  for (const row of appointments) bump(row.createdAt, "bookings");
  for (const row of escalations) bump(row.createdAt, "escalations");

  return [...points.values()];
}

const INTENT_LABELS: Record<string, string> = {
  greeting: "Greeting",
  business_information: "Business information",
  service: "Service question",
  service_list: "What do you offer",
  pricing: "Pricing",
  faq: "FAQ",
  booking: "Booking",
  escalation: "Asking for a person",
  acknowledgement: "Acknowledgement",
  out_of_scope: "Nothing on file"
};

/** What callers asked about, by the intent Veyra recorded at the time. */
export async function topIntents(businessId: string, range: PilotRange, limit = 8): Promise<PilotIntentCount[]> {
  const grouped = await prisma.message.groupBy({
    by: ["intent"],
    where: {
      sender: "receptionist",
      intent: { not: null },
      createdAt: rangeWindow(range),
      conversation: { businessId }
    },
    _count: { intent: true }
  });

  return grouped
    .map((row) => ({
      intent: row.intent as string,
      label: INTENT_LABELS[row.intent as string] ?? (row.intent as string),
      count: row._count.intent
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export function outcomeBreakdown(raw: RawCounts): { outcome: ConversationOutcome; label: string; count: number }[] {
  return (Object.entries(raw.outcomes) as [ConversationOutcome, number][])
    .filter(([, count]) => count > 0)
    .map(([outcome, count]) => ({ outcome, label: CONVERSATION_OUTCOME_LABELS[outcome], count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Messaging counts, split by channel.
 *
 * "Delivered" is only ever a provider receipt. A message Veyra sent and heard
 * nothing further about stays counted as sent, because the alternative —
 * assuming it arrived — is the one number a pilot report must never invent.
 */
function messagingCounts(
  notifications: { status: string; channel: string; deliveryStatus: string | null }[]
): {
  smsMessagesSent: number;
  smsMessagesDelivered: number;
  smsFailures: number;
  whatsappMessagesSent: number;
  whatsappMessagesDelivered: number;
  whatsappFailures: number;
} {
  const forChannel = (channel: "sms" | "whatsapp") => {
    const rows = notifications.filter((n) => n.channel === channel);
    return {
      sent: rows.filter((n) => n.status === "sent").length,
      delivered: rows.filter((n) => n.deliveryStatus === "delivered").length,
      failed: rows.filter(
        (n) => n.status === "failed" || n.deliveryStatus === "failed" || n.deliveryStatus === "undelivered"
      ).length
    };
  };

  const sms = forChannel("sms");
  const whatsapp = forChannel("whatsapp");
  return {
    smsMessagesSent: sms.sent,
    smsMessagesDelivered: sms.delivered,
    smsFailures: sms.failed,
    whatsappMessagesSent: whatsapp.sent,
    whatsappMessagesDelivered: whatsapp.delivered,
    whatsappFailures: whatsapp.failed
  };
}
