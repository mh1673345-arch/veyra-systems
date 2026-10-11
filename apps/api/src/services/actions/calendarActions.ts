import type { ActionResult, AssistantAction, BusinessCapabilities } from "@veyra/shared";
import { prisma } from "../../db/client.js";
import {
  cancelCalendarBooking,
  confirmHeldBooking,
  holdSlot,
  pendingHold,
  rescheduleCalendarBooking
} from "../calendar/bookings.js";
import { isAffirmation, isCancellationRequest, isRescheduleRequest, parseRequestedTime } from "../calendar/requestedTime.js";
import { releaseExpiredHolds } from "../calendar/holds.js";
import { formatLocal } from "../calendar/rules.js";
import { type AvailabilityResult, calendarStatus, checkAvailability } from "../calendar/service.js";

/**
 * Calendar actions, executed by the application — never by the model.
 *
 * The AI (or the rule engine) can only ask for one of these. Everything that
 * decides an outcome happens here: the requested time is parsed from the
 * caller's own words, capability and connection are re-validated, and
 * CalendarService performs every provider call. The caller-facing sentence for
 * anything factual is generated here too, so Veyra can never claim an
 * availability or a confirmation the calendar did not actually give.
 */

export interface CalendarActionParams {
  action: AssistantAction;
  conversationId: string;
  businessId: string;
  capabilities: BusinessCapabilities;
  callerText: string;
  now?: Date;
}

/** Actions that may only run with capability + healthy connection. */
export function isCalendarAction(action: string): boolean {
  return (
    action === "check_calendar_availability" ||
    action === "confirm_calendar_booking" ||
    action === "cancel_calendar_booking" ||
    action === "reschedule_calendar_booking"
  );
}

/**
 * Decides which calendar action a turn really is, from the caller's words and
 * the conversation's own state — not from model output. Returns the action
 * unchanged when calendar booking isn't live, so a Starter business keeps the
 * request-only flow exactly as before.
 */
export async function resolveCalendarAction(params: {
  requestedAction: string;
  callerText: string;
  conversationId: string;
  businessId: string;
  capabilities: BusinessCapabilities;
  now?: Date;
}): Promise<string> {
  if (!params.capabilities.calendar_booking) return params.requestedAction;

  const status = await calendarStatus(params.businessId);
  if (!status.live) return params.requestedAction;

  const now = params.now ?? new Date();
  // Holds whose window has passed are released before anything reads them, so
  // a dead hold can never be confirmed, cancelled or counted.
  await releaseExpiredHolds({ businessId: params.businessId, now });
  const hold = await pendingHold(params.conversationId, now);

  // A plain "yes" only means anything when a slot is actually being held.
  if (hold && isAffirmation(params.callerText)) return "confirm_calendar_booking";

  // A live reschedule proposal plus an explicit "yes" is the only thing that
  // moves a booking. Checked before cancellation so "yes" is never ambiguous.
  const proposal = await pendingRescheduleProposal(params.conversationId, now);
  if (proposal && isAffirmation(params.callerText)) return "reschedule_calendar_booking";

  if (isRescheduleRequest(params.callerText)) {
    const reschedulable = await prisma.appointment.findFirst({
      where: { conversationId: params.conversationId, mode: "calendar", status: "confirmed" }
    });
    if (reschedulable) return "reschedule_calendar_booking";
  }

  if (isCancellationRequest(params.callerText)) {
    const cancellable = await prisma.appointment.findFirst({
      where: {
        conversationId: params.conversationId,
        mode: "calendar",
        status: { in: ["confirmed", "awaiting_confirmation"] }
      }
    });
    if (cancellable) return "cancel_calendar_booking";
  }

  // A booking turn with a time in it becomes an availability check.
  const looksLikeBooking =
    params.requestedAction === "show_booking_form" ||
    params.requestedAction === "check_calendar_availability";
  if (looksLikeBooking && parseRequestedTime(params.callerText, status.timezone, now)) {
    return "check_calendar_availability";
  }

  return params.requestedAction;
}

/** The booking in this conversation with a live, unexpired reschedule proposal. */
export async function pendingRescheduleProposal(conversationId: string, now = new Date()) {
  return prisma.appointment.findFirst({
    where: {
      conversationId,
      mode: "calendar",
      status: "confirmed",
      rescheduleProposedStart: { not: null },
      rescheduleProposalExpires: { gt: now }
    },
    orderBy: { updatedAt: "desc" }
  });
}

/** How long a proposed new time stays open for the caller to accept. */
const PROPOSAL_MINUTES = 15;

/**
 * Pilot safety controls, per action. These sit BELOW entitlements: the plan
 * has already been checked by the time this runs, and a control being on can
 * never grant anything — it can only withhold.
 */
const ACTION_SAFETY = {
  confirm_calendar_booking: "allowAutoBooking",
  cancel_calendar_booking: "allowAutoCancellation",
  reschedule_calendar_booking: "allowAutoReschedule"
} as const;

const ACTION_ENTITLEMENTS = {
  check_calendar_availability: "calendar_availability",
  confirm_calendar_booking: "calendar_booking",
  cancel_calendar_booking: "calendar_cancellation",
  reschedule_calendar_booking: "calendar_reschedule"
} as const;

function unsupported(action: AssistantAction, message: string): ActionResult {
  return { action, status: "unsupported", message };
}

/** Availability answers, rendered for the caller in the business timezone. */
function describeAvailability(result: AvailabilityResult, requestedText: string): string {
  const alternatives = result.alternatives
    .map((slot) => formatLocal(slot.start, result.timezone))
    .slice(0, 3);
  const offer =
    alternatives.length > 0
      ? ` The nearest times I can offer are ${alternatives.join(", ")}. Would any of those work?`
      : " I can pass this to the team to arrange instead.";

  switch (result.status) {
    case "unavailable":
      return `${requestedText} is already taken.${offer}`;
    case "outside_business_hours":
      return `We're not open then.${offer}`;
    case "too_soon":
      return `That's sooner than we can take a booking.${offer}`;
    case "too_far":
      return "That's further ahead than the calendar is open for. I can pass this to the team to arrange instead.";
    case "calendar_unavailable":
      return "I'm having trouble checking live availability right now. I can still submit a request for the team to review.";
    default:
      return "I can't confirm that time automatically. I can submit a request for the team to review.";
  }
}

export async function executeCalendarAction(params: CalendarActionParams): Promise<ActionResult> {
  const { action, businessId, conversationId, callerText, capabilities } = params;
  const now = params.now ?? new Date();

  // Capability first: what the business has bought decides what may be offered.
  if (!capabilities.calendar_booking) {
    return unsupported(action, "This business is not configured for calendar booking.");
  }

  const status = await calendarStatus(businessId);

  // Each action has its own paid boundary. A refusal is "unsupported" with an
  // operator-facing reason only — no callerMessage — so the route falls back to
  // the ordinary request-only reply and the caller never hears about plans.
  const required = ACTION_ENTITLEMENTS[action as keyof typeof ACTION_ENTITLEMENTS];
  if (required && !status.entitlements[required]) {
    return unsupported(action, `ENTITLEMENT_REQUIRED: ${required} is not included in this subscription.`);
  }

  // Pilot safety brake. Switched off means Veyra stops doing it automatically
  // and falls back to the ordinary request-only reply — the caller is never
  // told why, and no plan feature is granted by any of this.
  const safetyKey = ACTION_SAFETY[action as keyof typeof ACTION_SAFETY];
  if (safetyKey) {
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { allowAutoBooking: true, allowAutoCancellation: true, allowAutoReschedule: true }
    });
    if (business && business[safetyKey] === false) {
      return unsupported(action, `PILOT_SAFETY: ${safetyKey} is switched off for this business.`);
    }
  }

  if (!status.live) {
    // Enabled but not wired up (or needs re-auth): stay request-only rather
    // than pretending to hold a slot.
    return unsupported(
      action,
      status.connection
        ? `Calendar connection is ${status.connection.status}.`
        : "No calendar is connected for this business."
    );
  }

  switch (action) {
    case "check_calendar_availability":
      return checkAction({ businessId, conversationId, callerText, timezone: status.timezone, now });
    case "confirm_calendar_booking":
      return confirmAction({ conversationId, now });
    case "cancel_calendar_booking":
      return cancelAction({ conversationId });
    case "reschedule_calendar_booking":
      return rescheduleAction({ businessId, conversationId, callerText, timezone: status.timezone, now });
    default:
      return { action: "none", status: "failed", message: `Unhandled calendar action "${action}".` };
  }
}

async function checkAction(params: {
  businessId: string;
  conversationId: string;
  callerText: string;
  timezone: string;
  now: Date;
}): Promise<ActionResult> {
  const action: AssistantAction = "check_calendar_availability";
  const parsed = parseRequestedTime(params.callerText, params.timezone, params.now);
  if (!parsed) {
    return {
      action,
      status: "ready",
      message: "No bookable time could be parsed from the caller's message.",
      callerMessage: "What day and time would suit you? I can check what's free.",
      metadata: { availability: "no_time_parsed" }
    };
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: params.conversationId },
    select: { callerName: true }
  });
  const resolved = await resolveServiceForBooking(params.businessId, params.callerText);
  if (!resolved.service) {
    // Never guess a duration: either the caller names the service, or the
    // business has exactly one bookable one, or we ask.
    return {
      action,
      status: "ready",
      message: resolved.reason,
      callerMessage:
        resolved.options.length > 0
          ? `Which would that be for — ${formatList(resolved.options)}?`
          : "I can't book that automatically. I can pass it to the team to arrange.",
      metadata: { availability: "service_unknown" }
    };
  }
  const service = resolved.service;

  const availability = await checkAvailability({
    businessId: params.businessId,
    serviceId: service?.id ?? null,
    serviceName: service?.name ?? null,
    startTime: parsed.start,
    now: params.now
  });

  if (availability.status !== "available") {
    return {
      action,
      status: availability.status === "calendar_unavailable" ? "failed" : "ready",
      message: availability.detail ?? `Availability check returned ${availability.status}.`,
      callerMessage: describeAvailability(availability, formatLocal(parsed.start, params.timezone)),
      metadata: {
        availability: availability.status,
        requested: parsed.start.toISOString(),
        alternatives: availability.alternatives.map((slot) => slot.start.toISOString()).join(",")
      }
    };
  }

  // Free — hold it and ask. Nothing is in the calendar yet.
  const held = await holdSlot({
    businessId: params.businessId,
    conversationId: params.conversationId,
    serviceId: service?.id ?? null,
    serviceName: service?.name ?? null,
    start: availability.slot!.start,
    end: availability.slot!.end,
    timezone: availability.timezone,
    requestedTimeText: formatLocal(availability.slot!.start, availability.timezone),
    notes: conversation?.callerName ? `Requested by ${conversation.callerName}` : null,
    now: params.now
  });

  const when = formatLocal(availability.slot!.start, availability.timezone);
  return {
    action,
    status: "pending",
    message: `Slot held (${held.appointment.id}); awaiting caller confirmation.`,
    callerMessage: `${when} is available${
      service ? ` for ${service.name.toLowerCase()}` : ""
    }. Would you like me to confirm it?`,
    metadata: {
      availability: "available",
      bookingId: held.appointment.id,
      start: availability.slot!.start.toISOString(),
      timezone: availability.timezone
    }
  };
}

async function confirmAction(params: { conversationId: string; now: Date }): Promise<ActionResult> {
  const action: AssistantAction = "confirm_calendar_booking";
  const hold = await pendingHold(params.conversationId, params.now);
  if (!hold) {
    return {
      action,
      status: "ready",
      message: "No slot is currently held for this conversation.",
      callerMessage: "I don't have a time held right now. What day and time would suit you?",
      metadata: { confirmation: "no_hold" }
    };
  }

  const outcome = await confirmHeldBooking({ appointmentId: hold.id, now: params.now });

  switch (outcome.status) {
    case "confirmed": {
      const when = formatLocal(outcome.appointment.startTime!, outcome.appointment.timezone ?? "UTC");
      return {
        action,
        // "completed" only because the event really exists in the calendar.
        status: "completed",
        message: outcome.alreadyConfirmed
          ? "Booking was already confirmed; no second event was created."
          : `Calendar event ${outcome.appointment.externalEventId} created.`,
        callerMessage: `Done — you're booked for ${when}. You'll get a reminder from us if anything changes.`,
        metadata: {
          bookingId: outcome.appointment.id,
          eventId: outcome.appointment.externalEventId ?? "",
          alreadyConfirmed: String(outcome.alreadyConfirmed)
        }
      };
    }
    case "slot_taken": {
      const alternatives = outcome.availability.alternatives
        .map((slot) => formatLocal(slot.start, outcome.availability.timezone))
        .slice(0, 3);
      return {
        action,
        status: "ready",
        message: "The held slot was taken before the caller confirmed.",
        callerMessage:
          alternatives.length > 0
            ? `Sorry — that time was taken just now. I can offer ${alternatives.join(", ")}. Would any of those work?`
            : "Sorry — that time was taken just now. I can pass this to the team to arrange instead.",
        metadata: { confirmation: "slot_taken" }
      };
    }
    case "calendar_unavailable":
      return {
        action,
        status: "failed",
        message: outcome.detail,
        callerMessage:
          "I'm having trouble reaching the calendar right now, so I haven't booked anything. I can pass this to the team to confirm.",
        metadata: { confirmation: "calendar_unavailable" }
      };
    case "expired":
      return {
        action,
        status: "ready",
        message: "The held slot expired before the caller confirmed.",
        callerMessage: "That hold has expired. Shall I check that time again for you?",
        metadata: { confirmation: "expired" }
      };
    default:
      return {
        action,
        status: "failed",
        message: "No confirmable booking was found.",
        callerMessage: "I couldn't find a booking to confirm. What day and time would suit you?"
      };
  }
}

async function cancelAction(params: { conversationId: string }): Promise<ActionResult> {
  const action: AssistantAction = "cancel_calendar_booking";
  const booking = await prisma.appointment.findFirst({
    where: {
      conversationId: params.conversationId,
      mode: "calendar",
      status: { in: ["confirmed", "awaiting_confirmation"] }
    },
    orderBy: { createdAt: "desc" }
  });
  if (!booking) {
    return {
      action,
      status: "ready",
      message: "No calendar booking to cancel in this conversation.",
      callerMessage: "I can't see a booking on this conversation to cancel. Would you like me to check with the team?"
    };
  }

  const outcome = await cancelCalendarBooking({ appointmentId: booking.id, reason: "Cancelled by caller" });
  if (outcome.status === "cancelled") {
    return {
      action,
      status: "completed",
      message: `Booking ${booking.id} cancelled.`,
      callerMessage: "That's cancelled for you. Anything else I can help with?",
      metadata: { bookingId: booking.id }
    };
  }
  return {
    action,
    status: "failed",
    message: outcome.status === "provider_failed" ? outcome.detail : "Booking is not cancellable.",
    // Never tells the caller it is cancelled when the event may still exist.
    callerMessage:
      "I couldn't cancel that automatically just now, so I've left it in place and flagged it for the team.",
    metadata: { bookingId: booking.id }
  };
}

/**
 * Moving an existing booking, in two steps.
 *
 * Step 1 — the caller asks to move it and names a time. Veyra checks the new
 * slot, records it as a *proposal* and asks for a yes. Nothing has changed at
 * this point: the original booking still stands, and if the caller says
 * nothing more, it stays exactly where it was.
 *
 * Step 2 — the caller says yes while that proposal is still open. Only then is
 * the booking actually moved.
 *
 * Mentioning a date is never enough. That matters: a caller musing "Wednesday
 * would have been easier" must not silently lose the appointment they have.
 */
async function rescheduleAction(params: {
  businessId: string;
  conversationId: string;
  callerText: string;
  timezone: string;
  now: Date;
}): Promise<ActionResult> {
  const action: AssistantAction = "reschedule_calendar_booking";
  const booking = await prisma.appointment.findFirst({
    where: { conversationId: params.conversationId, mode: "calendar", status: "confirmed" },
    orderBy: { createdAt: "desc" }
  });
  if (!booking) {
    return {
      action,
      status: "ready",
      message: "No confirmed calendar booking to reschedule.",
      callerMessage: "I can't see a confirmed booking to move. What day and time would suit you?"
    };
  }

  const hasLiveProposal =
    booking.rescheduleProposedStart !== null &&
    booking.rescheduleProposalExpires !== null &&
    booking.rescheduleProposalExpires > params.now;

  /* ---------------- Step 2: the caller accepted the proposal ---------------- */
  if (hasLiveProposal && isAffirmation(params.callerText)) {
    const proposedStart = booking.rescheduleProposedStart!;
    // Cleared first, so a duplicate "yes" cannot move the booking twice: the
    // second one finds no live proposal and is answered as a no-op.
    await prisma.appointment.updateMany({
      where: { id: booking.id, rescheduleProposedStart: proposedStart },
      data: { rescheduleProposedStart: null, rescheduleProposedEnd: null, rescheduleProposalExpires: null }
    });

    const outcome = await rescheduleCalendarBooking({
      appointmentId: booking.id,
      newStart: proposedStart,
      now: params.now
    });

    switch (outcome.status) {
      case "rescheduled":
        return {
          action,
          status: "completed",
          message: `Booking ${booking.id} moved.`,
          callerMessage: `Done — your appointment is now ${formatLocal(
            outcome.appointment.startTime!,
            outcome.appointment.timezone ?? params.timezone
          )}.`,
          metadata: { bookingId: booking.id }
        };
      case "unavailable": {
        // Someone took the slot between the offer and the yes. The original
        // booking is untouched, and the caller is told exactly that.
        const alternatives = outcome.availability.alternatives
          .map((slot) => formatLocal(slot.start, outcome.availability.timezone))
          .slice(0, 3);
        return {
          action,
          status: "ready",
          message: `Proposed slot was taken before confirmation: ${outcome.availability.status}.`,
          callerMessage:
            alternatives.length > 0
              ? `Sorry — that time was taken just now, so I've left your existing booking as it is. I could move it to ${alternatives.join(", ")}.`
              : "Sorry — that time was taken just now, so I've left your existing booking as it is. I can ask the team to help.",
          metadata: { bookingId: booking.id }
        };
      }
      default:
        return {
          action,
          status: "failed",
          message: outcome.status === "calendar_unavailable" ? outcome.detail : "Booking is not reschedulable.",
          callerMessage:
            "I couldn't reach the calendar to move that, so your existing booking still stands. I'll flag it for the team.",
          metadata: { bookingId: booking.id }
        };
    }
  }

  /* ---------------- Step 1: check a new time and offer it ---------------- */
  const parsed = parseRequestedTime(params.callerText, params.timezone, params.now);
  if (!parsed) {
    return {
      action,
      status: "ready",
      message: "No new time could be parsed.",
      callerMessage: hasLiveProposal
        ? `Just to confirm — would you like me to move your appointment to ${formatLocal(
            booking.rescheduleProposedStart!,
            booking.timezone ?? params.timezone
          )}?`
        : "What day and time would you like to move it to?",
      metadata: { bookingId: booking.id }
    };
  }

  const availability = await checkAvailability({
    businessId: params.businessId,
    serviceId: booking.serviceId,
    serviceName: booking.serviceName,
    startTime: parsed.start,
    now: params.now
  });

  if (availability.status !== "available") {
    return {
      action,
      status: "ready",
      message: `Proposed new slot rejected: ${availability.status}.`,
      // Nothing was changed, and the caller hears that before anything else.
      callerMessage: `Your existing booking is still in place. ${describeAvailability(availability, "That time")}`,
      metadata: { bookingId: booking.id }
    };
  }

  const slot = availability.slot!;
  await prisma.appointment.update({
    where: { id: booking.id },
    data: {
      rescheduleProposedStart: slot.start,
      rescheduleProposedEnd: slot.end,
      rescheduleProposalExpires: new Date(params.now.getTime() + PROPOSAL_MINUTES * 60_000)
    }
  });

  return {
    action,
    status: "ready",
    message: `Proposed moving booking ${booking.id}; awaiting caller confirmation.`,
    callerMessage: `${formatLocal(slot.start, availability.timezone)} is available. Would you like me to move your appointment to then?`,
    metadata: { bookingId: booking.id, proposedStart: slot.start.toISOString() }
  };
}

/**
 * Which service the caller means. Only services with a configured duration can
 * be booked live; when the caller names none and the business has exactly one
 * such service, that is unambiguous, so it is used. Otherwise the options are
 * handed back so the caller can be asked, because a duration is never invented.
 */
async function resolveServiceForBooking(
  businessId: string,
  callerText: string
): Promise<{ service: { id: string; name: string } | null; options: string[]; reason: string }> {
  // Archived or non-bookable services are never booked live.
  const services = await prisma.service.findMany({ where: { businessId, active: true, bookable: true } });
  const text = callerText.toLowerCase();

  const named =
    services.find((service) => text.includes(service.name.toLowerCase())) ??
    // A single distinctive word ("whitening", "cleaning") is enough.
    services.find((service) =>
      service.name
        .toLowerCase()
        .split(/s+/)
        .some((word) => word.length > 4 && text.includes(word))
    );

  if (named) {
    return named.durationMinutes
      ? { service: named, options: [], reason: "" }
      : {
          service: null,
          options: [],
          reason: `Service "${named.name}" has no configured duration, so it cannot be booked live.`
        };
  }

  const bookable = services.filter((service) => service.durationMinutes !== null);
  if (bookable.length === 1) return { service: bookable[0], options: [], reason: "" };

  return {
    service: null,
    options: bookable.map((service) => service.name),
    reason: "The caller named no service and the business has more than one bookable service."
  };
}

function formatList(items: string[]): string {
  const lower = items.map((item) => item.toLowerCase());
  if (lower.length <= 1) return lower.join("");
  return `${lower.slice(0, -1).join(", ")} or ${lower.at(-1)}`;
}
