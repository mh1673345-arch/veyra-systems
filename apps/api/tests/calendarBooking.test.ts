import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client.js";
import {
  cancelCalendarBooking,
  confirmHeldBooking,
  holdSlot,
  pendingHold,
  rescheduleCalendarBooking
} from "../src/services/calendar/bookings.js";
import { BOOKING_KEY_PATTERN, checkAvailability, newBookingKey } from "../src/services/calendar/service.js";
import {
  type CalendarBusinessFixture,
  at,
  createCalendarBusiness,
  fakeCalendarProvider,
  resetFakeCalendar
} from "./helpers/calendarFixtures.js";

/**
 * The calendar booking lifecycle, through the real service and the real
 * provider contract: hold → confirm → cancel / reschedule.
 */

const NOW = () => at("2026-10-05T09:00");
const TUE_3PM = () => at("2026-10-06T15:00");
const TUE_4PM = () => at("2026-10-06T16:00");

beforeEach(() => {
  resetFakeCalendar();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function holdTuesday3pm(fixture: CalendarBusinessFixture) {
  const availability = await checkAvailability({
    businessId: fixture.businessId,
    serviceId: fixture.serviceId,
    startTime: TUE_3PM(),
    now: NOW()
  });
  expect(availability.status).toBe("available");

  return holdSlot({
    businessId: fixture.businessId,
    conversationId: fixture.conversationId,
    serviceId: fixture.serviceId,
    serviceName: fixture.serviceName,
    start: availability.slot!.start,
    end: availability.slot!.end,
    timezone: availability.timezone,
    requestedTimeText: "Tuesday 6 October at 3:00 PM",
    now: NOW()
  });
}

describe("two-step confirmation", () => {
  it("checking availability creates no calendar event and no booking row", async () => {
    const fixture = await createCalendarBusiness();

    const before = await prisma.appointment.count({ where: { businessId: fixture.businessId } });
    const result = await checkAvailability({
      businessId: fixture.businessId,
      serviceId: fixture.serviceId,
      startTime: TUE_3PM(),
      now: NOW()
    });

    expect(result.status).toBe("available");
    expect(await prisma.appointment.count({ where: { businessId: fixture.businessId } })).toBe(before);
    expect(fakeCalendarProvider.listEvents()).toEqual([]);
  });

  it("holding a slot still creates no calendar event", async () => {
    const fixture = await createCalendarBusiness();
    const held = await holdTuesday3pm(fixture);

    expect(held.appointment.status).toBe("awaiting_confirmation");
    expect(held.appointment.mode).toBe("calendar");
    expect(held.appointment.externalEventId).toBeNull();
    expect(held.appointment.bookingKey).toMatch(BOOKING_KEY_PATTERN);
    expect(fakeCalendarProvider.listEvents()).toEqual([]);
  });

  // Regression: the key used to be prefixed "veyra", and base32hex has no
  // "y". Every character matters, because the key is handed to Google as the
  // event id verbatim — a bad one fails the create outright rather than
  // degrading. The fake provider cannot catch this; only the alphabet can.
  it("generates booking keys a real calendar will accept", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(newBookingKey()).toMatch(BOOKING_KEY_PATTERN);
    }
  });

  it("confirming creates exactly one event and records the linkage", async () => {
    const fixture = await createCalendarBusiness();
    const held = await holdTuesday3pm(fixture);

    const outcome = await confirmHeldBooking({ appointmentId: held.appointment.id, now: NOW() });
    expect(outcome.status).toBe("confirmed");

    const events = fakeCalendarProvider.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0].start.toISOString()).toBe(TUE_3PM().toISOString());

    const booking = await prisma.appointment.findUniqueOrThrow({ where: { id: held.appointment.id } });
    expect(booking.status).toBe("confirmed");
    expect(booking.externalEventId).toBe(events[0].id);
    expect(booking.externalCalendarId).toBe("primary");
    expect(booking.calendarProvider).toBe("fake");
    expect(booking.externalEventStatus).toBe("created");
    expect(booking.startTime?.toISOString()).toBe(TUE_3PM().toISOString());
    expect(booking.timezone).toBe("America/New_York");
    // The event is identified by id, never by its title.
    expect(booking.externalEventId).toBe(booking.bookingKey);
  });

  it("emits a domain event and queues operator notifications on confirmation", async () => {
    const fixture = await createCalendarBusiness();
    const held = await holdTuesday3pm(fixture);
    await confirmHeldBooking({ appointmentId: held.appointment.id, now: NOW() });

    const event = await prisma.domainEvent.findFirst({
      where: { businessId: fixture.businessId, type: "booking.confirmed", entityId: held.appointment.id }
    });
    expect(event).not.toBeNull();

    const history = await prisma.statusEvent.findMany({ where: { entityId: held.appointment.id } });
    expect(history.map((entry) => entry.toStatus)).toContain("confirmed");
  });

  it("a second confirmation does not create a second event", async () => {
    const fixture = await createCalendarBusiness();
    const held = await holdTuesday3pm(fixture);

    const first = await confirmHeldBooking({ appointmentId: held.appointment.id, now: NOW() });
    const second = await confirmHeldBooking({ appointmentId: held.appointment.id, now: NOW() });

    expect(first.status).toBe("confirmed");
    expect(second.status).toBe("confirmed");
    expect(second.status === "confirmed" && second.alreadyConfirmed).toBe(true);
    expect(fakeCalendarProvider.listEvents()).toHaveLength(1);
  });

  it("recovers in place when the provider's response is ambiguous", async () => {
    const fixture = await createCalendarBusiness();
    const held = await holdTuesday3pm(fixture);

    // The event lands, but the provider never confirms that it did.
    fakeCalendarProvider.setFailure("ambiguous");
    const outcome = await confirmHeldBooking({ appointmentId: held.appointment.id, now: NOW() });

    // Resolved by looking the booking key up, not by creating a second event.
    expect(outcome.status).toBe("confirmed");
    expect(fakeCalendarProvider.listEvents().filter((event) => event.status === "confirmed")).toHaveLength(1);
  });

  it("does not create a second event when a retry follows a crash after the provider accepted", async () => {
    const fixture = await createCalendarBusiness();
    const held = await holdTuesday3pm(fixture);
    await confirmHeldBooking({ appointmentId: held.appointment.id, now: NOW() });
    expect(fakeCalendarProvider.listEvents()).toHaveLength(1);

    // Simulate the event existing in the calendar while Veyra never recorded it
    // (process died between the provider accepting and the database write).
    await prisma.appointment.update({
      where: { id: held.appointment.id },
      data: {
        status: "awaiting_confirmation",
        externalEventId: null,
        externalEventStatus: null,
        confirmedAt: null,
        resolvedAt: null,
        confirmationExpiresAt: new Date(NOW().getTime() + 30 * 60_000)
      }
    });

    const retry = await confirmHeldBooking({ appointmentId: held.appointment.id, now: NOW() });
    expect(retry.status).toBe("confirmed");
    // Still exactly one event, and the booking points at it.
    const events = fakeCalendarProvider.listEvents().filter((event) => event.status === "confirmed");
    expect(events).toHaveLength(1);
    const booking = await prisma.appointment.findUniqueOrThrow({ where: { id: held.appointment.id } });
    expect(booking.externalEventId).toBe(events[0].id);
  });

  it("refuses to confirm a slot that was taken while the caller was deciding", async () => {
    const fixture = await createCalendarBusiness();
    const held = await holdTuesday3pm(fixture);

    fakeCalendarProvider.setBusy([{ start: TUE_3PM(), end: TUE_4PM() }]);
    const outcome = await confirmHeldBooking({ appointmentId: held.appointment.id, now: NOW() });

    expect(outcome.status).toBe("slot_taken");
    expect(fakeCalendarProvider.listEvents()).toEqual([]);
    const booking = await prisma.appointment.findUniqueOrThrow({ where: { id: held.appointment.id } });
    expect(booking.status).toBe("awaiting_confirmation");
  });

  it("does not confirm, or claim to, when the calendar is unreachable", async () => {
    const fixture = await createCalendarBusiness();
    const held = await holdTuesday3pm(fixture);

    fakeCalendarProvider.setFailure("unavailable");
    const outcome = await confirmHeldBooking({ appointmentId: held.appointment.id, now: NOW() });

    expect(outcome.status).toBe("calendar_unavailable");
    const booking = await prisma.appointment.findUniqueOrThrow({ where: { id: held.appointment.id } });
    expect(booking.status).toBe("awaiting_confirmation");
    expect(booking.externalEventId).toBeNull();
  });

  it("lets a hold expire rather than booking it later", async () => {
    const fixture = await createCalendarBusiness();
    const held = await holdTuesday3pm(fixture);

    const later = new Date(held.appointment.confirmationExpiresAt!.getTime() + 60_000);
    expect(await pendingHold(fixture.conversationId, later)).toBeNull();

    const outcome = await confirmHeldBooking({ appointmentId: held.appointment.id, now: later });
    expect(outcome.status).toBe("expired");
    expect(fakeCalendarProvider.listEvents()).toEqual([]);
  });

  it("replaces an earlier hold in the same conversation instead of stacking them", async () => {
    const fixture = await createCalendarBusiness();
    const first = await holdTuesday3pm(fixture);
    const second = await holdSlot({
      businessId: fixture.businessId,
      conversationId: fixture.conversationId,
      serviceId: fixture.serviceId,
      serviceName: fixture.serviceName,
      start: TUE_4PM(),
      end: at("2026-10-06T17:00"),
      timezone: fixture.timezone,
      requestedTimeText: "Tuesday 6 October at 4:00 PM",
      now: NOW()
    });

    const previous = await prisma.appointment.findUniqueOrThrow({ where: { id: first.appointment.id } });
    expect(previous.status).toBe("cancelled");
    expect((await pendingHold(fixture.conversationId, NOW()))?.id).toBe(second.appointment.id);
  });
});

describe("cancellation", () => {
  it("cancels the external event first, then records it", async () => {
    const fixture = await createCalendarBusiness();
    const held = await holdTuesday3pm(fixture);
    await confirmHeldBooking({ appointmentId: held.appointment.id, now: NOW() });

    const outcome = await cancelCalendarBooking({ appointmentId: held.appointment.id });
    expect(outcome.status).toBe("cancelled");

    expect(fakeCalendarProvider.listEvents()[0].status).toBe("cancelled");
    const booking = await prisma.appointment.findUniqueOrThrow({ where: { id: held.appointment.id } });
    expect(booking.status).toBe("cancelled");
    expect(booking.externalEventStatus).toBe("cancelled");

    const event = await prisma.domainEvent.findFirst({
      where: { type: "booking.cancelled", entityId: held.appointment.id }
    });
    expect(event).not.toBeNull();
  });

  it("leaves the booking confirmed when the provider fails to cancel", async () => {
    const fixture = await createCalendarBusiness();
    const held = await holdTuesday3pm(fixture);
    await confirmHeldBooking({ appointmentId: held.appointment.id, now: NOW() });

    fakeCalendarProvider.setFailure("unavailable");
    const outcome = await cancelCalendarBooking({ appointmentId: held.appointment.id });

    expect(outcome.status).toBe("provider_failed");
    const booking = await prisma.appointment.findUniqueOrThrow({ where: { id: held.appointment.id } });
    // Never says "cancelled" while the event may still exist.
    expect(booking.status).toBe("confirmed");
    expect(fakeCalendarProvider.listEvents()[0].status).toBe("confirmed");
  });

  it("cancels a held slot that was never confirmed", async () => {
    const fixture = await createCalendarBusiness();
    const held = await holdTuesday3pm(fixture);

    const outcome = await cancelCalendarBooking({ appointmentId: held.appointment.id });
    expect(outcome.status).toBe("cancelled");
    expect(fakeCalendarProvider.listEvents()).toEqual([]);
  });
});

describe("rescheduling", () => {
  async function confirmed(fixture: CalendarBusinessFixture) {
    const held = await holdTuesday3pm(fixture);
    await confirmHeldBooking({ appointmentId: held.appointment.id, now: NOW() });
    return held.appointment.id;
  }

  it("moves the existing event rather than recreating it", async () => {
    const fixture = await createCalendarBusiness();
    const bookingId = await confirmed(fixture);
    const originalEventId = fakeCalendarProvider.listEvents()[0].id;

    const outcome = await rescheduleCalendarBooking({
      appointmentId: bookingId,
      newStart: at("2026-10-07T11:00"),
      now: NOW()
    });

    expect(outcome.status).toBe("rescheduled");
    const events = fakeCalendarProvider.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(originalEventId);
    expect(events[0].start.toISOString()).toBe(at("2026-10-07T11:00").toISOString());

    const booking = await prisma.appointment.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe("confirmed");
    expect(booking.startTime?.toISOString()).toBe(at("2026-10-07T11:00").toISOString());

    const history = await prisma.statusEvent.findMany({ where: { entityId: bookingId } });
    expect(history.some((entry) => entry.note?.includes("Rescheduled from"))).toBe(true);
  });

  it("keeps the original booking when the new time is busy", async () => {
    const fixture = await createCalendarBusiness();
    const bookingId = await confirmed(fixture);
    fakeCalendarProvider.setBusy([{ start: at("2026-10-07T11:00"), end: at("2026-10-07T12:00") }]);

    const outcome = await rescheduleCalendarBooking({
      appointmentId: bookingId,
      newStart: at("2026-10-07T11:00"),
      now: NOW()
    });

    expect(outcome.status).toBe("unavailable");
    const booking = await prisma.appointment.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.startTime?.toISOString()).toBe(TUE_3PM().toISOString());
    expect(fakeCalendarProvider.listEvents()[0].start.toISOString()).toBe(TUE_3PM().toISOString());
  });

  it("keeps the original booking when the new time breaks the rules", async () => {
    const fixture = await createCalendarBusiness();
    const bookingId = await confirmed(fixture);

    const outcome = await rescheduleCalendarBooking({
      appointmentId: bookingId,
      newStart: at("2026-10-07T22:00"),
      now: NOW()
    });

    expect(outcome.status).toBe("unavailable");
    expect(outcome.status === "unavailable" && outcome.availability.status).toBe("outside_business_hours");
    const booking = await prisma.appointment.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.startTime?.toISOString()).toBe(TUE_3PM().toISOString());
  });

  it("keeps the original booking when the provider fails mid-move", async () => {
    const fixture = await createCalendarBusiness();
    const bookingId = await confirmed(fixture);

    // Availability reads fine, the update itself is rejected.
    fakeCalendarProvider.setFailure("rejected");
    const outcome = await rescheduleCalendarBooking({
      appointmentId: bookingId,
      newStart: at("2026-10-07T11:00"),
      now: NOW()
    });

    expect(outcome.status).toBe("calendar_unavailable");
    const booking = await prisma.appointment.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.startTime?.toISOString()).toBe(TUE_3PM().toISOString());
  });
});
