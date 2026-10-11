import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client.js";
import {
  cancelCalendarBooking,
  confirmHeldBooking,
  holdSlot,
  rescheduleCalendarBooking
} from "../src/services/calendar/bookings.js";
import { checkAvailability } from "../src/services/calendar/service.js";
import { processPendingNotifications } from "../src/services/notifications/processor.js";
import { emitDomainEvent } from "../src/services/notifications/events.js";
import { resolveOrCreateContact, linkContact } from "../src/services/contacts/contactService.js";
import { recordConsent } from "../src/services/messaging/consent.js";
import { confirmationCopy } from "../src/services/contacts/confirmationCopy.js";
import {
  at,
  createCalendarBusiness,
  fakeCalendarProvider,
  resetFakeCalendar,
  type CalendarBusinessFixture
} from "./helpers/calendarFixtures.js";
import {
  FAKE_OPTED_OUT_NUMBER,
  capturedMessages,
  resetFakeMessaging
} from "../src/services/messaging/providers/fakeMessaging.js";

/**
 * Transactional booking confirmations.
 *
 * The behaviour worth testing is mostly what does NOT happen: no message for
 * a booking request, none for a reschedule the calendar refused, none to
 * someone who opted out, and never two for one transition however many times
 * the event arrives.
 */

const NOW = () => at("2026-10-05T09:00");
const TUE_3PM = () => at("2026-10-06T15:00");
const TUE_4PM = () => at("2026-10-06T16:00");
const CUSTOMER = "+14155552671";
const SENDER = "+14155550100";

async function enableMessaging(
  businessId: string,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  for (const entitlement of ["sms", "whatsapp"]) {
    await prisma.entitlementGrant.upsert({
      where: { businessId_entitlement: { businessId, entitlement } },
      create: { businessId, entitlement, reason: "test fixture" },
      update: {}
    });
  }
  await prisma.messagingSettings.upsert({
    where: { businessId },
    create: {
      businessId,
      smsEnabled: true,
      whatsappEnabled: true,
      smsProvider: "fake",
      whatsappProvider: "fake",
      smsSender: SENDER,
      whatsappSender: SENDER,
      customerMessagingEnabled: true,
      bookingConfirmationEnabled: true,
      bookingRescheduleNotificationEnabled: true,
      bookingCancellationNotificationEnabled: true,
      ...overrides
    },
    update: {
      smsEnabled: true,
      whatsappEnabled: true,
      smsProvider: "fake",
      whatsappProvider: "fake",
      smsSender: SENDER,
      whatsappSender: SENDER,
      customerMessagingEnabled: true,
      bookingConfirmationEnabled: true,
      bookingRescheduleNotificationEnabled: true,
      bookingCancellationNotificationEnabled: true,
      ...overrides
    }
  });
}

/** Gives the fixture's conversation a customer Veyra can actually reach. */
async function withContact(
  fixture: CalendarBusinessFixture,
  phone: string = CUSTOMER
): Promise<string> {
  const { contact } = await resolveOrCreateContact({
    businessId: fixture.businessId,
    phone,
    name: "Sam Customer",
    source: "web"
  });
  await linkContact({ contactId: contact.id, conversationId: fixture.conversationId });
  return contact.id;
}

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

/**
 * Emitting an event kicks off a background delivery pass, so a test that
 * processes on top of it can read a row mid-flight. Wait for whatever is
 * already claimed to finish, then run a pass of our own and wait again.
 */
async function settle(businessId: string): Promise<void> {
  const quiet = async () => {
    const deadline = Date.now() + 10_000;
    while ((await prisma.notification.count({ where: { businessId, claimToken: { not: null } } })) > 0) {
      if (Date.now() > deadline) throw new Error("notifications did not settle within 10s");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  await quiet();
  await processPendingNotifications();
  await quiet();
}

/** Confirms a held booking and narrows the lifecycle union for the caller. */
async function confirmBooking(appointmentId: string) {
  const outcome = await confirmHeldBooking({ appointmentId, now: NOW() });
  expect(outcome.status).toBe("confirmed");
  if (!("appointment" in outcome) || !outcome.appointment) {
    throw new Error(`expected a confirmed appointment, got ${outcome.status}`);
  }
  return outcome.appointment;
}

/** Customer-facing messages only: staff notifications share the table. */
async function customerNotifications(businessId: string) {
  return prisma.notification.findMany({
    where: { businessId, userId: null, linkEntity: "booking" },
    orderBy: { createdAt: "asc" }
  });
}

beforeEach(() => {
  resetFakeCalendar();
  resetFakeMessaging();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("which transitions message the customer", () => {
  it("confirms a calendar booking on the customer's channel", async () => {
    const fixture = await createCalendarBusiness({ namePrefix: "Confirm" });
    await enableMessaging(fixture.businessId);
    await withContact(fixture);

    const held = await holdTuesday3pm(fixture);
    await confirmHeldBooking({ appointmentId: held.appointment.id, now: NOW() });

    const messages = await customerNotifications(fixture.businessId);
    expect(messages).toHaveLength(1);
    expect(messages[0].channel).toBe("sms");
    expect(messages[0].recipientPhone).toBe(CUSTOMER);
    expect(messages[0].body).toMatch(/is confirmed for 6 Oct at 3:00 PM/);
    // The service is named; nothing else about the customer is included.
    expect(messages[0].body).toContain("Teeth whitening");

    const record = await prisma.bookingConfirmation.findFirstOrThrow({
      where: { appointmentId: held.appointment.id }
    });
    expect(record.transition).toBe("confirmed");
    expect(record.outcome).toBe("queued");
    expect(record.recipient).not.toContain("5552671");
  });

  it("never tells a request-only customer their appointment is confirmed", async () => {
    // A request has no calendar behind it, so "confirmed" would be a promise
    // nobody has made.
    const fixture = await createCalendarBusiness({ namePrefix: "Request", connect: false });
    await enableMessaging(fixture.businessId);
    await withContact(fixture);

    const appointment = await prisma.appointment.create({
      data: {
        businessId: fixture.businessId,
        conversationId: fixture.conversationId,
        requestedTime: "Tuesday 3pm",
        status: "submitted",
        mode: "request"
      }
    });
    await emitDomainEvent({
      businessId: fixture.businessId,
      type: "booking.confirmed",
      entityType: "booking",
      entityId: appointment.id,
      payload: {}
    });

    expect(await customerNotifications(fixture.businessId)).toHaveLength(0);
  });

  it("sends nothing while the transition is switched off", async () => {
    const fixture = await createCalendarBusiness({ namePrefix: "Off" });
    await enableMessaging(fixture.businessId, { bookingConfirmationEnabled: false });
    await withContact(fixture);

    const held = await holdTuesday3pm(fixture);
    await confirmHeldBooking({ appointmentId: held.appointment.id, now: NOW() });

    expect(await customerNotifications(fixture.businessId)).toHaveLength(0);
    expect(await prisma.bookingConfirmation.count({ where: { businessId: fixture.businessId } })).toBe(0);
  });

  it("sends nothing when customer messaging as a whole is off", async () => {
    const fixture = await createCalendarBusiness({ namePrefix: "NoCustomer" });
    await enableMessaging(fixture.businessId, { customerMessagingEnabled: false });
    await withContact(fixture);

    const held = await holdTuesday3pm(fixture);
    await confirmHeldBooking({ appointmentId: held.appointment.id, now: NOW() });
    expect(await customerNotifications(fixture.businessId)).toHaveLength(0);
  });
});

describe("idempotency", () => {
  it("does not send twice when the same transition event arrives again", async () => {
    const fixture = await createCalendarBusiness({ namePrefix: "Dup" });
    await enableMessaging(fixture.businessId);
    await withContact(fixture);

    const held = await holdTuesday3pm(fixture);
    const confirmed = await confirmBooking(held.appointment.id);

    // A replayed domain event carries a NEW event id, so only the
    // booking-and-transition key can catch it.
    await emitDomainEvent({
      businessId: fixture.businessId,
      type: "booking.confirmed",
      entityType: "booking",
      entityId: confirmed.id,
      payload: { service: "Teeth whitening", when: "6 Oct at 3:00 PM" }
    });
    await emitDomainEvent({
      businessId: fixture.businessId,
      type: "booking.confirmed",
      entityType: "booking",
      entityId: confirmed.id,
      payload: { service: "Teeth whitening", when: "6 Oct at 3:00 PM" }
    });

    expect(await customerNotifications(fixture.businessId)).toHaveLength(1);
    expect(
      await prisma.bookingConfirmation.count({
        where: { appointmentId: confirmed.id, transition: "confirmed" }
      })
    ).toBe(1);

    await settle(fixture.businessId);
    expect(capturedMessages().filter((m) => m.to === CUSTOMER)).toHaveLength(1);
  });

  it("treats a second reschedule as its own confirmation", async () => {
    const fixture = await createCalendarBusiness({ namePrefix: "Twice" });
    await enableMessaging(fixture.businessId);
    await withContact(fixture);

    const held = await holdTuesday3pm(fixture);
    const confirmed = await confirmBooking(held.appointment.id);

    await rescheduleCalendarBooking({
      appointmentId: confirmed.id,
      newStart: TUE_4PM(),
      now: NOW()
    });
    await rescheduleCalendarBooking({
      appointmentId: confirmed.id,
      newStart: at("2026-10-06T14:00"),
      now: NOW()
    });

    const reschedules = await prisma.bookingConfirmation.findMany({
      where: { appointmentId: confirmed.id, transition: "rescheduled" }
    });
    // Two genuine moves, told apart by the new time.
    expect(reschedules).toHaveLength(2);
    expect(new Set(reschedules.map((r) => r.transitionKey)).size).toBe(2);
  });
});

describe("reschedule and cancellation semantics", () => {
  it("confirms the new time, and only after the calendar accepted the move", async () => {
    const fixture = await createCalendarBusiness({ namePrefix: "Move" });
    await enableMessaging(fixture.businessId);
    await withContact(fixture);

    const held = await holdTuesday3pm(fixture);
    const confirmed = await confirmBooking(held.appointment.id);
    const outcome = await rescheduleCalendarBooking({
      appointmentId: confirmed.id,
      newStart: TUE_4PM(),
      now: NOW()
    });
    expect(outcome.status).toBe("rescheduled");

    const messages = await customerNotifications(fixture.businessId);
    const move = messages.find((m) => m.body.includes("moved"));
    expect(move).toBeDefined();
    expect(move!.body).toMatch(/to 6 Oct at 4:00 PM/);
    // The old time is named too, from the lifecycle's own wording.
    expect(move!.body).toMatch(/from .*3:00 PM/);
  });

  it("says nothing when the calendar refuses the move", async () => {
    const fixture = await createCalendarBusiness({ namePrefix: "MoveFail" });
    await enableMessaging(fixture.businessId);
    await withContact(fixture);

    const held = await holdTuesday3pm(fixture);
    const confirmed = await confirmBooking(held.appointment.id);
    const before = (await customerNotifications(fixture.businessId)).length;

    fakeCalendarProvider.setFailure("unavailable");
    const outcome = await rescheduleCalendarBooking({
      appointmentId: confirmed.id,
      newStart: TUE_4PM(),
      now: NOW()
    });

    expect(outcome.status).toBe("calendar_unavailable");
    expect(await customerNotifications(fixture.businessId)).toHaveLength(before);
    expect(
      await prisma.bookingConfirmation.count({
        where: { appointmentId: confirmed.id, transition: "rescheduled" }
      })
    ).toBe(0);
    // And the booking is still at its original time.
    const unchanged = await prisma.appointment.findUniqueOrThrow({
      where: { id: confirmed.id }
    });
    expect(unchanged.startTime!.toISOString()).toBe(TUE_3PM().toISOString());
  });

  it("confirms a cancellation once the calendar event is gone", async () => {
    const fixture = await createCalendarBusiness({ namePrefix: "Cancel" });
    await enableMessaging(fixture.businessId);
    await withContact(fixture);

    const held = await holdTuesday3pm(fixture);
    const confirmed = await confirmBooking(held.appointment.id);
    const outcome = await cancelCalendarBooking({ appointmentId: confirmed.id });
    expect(outcome.status).toBe("cancelled");

    const messages = await customerNotifications(fixture.businessId);
    const cancelled = messages.find((m) => m.body.includes("cancelled"));
    expect(cancelled).toBeDefined();
    expect(cancelled!.body).toMatch(/is cancelled/);
  });

  it("says nothing when the cancellation fails at the provider", async () => {
    const fixture = await createCalendarBusiness({ namePrefix: "CancelFail" });
    await enableMessaging(fixture.businessId);
    await withContact(fixture);

    const held = await holdTuesday3pm(fixture);
    const confirmed = await confirmBooking(held.appointment.id);
    const before = (await customerNotifications(fixture.businessId)).length;

    fakeCalendarProvider.setFailure("unavailable");
    const outcome = await cancelCalendarBooking({ appointmentId: confirmed.id });

    expect(outcome.status).toBe("provider_failed");
    expect(await customerNotifications(fixture.businessId)).toHaveLength(before);
    // The booking is still active, so a "cancelled" message would be a lie.
    const still = await prisma.appointment.findUniqueOrThrow({ where: { id: confirmed.id } });
    expect(still.status).toBe("confirmed");
  });
});

describe("consent and destination", () => {
  it("does not message someone who opted out, and records why", async () => {
    const fixture = await createCalendarBusiness({ namePrefix: "OptOut" });
    await enableMessaging(fixture.businessId);
    await withContact(fixture);
    await recordConsent({
      businessId: fixture.businessId,
      channel: "sms",
      phone: CUSTOMER,
      state: "revoked",
      source: "stop_keyword"
    });

    const held = await holdTuesday3pm(fixture);
    await confirmHeldBooking({ appointmentId: held.appointment.id, now: NOW() });

    expect(await customerNotifications(fixture.businessId)).toHaveLength(0);
    const record = await prisma.bookingConfirmation.findFirstOrThrow({
      where: { businessId: fixture.businessId }
    });
    expect(record.outcome).toBe("blocked");
    expect(record.channel).toBe("none");
    expect(record.reason).toMatch(/opted out/i);
  });

  it("records no_destination when the customer left no contact details", async () => {
    const fixture = await createCalendarBusiness({ namePrefix: "NoDest" });
    await enableMessaging(fixture.businessId);

    const held = await holdTuesday3pm(fixture);
    await confirmHeldBooking({ appointmentId: held.appointment.id, now: NOW() });

    expect(await customerNotifications(fixture.businessId)).toHaveLength(0);
    const record = await prisma.bookingConfirmation.findFirstOrThrow({
      where: { businessId: fixture.businessId }
    });
    expect(record.outcome).toBe("no_destination");
    expect(record.reason).toMatch(/no contact details/i);
  });

  it("will not quietly use another channel when fallback is switched off", async () => {
    const fixture = await createCalendarBusiness({ namePrefix: "NoFallback" });
    // Prefers WhatsApp, which this customer has never messaged on, so it
    // needs a template that does not exist.
    await enableMessaging(fixture.businessId, { transactionalChannelPreference: "whatsapp" });
    await withContact(fixture);

    const held = await holdTuesday3pm(fixture);
    await confirmHeldBooking({ appointmentId: held.appointment.id, now: NOW() });

    expect(await customerNotifications(fixture.businessId)).toHaveLength(0);
    const record = await prisma.bookingConfirmation.findFirstOrThrow({
      where: { businessId: fixture.businessId }
    });
    expect(record.outcome).toBe("blocked");
    expect(record.reason).toMatch(/template/i);
  });

  it("uses a second channel when the business has asked for a fallback", async () => {
    const fixture = await createCalendarBusiness({ namePrefix: "Fallback" });
    await enableMessaging(fixture.businessId, {
      transactionalChannelPreference: "whatsapp",
      transactionalFallbackEnabled: true
    });
    await withContact(fixture);

    const held = await holdTuesday3pm(fixture);
    await confirmHeldBooking({ appointmentId: held.appointment.id, now: NOW() });

    const messages = await customerNotifications(fixture.businessId);
    expect(messages).toHaveLength(1);
    expect(messages[0].channel).toBe("sms");
  });

  it("sends through an approved WhatsApp template when the window is closed", async () => {
    const fixture = await createCalendarBusiness({ namePrefix: "Template" });
    await enableMessaging(fixture.businessId, { transactionalChannelPreference: "whatsapp" });
    await withContact(fixture);
    await prisma.messageTemplate.create({
      data: {
        businessId: fixture.businessId,
        key: "booking_confirmed",
        channel: "whatsapp",
        providerTemplateId: "veyra_booking_confirmed_v1",
        language: "en",
        variables: JSON.stringify(["body"]),
        status: "approved"
      }
    });

    const held = await holdTuesday3pm(fixture);
    await confirmHeldBooking({ appointmentId: held.appointment.id, now: NOW() });
    await settle(fixture.businessId);

    const sent = capturedMessages().filter((m) => m.channel === "whatsapp");
    expect(sent).toHaveLength(1);
    // A template, not free-form: the window is closed.
    expect(sent[0].templateName).toBe("veyra_booking_confirmed_v1");
  });
});

describe("delivery and failure", () => {
  it("records acceptance, then delivery only when a receipt says so", async () => {
    const fixture = await createCalendarBusiness({ namePrefix: "Deliver" });
    await enableMessaging(fixture.businessId);
    await withContact(fixture);

    const held = await holdTuesday3pm(fixture);
    await confirmHeldBooking({ appointmentId: held.appointment.id, now: NOW() });
    await settle(fixture.businessId);

    const notification = (await customerNotifications(fixture.businessId))[0];
    const after = await prisma.notification.findUniqueOrThrow({ where: { id: notification.id } });
    expect(after.status).toBe("sent");
    expect(after.deliveryStatus).toBe("accepted");
    expect(after.deliveryStatus).not.toBe("delivered");
  });

  it("leaves the booking confirmed when the message cannot be delivered", async () => {
    const fixture = await createCalendarBusiness({ namePrefix: "SendFail" });
    await enableMessaging(fixture.businessId);
    // A number the fake provider refuses permanently.
    await withContact(fixture, FAKE_OPTED_OUT_NUMBER);

    const held = await holdTuesday3pm(fixture);
    const confirmed = await confirmBooking(held.appointment.id);
    await settle(fixture.businessId);

    const notification = (await customerNotifications(fixture.businessId))[0];
    const after = await prisma.notification.findUniqueOrThrow({ where: { id: notification.id } });
    expect(after.status).toBe("failed");

    // The booking is untouched: telling someone is downstream of the promise.
    const booking = await prisma.appointment.findUniqueOrThrow({
      where: { id: confirmed.id }
    });
    expect(booking.status).toBe("confirmed");
  });
});

describe("staff notifications are unaffected", () => {
  it("still alerts the team, separately from the customer", async () => {
    const fixture = await createCalendarBusiness({ namePrefix: "Staff" });
    await enableMessaging(fixture.businessId);
    await withContact(fixture);
    // A team to alert: the fixture has no members of its own.
    const member = await prisma.user.create({
      data: {
        email: `staff-${Math.random().toString(36).slice(2, 8)}@confirm.test`,
        name: "Ona Owner",
        passwordHash: "x"
      }
    });
    await prisma.businessMembership.create({
      data: { userId: member.id, businessId: fixture.businessId, role: "OWNER" }
    });

    const held = await holdTuesday3pm(fixture);
    await confirmHeldBooking({ appointmentId: held.appointment.id, now: NOW() });

    const inApp = await prisma.notification.count({
      where: { businessId: fixture.businessId, channel: "in_app" }
    });
    const customer = await customerNotifications(fixture.businessId);
    // Two different recipient types from one transition.
    expect(inApp).toBeGreaterThan(0);
    expect(customer).toHaveLength(1);
    expect(customer[0].userId).toBeNull();
  });
});

describe("copy", () => {
  it("states the facts and invents nothing", () => {
    const facts = {
      businessName: "Colour pix",
      serviceName: "Initial assessment",
      // The fixture helper builds instants in this zone; formatting in the
      // same one keeps the assertion about the copy, not about offsets.
      timezone: "America/New_York",
      start: at("2026-10-09T15:00"),
      contactPhone: "+922112345"
    };

    const confirmed = confirmationCopy("confirmed", facts);
    expect(confirmed.body).toContain("Colour pix");
    expect(confirmed.body).toContain("Initial assessment");
    expect(confirmed.body).toMatch(/9 Oct at/);
    expect(confirmed.body).toContain("+922112345");

    const cancelled = confirmationCopy("cancelled", facts);
    expect(cancelled.body).toMatch(/is cancelled/);
    expect(cancelled.body).toMatch(/to rebook/);

    const moved = confirmationCopy("rescheduled", { ...facts, previousLabel: "8 Oct at 2:00 PM" });
    expect(moved.body).toContain("from 8 Oct at 2:00 PM");
  });

  it("copes with a booking that has no service or time", () => {
    const copy = confirmationCopy("confirmed", {
      businessName: "Colour pix",
      serviceName: null,
      timezone: "UTC",
      start: null
    });
    expect(copy.body).toContain("the agreed time");
    expect(copy.body).not.toContain("null");
    expect(copy.body).not.toContain("undefined");
  });
});
