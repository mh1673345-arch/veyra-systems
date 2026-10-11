import type { Appointment } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { emitDomainEvent } from "../notifications/events.js";

/**
 * Releasing expired holds.
 *
 * When a caller asks for a time, Veyra holds the slot as
 * `awaiting_confirmation` with a short confirmation window. If the caller
 * never says yes, that row used to sit in the database for good: the caller
 * had moved on, but the Console still showed a booking waiting on someone, and
 * a later "cancel my appointment" could still find it.
 *
 * This releases them: `awaiting_confirmation` + a confirmation window that has
 * passed becomes `expired`, which is terminal. Nothing is deleted — the
 * appointment row and its whole status history stay exactly as they were, with
 * one more entry saying the hold lapsed.
 *
 * It is swept lazily, immediately before anything reads or changes holds for a
 * business, rather than by a background timer that could quietly stop.
 */

export interface ReleasedHolds {
  released: number;
  appointments: Appointment[];
}

export async function releaseExpiredHolds(params: { businessId?: string; now?: Date } = {}): Promise<ReleasedHolds> {
  const now = params.now ?? new Date();

  const expired = await prisma.appointment.findMany({
    where: {
      ...(params.businessId ? { businessId: params.businessId } : {}),
      mode: "calendar",
      status: "awaiting_confirmation",
      confirmationExpiresAt: { not: null, lte: now }
    }
  });
  if (expired.length === 0) return { released: 0, appointments: [] };

  const released: Appointment[] = [];
  for (const appointment of expired) {
    // Conditional on the status not having moved in the meantime: a caller
    // confirming at the same moment must win, not be overwritten by the sweep.
    const result = await prisma.appointment.updateMany({
      where: { id: appointment.id, status: "awaiting_confirmation" },
      data: { status: "expired", resolvedAt: now, confirmationExpiresAt: null }
    });
    if (result.count === 0) continue;

    await prisma.statusEvent.create({
      data: {
        businessId: appointment.businessId,
        entityType: "booking",
        entityId: appointment.id,
        fromStatus: "awaiting_confirmation",
        toStatus: "expired",
        actorType: "system",
        note: "The held slot was never confirmed and the confirmation window passed."
      }
    });
    released.push({ ...appointment, status: "expired", resolvedAt: now, confirmationExpiresAt: null });
  }

  // Operators hear about it in the ordinary way, so a slot quietly coming back
  // is visible rather than silent.
  for (const appointment of released) {
    await emitDomainEvent({
      businessId: appointment.businessId,
      type: "booking_request.status_changed",
      entityType: "booking",
      entityId: appointment.id,
      payload: { from: "awaiting_confirmation", to: "expired", service: appointment.serviceName }
    }).catch((err) => console.error("[veyra:holds] could not emit a hold-expiry event", err));
  }

  return { released: released.length, appointments: released };
}
