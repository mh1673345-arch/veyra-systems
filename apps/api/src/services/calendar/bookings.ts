import type { Appointment } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { emitDomainEvent } from "../notifications/events.js";
import { scheduleProcessing } from "../notifications/processor.js";
import { formatLocal } from "./rules.js";
import {
  type AvailabilityResult,
  cancelCalendarEvent,
  checkAvailability,
  createCalendarEvent,
  findEventByBookingKey,
  newBookingKey,
  updateCalendarEvent
} from "./service.js";
import { CalendarProviderError } from "./types.js";
import { hasEntitlement } from "../access/accessService.js";

/**
 * Calendar-backed booking lifecycle, on the existing Appointment model.
 *
 * Two-step by design: an availability check never creates an event, and never
 * even creates a booking row. When a slot is free it is *held*
 * (status `awaiting_confirmation`) and the caller is asked to confirm; only an
 * explicit yes creates the calendar event. "Book me Tuesday at 3" alone can
 * never put an appointment in a real calendar.
 */

/** How long a held slot waits for the caller before it lapses. */
const HOLD_MINUTES = 30;

export interface HeldBooking {
  appointment: Appointment;
  timezone: string;
}

export async function holdSlot(params: {
  businessId: string;
  conversationId: string;
  serviceId: string | null;
  serviceName: string | null;
  start: Date;
  end: Date;
  timezone: string;
  requestedTimeText: string;
  notes?: string | null;
  /** Injected so the hold's expiry uses the same clock as the availability check. */
  now?: Date;
}): Promise<HeldBooking> {
  const now = params.now ?? new Date();
  // One live hold per conversation: a caller changing their mind replaces the
  // previous hold rather than accumulating phantom appointments.
  await prisma.appointment.updateMany({
    where: { conversationId: params.conversationId, status: "awaiting_confirmation", mode: "calendar" },
    data: { status: "cancelled", cancelledAt: now, resolvedAt: now }
  });

  const appointment = await prisma.appointment.create({
    data: {
      conversationId: params.conversationId,
      businessId: params.businessId,
      mode: "calendar",
      status: "awaiting_confirmation",
      requestedTime: params.requestedTimeText,
      serviceId: params.serviceId,
      serviceName: params.serviceName,
      notes: params.notes ?? null,
      startTime: params.start,
      endTime: params.end,
      timezone: params.timezone,
      durationMinutes: Math.round((params.end.getTime() - params.start.getTime()) / 60_000),
      // Allocated now so every later create attempt for this booking carries
      // the same provider event id.
      bookingKey: newBookingKey(),
      confirmationExpiresAt: new Date(now.getTime() + HOLD_MINUTES * 60_000)
    }
  });

  await recordStatus(appointment, "", "awaiting_confirmation", "caller", "Slot held pending caller confirmation");
  return { appointment, timezone: params.timezone };
}

/** The hold this conversation is currently waiting on, if any. */
export async function pendingHold(conversationId: string, now = new Date()): Promise<Appointment | null> {
  return prisma.appointment.findFirst({
    where: {
      conversationId,
      mode: "calendar",
      status: "awaiting_confirmation",
      OR: [{ confirmationExpiresAt: null }, { confirmationExpiresAt: { gt: now } }]
    },
    orderBy: { createdAt: "desc" }
  });
}

export type ConfirmOutcome =
  | { status: "not_entitled" }
  | { status: "confirmed"; appointment: Appointment; alreadyConfirmed: boolean }
  | { status: "slot_taken"; availability: AvailabilityResult }
  | { status: "calendar_unavailable"; detail: string }
  | { status: "expired" }
  | { status: "not_found" };

/**
 * Turns a held slot into a real calendar event. Safe to call twice: a booking
 * that is already confirmed returns its existing event rather than creating a
 * second one, and the provider create is keyed by the booking key.
 */
export async function confirmHeldBooking(params: {
  appointmentId: string;
  actorUserId?: string | null;
  now?: Date;
}): Promise<ConfirmOutcome> {
  const now = params.now ?? new Date();
  const appointment = await prisma.appointment.findUnique({ where: { id: params.appointmentId } });
  if (!appointment || appointment.mode !== "calendar") return { status: "not_found" };

  // Idempotent: a duplicate "yes" must not book twice.
  if (appointment.status === "confirmed" && appointment.externalEventId) {
    return { status: "confirmed", appointment, alreadyConfirmed: true };
  }
  if (appointment.status !== "awaiting_confirmation") return { status: "not_found" };
  // A slot held before a downgrade cannot be booked after it.
  if (!(await hasEntitlement(appointment.businessId, "calendar_booking"))) {
    return { status: "not_entitled" };
  }
  if (appointment.confirmationExpiresAt && appointment.confirmationExpiresAt <= now) {
    return { status: "expired" };
  }
  if (!appointment.startTime || !appointment.endTime || !appointment.bookingKey) {
    return { status: "not_found" };
  }

  // Recovery first: a previous attempt may have created the event without
  // Veyra recording it (an ambiguous response, or a process that died in
  // between). That event is *ours*, so adopt it — checking availability first
  // would see our own event and wrongly conclude the slot was taken.
  let existing;
  try {
    existing = await findEventByBookingKey({
      businessId: appointment.businessId,
      bookingKey: appointment.bookingKey
    });
  } catch (err) {
    const detail = err instanceof CalendarProviderError ? err.message : "The calendar could not be reached.";
    return { status: "calendar_unavailable", detail };
  }

  if (existing && existing.status === "confirmed") {
    const adopted = await recordConfirmation({
      appointment,
      event: existing,
      calendarId: existing.calendarId,
      provider: appointment.calendarProvider ?? "unknown",
      now,
      actorUserId: params.actorUserId ?? null,
      note: "Adopted an event the provider had already created for this booking"
    });
    return { status: "confirmed", appointment: adopted, alreadyConfirmed: true };
  }

  // Re-check: the slot may have been taken since it was held.
  const availability = await checkAvailability({
    businessId: appointment.businessId,
    serviceId: appointment.serviceId,
    serviceName: appointment.serviceName,
    startTime: appointment.startTime,
    now
  });
  if (availability.status === "calendar_unavailable") {
    return { status: "calendar_unavailable", detail: availability.detail ?? "The calendar could not be reached." };
  }
  if (availability.status !== "available") {
    return { status: "slot_taken", availability };
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: appointment.conversationId },
    select: { callerName: true }
  });

  let created;
  try {
    created = await createCalendarEvent({
      businessId: appointment.businessId,
      bookingKey: appointment.bookingKey,
      summary: `${appointment.serviceName ?? "Appointment"} — ${conversation?.callerName ?? "Caller"}`,
      description: [
        "Booked by Veyra Reception.",
        appointment.notes ? `Notes: ${appointment.notes}` : null,
        `Veyra booking: ${appointment.id}`
      ]
        .filter(Boolean)
        .join("\n"),
      start: appointment.startTime,
      end: appointment.endTime
    });
  } catch (err) {
    const detail =
      err instanceof CalendarProviderError ? err.message : "The calendar could not be reached.";
    // The booking stays held; nothing is claimed as confirmed.
    return { status: "calendar_unavailable", detail };
  }

  const confirmed = await recordConfirmation({
    appointment,
    event: created.event,
    calendarId: created.calendarId,
    provider: created.provider,
    now,
    actorUserId: params.actorUserId ?? null,
    note: "Calendar event created"
  });

  return { status: "confirmed", appointment: confirmed, alreadyConfirmed: false };
}

export type CancelOutcome =
  | { status: "not_entitled" }
  | { status: "cancelled"; appointment: Appointment }
  | { status: "provider_failed"; detail: string }
  | { status: "not_cancellable" };

/**
 * Cancels through the application layer: the external event goes first, and
 * Veyra only records "cancelled" once the provider has actually cancelled it.
 * A provider failure leaves the booking confirmed and reports the failure —
 * telling a caller it is cancelled while the slot still exists would be worse
 * than an error.
 */
export async function cancelCalendarBooking(params: {
  appointmentId: string;
  actorUserId?: string | null;
  reason?: string;
  /**
   * Operator only. Lets a business that moved to a plan without
   * calendar_cancellation still cancel a confirmed booking Veyra created in
   * its calendar before the change, so no one is stuck with an orphaned
   * event. It is not a Starter entitlement: nothing new can be booked,
   * rescheduled or cancelled by callers, and the stored connection must
   * still be healthy.
   */
  allowLapsedPlanCleanup?: boolean;
}): Promise<CancelOutcome> {
  const appointment = await prisma.appointment.findUnique({ where: { id: params.appointmentId } });
  if (!appointment || appointment.mode !== "calendar") return { status: "not_cancellable" };
  if (!["awaiting_confirmation", "confirmed"].includes(appointment.status)) {
    return { status: "not_cancellable" };
  }
  let lapsedPlanCleanup = false;
  if (!(await hasEntitlement(appointment.businessId, "calendar_cancellation"))) {
    const grandfathered =
      params.allowLapsedPlanCleanup === true &&
      appointment.status === "confirmed" &&
      Boolean(appointment.externalEventId && appointment.externalCalendarId);
    if (!grandfathered) return { status: "not_entitled" };
    lapsedPlanCleanup = true;
  }

  if (appointment.externalEventId && appointment.externalCalendarId) {
    try {
      await cancelCalendarEvent({
        businessId: appointment.businessId,
        calendarId: appointment.externalCalendarId,
        eventId: appointment.externalEventId,
        lapsedPlanCleanup
      });
    } catch (err) {
      const detail = err instanceof CalendarProviderError ? err.message : "The calendar could not be reached.";
      return { status: "provider_failed", detail };
    }
  }

  const now = new Date();
  const cancelled = await prisma.appointment.update({
    where: { id: appointment.id },
    data: {
      status: "cancelled",
      cancelledAt: now,
      resolvedAt: now,
      externalEventStatus: appointment.externalEventId ? "cancelled" : null,
      calendarSyncedAt: appointment.externalEventId ? now : appointment.calendarSyncedAt,
      confirmationExpiresAt: null
    }
  });

  const reason = (params.reason ?? "Booking cancelled") + (lapsedPlanCleanup ? " (booked under a previous plan)" : "");
  await recordStatus(cancelled, appointment.status, "cancelled", params.actorUserId ? "operator" : "caller", reason, params.actorUserId);
  await emitDomainEvent({
    businessId: cancelled.businessId,
    type: "booking.cancelled",
    entityType: "booking",
    entityId: cancelled.id,
    payload: { service: cancelled.serviceName, when: cancelled.startTime ? formatLocal(cancelled.startTime, cancelled.timezone ?? "UTC") : null }
  });
  scheduleProcessing();

  return { status: "cancelled", appointment: cancelled };
}

export type RescheduleOutcome =
  | { status: "not_entitled" }
  | { status: "rescheduled"; appointment: Appointment }
  | { status: "unavailable"; availability: AvailabilityResult }
  | { status: "calendar_unavailable"; detail: string }
  | { status: "not_reschedulable" };

/**
 * Moves a confirmed booking. The new slot is verified free *before* anything is
 * changed, and the existing event is updated in place rather than deleted and
 * recreated — so a failure halfway can never leave the caller with no booking.
 */
export async function rescheduleCalendarBooking(params: {
  appointmentId: string;
  newStart: Date;
  actorUserId?: string | null;
  now?: Date;
}): Promise<RescheduleOutcome> {
  const now = params.now ?? new Date();
  const appointment = await prisma.appointment.findUnique({ where: { id: params.appointmentId } });
  if (!appointment || appointment.mode !== "calendar" || appointment.status !== "confirmed") {
    return { status: "not_reschedulable" };
  }
  if (!appointment.externalEventId || !appointment.externalCalendarId || !appointment.durationMinutes) {
    return { status: "not_reschedulable" };
  }
  if (!(await hasEntitlement(appointment.businessId, "calendar_reschedule"))) {
    return { status: "not_entitled" };
  }

  const availability = await checkAvailability({
    businessId: appointment.businessId,
    serviceId: appointment.serviceId,
    serviceName: appointment.serviceName,
    startTime: params.newStart,
    now
  });
  if (availability.status === "calendar_unavailable") {
    return { status: "calendar_unavailable", detail: availability.detail ?? "The calendar could not be reached." };
  }
  if (availability.status !== "available") {
    // The old booking is untouched.
    return { status: "unavailable", availability };
  }

  const newStart = availability.slot!.start;
  const newEnd = availability.slot!.end;

  try {
    await updateCalendarEvent({
      businessId: appointment.businessId,
      calendarId: appointment.externalCalendarId,
      eventId: appointment.externalEventId,
      start: newStart,
      end: newEnd
    });
  } catch (err) {
    const detail = err instanceof CalendarProviderError ? err.message : "The calendar could not be reached.";
    return { status: "calendar_unavailable", detail };
  }

  const previous = appointment.startTime;
  const updated = await prisma.appointment.update({
    where: { id: appointment.id },
    data: { startTime: newStart, endTime: newEnd, calendarSyncedAt: new Date() }
  });

  // Still confirmed — at a new time. Recorded in the audit trail rather than
  // inventing a status that says otherwise.
  await recordStatus(
    updated,
    "confirmed",
    "confirmed",
    params.actorUserId ? "operator" : "caller",
    `Rescheduled from ${previous ? formatLocal(previous, updated.timezone ?? "UTC") : "unknown"} to ${formatLocal(newStart, updated.timezone ?? "UTC")}`,
    params.actorUserId
  );
  await emitDomainEvent({
    businessId: updated.businessId,
    type: "booking.rescheduled",
    entityType: "booking",
    entityId: updated.id,
    payload: {
      service: updated.serviceName,
      when: formatLocal(newStart, updated.timezone ?? "UTC"),
      previous: previous ? formatLocal(previous, updated.timezone ?? "UTC") : null
    }
  });
  scheduleProcessing();

  return { status: "rescheduled", appointment: updated };
}

/** Writes the confirmation, its audit entry and its domain event. */
async function recordConfirmation(params: {
  appointment: Appointment;
  event: { id: string; start: Date; end: Date };
  calendarId: string;
  provider: string;
  now: Date;
  actorUserId: string | null;
  note: string;
}): Promise<Appointment> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: params.appointment.conversationId },
    select: { callerName: true }
  });

  const confirmed = await prisma.appointment.update({
    where: { id: params.appointment.id },
    data: {
      status: "confirmed",
      confirmedAt: params.now,
      resolvedAt: params.now,
      calendarProvider: params.provider,
      externalCalendarId: params.calendarId,
      externalEventId: params.event.id,
      externalEventStatus: "created",
      // The provider's own times win, so Veyra never disagrees with the calendar.
      startTime: params.event.start,
      endTime: params.event.end,
      calendarSyncedAt: params.now,
      confirmationExpiresAt: null
    }
  });

  await recordStatus(
    confirmed,
    "awaiting_confirmation",
    "confirmed",
    params.actorUserId ? "operator" : "caller",
    params.note,
    params.actorUserId
  );
  await emitDomainEvent({
    businessId: confirmed.businessId,
    type: "booking.confirmed",
    entityType: "booking",
    entityId: confirmed.id,
    payload: {
      customer: conversation?.callerName ?? null,
      service: confirmed.serviceName,
      when: formatLocal(confirmed.startTime!, confirmed.timezone ?? "UTC")
    }
  });
  scheduleProcessing();
  return confirmed;
}

async function recordStatus(
  appointment: Appointment,
  from: string,
  to: string,
  actorType: string,
  note: string,
  actorUserId?: string | null
): Promise<void> {
  await prisma.statusEvent.create({
    data: {
      businessId: appointment.businessId,
      entityType: "booking",
      entityId: appointment.id,
      fromStatus: from,
      toStatus: to,
      actorType,
      actorUserId: actorUserId ?? null,
      note
    }
  });
}
