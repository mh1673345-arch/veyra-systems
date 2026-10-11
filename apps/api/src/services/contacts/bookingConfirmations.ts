import type { DomainEventType } from "@veyra/shared";
import { prisma } from "../../db/client.js";
import { queueCustomerMessage } from "../messaging/outbound.js";
import { resolveConfirmationDestinations } from "./destinations.js";
import { confirmationCopy, TEMPLATE_KEYS, type BookingTransition } from "./confirmationCopy.js";
import { recordConfigChange } from "../setup/audit.js";

/**
 * Turning a booking transition into a message to the customer.
 *
 * Driven by domain events, never by a route or a button. The three events
 * this reacts to are emitted by the booking lifecycle only after the write —
 * and, for a calendar booking, the provider call — has already succeeded, so
 * a "rescheduled" message cannot be sent for a reschedule that failed. That
 * guarantee lives in the lifecycle; this file inherits it by refusing to look
 * anywhere else for its trigger.
 *
 * Three things it will not do:
 *   - send for a booking request. A request is not a confirmation, and a
 *     Starter customer told "your appointment is confirmed" when a human has
 *     not yet looked at it is a broken promise;
 *   - send twice for one transition. A duplicate domain event carries a new
 *     event id, so the Notification indexes cannot see it — BookingConfirmation
 *     is keyed on the booking and the transition instead;
 *   - fan out. One transition produces one message, unless the business has
 *     explicitly asked for a fallback.
 */

const TRANSITIONS: Record<string, BookingTransition> = {
  "booking.confirmed": "confirmed",
  "booking.rescheduled": "rescheduled",
  "booking.cancelled": "cancelled"
};

export function bookingTransitionFor(type: DomainEventType): BookingTransition | null {
  return TRANSITIONS[type] ?? null;
}

/** Which business setting governs each transition. */
function settingFor(
  transition: BookingTransition,
  settings: {
    bookingConfirmationEnabled: boolean;
    bookingRescheduleNotificationEnabled: boolean;
    bookingCancellationNotificationEnabled: boolean;
  }
): boolean {
  return transition === "confirmed"
    ? settings.bookingConfirmationEnabled
    : transition === "rescheduled"
      ? settings.bookingRescheduleNotificationEnabled
      : settings.bookingCancellationNotificationEnabled;
}

export type ConfirmationResult =
  | { outcome: "queued"; channel: string; notificationId: string }
  | { outcome: "duplicate"; channel: string }
  | { outcome: "blocked"; reason: string }
  | { outcome: "no_destination"; reason: string }
  | { outcome: "not_required"; reason: string };

/**
 * Called for every booking.confirmed / rescheduled / cancelled event.
 *
 * Never throws: a confirmation is downstream of a commitment the business has
 * already made, and failing to tell someone must not unmake it.
 */
export async function confirmBookingTransition(params: {
  businessId: string;
  eventId: string;
  type: DomainEventType;
  appointmentId: string;
  /** Reschedules: the previous time, as the lifecycle already formatted it. */
  previousLabel?: string | null;
}): Promise<ConfirmationResult> {
  const transition = bookingTransitionFor(params.type);
  if (!transition) return { outcome: "not_required", reason: "Not a booking transition." };

  const [appointment, settings, business] = await Promise.all([
    prisma.appointment.findFirst({
      where: { id: params.appointmentId, businessId: params.businessId },
      include: { conversation: { select: { id: true } } }
    }),
    prisma.messagingSettings.findUnique({ where: { businessId: params.businessId } }),
    prisma.business.findUnique({
      where: { id: params.businessId },
      select: { name: true, timezone: true, contactPhone: true }
    })
  ]);

  if (!appointment || !business) {
    return { outcome: "not_required", reason: "The booking no longer exists." };
  }

  // A request that a human has not confirmed is not a confirmed appointment,
  // whatever event reached us.
  if (appointment.mode !== "calendar" && transition === "confirmed") {
    return {
      outcome: "not_required",
      reason: "This is a booking request, not a confirmed appointment."
    };
  }

  if (!settings || !settings.customerMessagingEnabled || !settingFor(transition, settings)) {
    return {
      outcome: "not_required",
      reason: `${transition} notifications are switched off for this business.`
    };
  }

  // A reschedule can happen more than once, so the new time is what tells two
  // legitimate confirmations apart. The others happen once per booking.
  const transitionKey =
    transition === "rescheduled" ? (appointment.startTime?.toISOString() ?? "") : "";

  const { available, blocked, preferred } = await resolveConfirmationDestinations({
    businessId: params.businessId,
    conversationId: appointment.conversationId
  });

  // Without an explicit fallback setting, only the preferred channel may be
  // used. Quietly reaching for a different one is how a customer who chose
  // WhatsApp gets a text instead, and how two channels end up both sending.
  const usable = settings.transactionalFallbackEnabled
    ? available
    : available.filter((destination) => destination.channel === preferred);

  if (usable.length === 0) {
    const reason =
      blocked.length > 0
        ? blocked.map((entry) => `${entry.channel}: ${entry.reason}`).join(" ")
        : available.length > 0
          ? `The preferred channel (${preferred}) is not available, and fallback to another channel is switched off.`
          : "This customer has no contact details on file.";
    await recordAttempt({
      businessId: params.businessId,
      appointmentId: appointment.id,
      transition,
      transitionKey,
      channel: "none",
      outcome: blocked.length > 0 || available.length > 0 ? "blocked" : "no_destination",
      reason
    });
    await audit(params.businessId, appointment.id, "confirmation_blocked");
    return blocked.length > 0 || available.length > 0
      ? { outcome: "blocked", reason }
      : { outcome: "no_destination", reason };
  }

  // One destination, never a fan-out.
  const destination = usable[0];

  const copy = confirmationCopy(transition, {
    businessName: business.name,
    serviceName: appointment.serviceName,
    timezone: appointment.timezone ?? business.timezone,
    start: appointment.startTime,
    previousLabel: transition === "rescheduled" ? params.previousLabel ?? null : null,
    contactPhone: business.contactPhone
  });

  // Claim the transition before sending. If this row already exists the event
  // is a repeat, and nothing further happens.
  const claim = await claimTransition({
    businessId: params.businessId,
    appointmentId: appointment.id,
    transition,
    transitionKey,
    channel: destination.channel,
    recipientMasked: destination.to
  });
  if (!claim.claimed) return { outcome: "duplicate", channel: destination.channel };

  try {
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: appointment.conversationId },
      include: { customerContact: true }
    });

    let notificationId: string;
    if (destination.channel === "email") {
      notificationId = await queueCustomerEmail({
        businessId: params.businessId,
        email: conversation.customerContact!.email!,
        subject: copy.subject,
        body: copy.body,
        appointmentId: appointment.id
      });
    } else {
      const phone = conversation.customerContact?.phoneE164 ?? conversation.customerRef!;
      const queued = await queueCustomerMessage({
        businessId: params.businessId,
        channel: destination.channel,
        type: params.type,
        toPhone: phone,
        // The template key travels as the subject; the messaging layer maps
        // it to a provider template if the WhatsApp window has closed.
        subject: TEMPLATE_KEYS[transition],
        body: copy.body,
        linkEntity: "booking",
        linkEntityId: appointment.id,
        eventId: params.eventId
      });
      notificationId = queued.notificationId;
    }

    await prisma.bookingConfirmation.update({
      where: { id: claim.id },
      data: { outcome: "queued", notificationId }
    });
    await audit(params.businessId, appointment.id, "confirmation_queued");
    return { outcome: "queued", channel: destination.channel, notificationId };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "The confirmation could not be queued.";
    await prisma.bookingConfirmation.update({
      where: { id: claim.id },
      data: { outcome: "blocked", reason }
    });
    await audit(params.businessId, appointment.id, "confirmation_blocked");
    return { outcome: "blocked", reason };
  }
}

async function claimTransition(params: {
  businessId: string;
  appointmentId: string;
  transition: BookingTransition;
  transitionKey: string;
  channel: string;
  recipientMasked: string;
}): Promise<{ claimed: boolean; id: string }> {
  try {
    const row = await prisma.bookingConfirmation.create({
      data: {
        businessId: params.businessId,
        appointmentId: params.appointmentId,
        transition: params.transition,
        transitionKey: params.transitionKey,
        channel: params.channel,
        recipient: params.recipientMasked,
        outcome: "queued"
      }
    });
    return { claimed: true, id: row.id };
  } catch (error) {
    if (isUniqueConstraintError(error)) return { claimed: false, id: "" };
    throw error;
  }
}

/** Records an outcome that never got as far as claiming a send. */
async function recordAttempt(params: {
  businessId: string;
  appointmentId: string;
  transition: BookingTransition;
  transitionKey: string;
  channel: string;
  outcome: string;
  reason: string;
}): Promise<void> {
  await prisma.bookingConfirmation
    .upsert({
      where: {
        appointmentId_transition_transitionKey_channel: {
          appointmentId: params.appointmentId,
          transition: params.transition,
          transitionKey: params.transitionKey,
          channel: params.channel
        }
      },
      create: {
        businessId: params.businessId,
        appointmentId: params.appointmentId,
        transition: params.transition,
        transitionKey: params.transitionKey,
        channel: params.channel,
        outcome: params.outcome,
        reason: params.reason
      },
      update: { outcome: params.outcome, reason: params.reason }
    })
    .catch(() => undefined);
}

/**
 * Audited at the decision points an operator would ask about, and nowhere
 * else. Retry ticks are the worker's business and would drown the trail.
 */
async function audit(
  businessId: string,
  appointmentId: string,
  change: "confirmation_queued" | "confirmation_blocked" | "confirmation_failed_permanently"
): Promise<void> {
  await recordConfigChange({
    businessId,
    actorUserId: null,
    entityType: "booking_confirmation",
    entityId: appointmentId,
    changeType: "updated",
    changedFields: [change]
  }).catch(() => undefined);
}

async function queueCustomerEmail(params: {
  businessId: string;
  email: string;
  subject: string;
  body: string;
  appointmentId: string;
}): Promise<string> {
  const notification = await prisma.$transaction(async (tx) => {
    const event = await tx.domainEvent.create({
      data: {
        businessId: params.businessId,
        type: "messaging.customer_notified",
        entityType: "system",
        entityId: params.appointmentId,
        payload: JSON.stringify({}),
        processedAt: new Date()
      }
    });
    return tx.notification.create({
      data: {
        businessId: params.businessId,
        userId: null,
        recipientEmail: params.email,
        eventId: event.id,
        channel: "email",
        subject: params.subject,
        body: params.body,
        linkEntity: "booking",
        linkEntityId: params.appointmentId,
        nextAttemptAt: new Date()
      }
    });
  });
  return notification.id;
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "P2002"
  );
}
