import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { DateTime } from "luxon";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { TZ, createCalendarBusiness, fakeCalendarProvider, resetFakeCalendar } from "./helpers/calendarFixtures.js";

/**
 * The caller-facing flow, over real HTTP, for both product modes:
 *
 *   Starter (calendar_booking off)  → request-only, exactly as before Phase 8
 *   Growth  (capability + calendar) → live availability, then confirmation
 *
 * These go through the API, the responder, the action resolver, the executor
 * and CalendarService. Only the calendar provider is the in-memory fake.
 */

const app = createApp();
const apiKey = process.env.VEYRA_API_KEY as string;

/**
 * The next weekday at 2pm in the business zone, and the phrase a caller would
 * use for it. Relative to the real clock, because the HTTP path has no
 * injectable one — which is also the point: it must work on any day it runs.
 */
function nextWeekdaySlot() {
  let day = DateTime.now().setZone(TZ).startOf("day").plus({ days: 1 });
  while (day.weekday > 5) day = day.plus({ days: 1 });
  const start = day.set({ hour: 14 });
  return {
    start: start.toJSDate(),
    end: start.plus({ hours: 1 }).toJSDate(),
    phrase: `${start.toFormat("cccc").toLowerCase()} at 2pm`,
    label: start.toFormat("cccc d LLLL 'at' h:mm a")
  };
}

async function say(conversationId: string, text: string) {
  const res = await request(app)
    .post(`/api/conversations/${conversationId}/messages`)
    .set("x-api-key", apiKey)
    .send({ text });
  expect(res.status).toBe(201);
  return res.body as {
    receptionistMessage: { text: string; action: string | null };
    actionResult: { action: string; status: string; message?: string; metadata?: Record<string, string> };
  };
}

beforeEach(() => {
  resetFakeCalendar();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Starter business: calendar booking switched off", () => {
  it("stays request-only and never claims a time is available", async () => {
    const fixture = await createCalendarBusiness({ calendarBooking: false, connect: false });
    const slot = nextWeekdaySlot();

    const reply = await say(fixture.conversationId, `Book me ${slot.phrase}`);

    expect(reply.actionResult.action).not.toBe("check_calendar_availability");
    expect(reply.receptionistMessage.text).not.toMatch(/is available/i);
    // Nothing was held and nothing reached a calendar.
    expect(await prisma.appointment.count({ where: { businessId: fixture.businessId } })).toBe(0);
    expect(fakeCalendarProvider.listEvents()).toEqual([]);
  });

  it("stays request-only when the capability is on but no calendar is connected", async () => {
    const fixture = await createCalendarBusiness({ connect: false });
    const slot = nextWeekdaySlot();

    const reply = await say(fixture.conversationId, `Book me ${slot.phrase}`);

    expect(reply.receptionistMessage.text).not.toMatch(/is available/i);
    expect(await prisma.appointment.count({ where: { businessId: fixture.businessId } })).toBe(0);
  });
});

describe("Growth business: live calendar", () => {
  it("checks real availability, asks for confirmation, and books only after a yes", async () => {
    const fixture = await createCalendarBusiness();
    const slot = nextWeekdaySlot();

    // 1. The caller asks for a time.
    const asked = await say(fixture.conversationId, `Book me ${slot.phrase}`);

    expect(asked.actionResult.action).toBe("check_calendar_availability");
    expect(asked.actionResult.metadata?.availability).toBe("available");
    expect(asked.receptionistMessage.text).toContain(slot.label);
    expect(asked.receptionistMessage.text).toMatch(/would you like me to confirm/i);
    // Asking is not booking.
    expect(fakeCalendarProvider.listEvents()).toEqual([]);

    const held = await prisma.appointment.findFirstOrThrow({
      where: { conversationId: fixture.conversationId }
    });
    expect(held.status).toBe("awaiting_confirmation");
    expect(held.startTime?.toISOString()).toBe(slot.start.toISOString());

    // 2. The caller says yes.
    const confirmed = await say(fixture.conversationId, "yes please");

    expect(confirmed.actionResult.action).toBe("confirm_calendar_booking");
    expect(confirmed.actionResult.status).toBe("completed");
    expect(confirmed.receptionistMessage.text).toMatch(/you're booked/i);

    const events = fakeCalendarProvider.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0].start.toISOString()).toBe(slot.start.toISOString());

    const booking = await prisma.appointment.findUniqueOrThrow({ where: { id: held.id } });
    expect(booking.status).toBe("confirmed");
    expect(booking.externalEventId).toBe(events[0].id);
  });

  it("offers real alternatives when the requested time is taken, and books one of them", async () => {
    const fixture = await createCalendarBusiness();
    const slot = nextWeekdaySlot();
    fakeCalendarProvider.setBusy([{ start: slot.start, end: slot.end }]);

    const asked = await say(fixture.conversationId, `Can I come in ${slot.phrase}?`);

    expect(asked.actionResult.metadata?.availability).toBe("unavailable");
    expect(asked.receptionistMessage.text).toMatch(/taken/i);
    const offered = (asked.actionResult.metadata?.alternatives ?? "").split(",").filter(Boolean);
    expect(offered.length).toBeGreaterThan(0);
    // Every offered time is genuinely outside the busy window.
    for (const iso of offered) {
      const start = new Date(iso);
      expect(start.getTime() >= slot.end.getTime() || start.getTime() <= slot.start.getTime()).toBe(true);
    }
    expect(await prisma.appointment.count({ where: { conversationId: fixture.conversationId } })).toBe(0);
  });

  it("does not book when the caller has not said yes", async () => {
    const fixture = await createCalendarBusiness();
    const slot = nextWeekdaySlot();

    await say(fixture.conversationId, `Book me ${slot.phrase}`);
    const declined = await say(fixture.conversationId, "no thanks, not that one");

    expect(declined.actionResult.action).not.toBe("confirm_calendar_booking");
    expect(fakeCalendarProvider.listEvents()).toEqual([]);
  });

  it("does not treat a bare yes as a booking when nothing is held", async () => {
    const fixture = await createCalendarBusiness();

    const reply = await say(fixture.conversationId, "yes");

    expect(reply.actionResult.action).not.toBe("confirm_calendar_booking");
    expect(fakeCalendarProvider.listEvents()).toEqual([]);
  });

  it("a repeated yes does not create a second appointment", async () => {
    const fixture = await createCalendarBusiness();
    const slot = nextWeekdaySlot();

    await say(fixture.conversationId, `Book me ${slot.phrase}`);
    await say(fixture.conversationId, "yes");
    const again = await say(fixture.conversationId, "yes");

    expect(fakeCalendarProvider.listEvents()).toHaveLength(1);
    expect(
      await prisma.appointment.count({
        where: { conversationId: fixture.conversationId, status: "confirmed" }
      })
    ).toBe(1);
    // The second yes is not reported as a fresh booking.
    expect(again.actionResult.metadata?.alreadyConfirmed ?? "false").not.toBe("");
  });

  it("falls back to manual review when the calendar cannot be reached", async () => {
    const fixture = await createCalendarBusiness();
    const slot = nextWeekdaySlot();
    fakeCalendarProvider.setFailure("unavailable");

    const reply = await say(fixture.conversationId, `Book me ${slot.phrase}`);

    expect(reply.actionResult.status).toBe("failed");
    expect(reply.receptionistMessage.text).toMatch(/trouble checking live availability/i);
    expect(reply.receptionistMessage.text).toMatch(/request for the team/i);
    // No slot held, nothing claimed as booked.
    expect(await prisma.appointment.count({ where: { conversationId: fixture.conversationId } })).toBe(0);
  });

  it("asks for a time rather than guessing when the caller gives none", async () => {
    const fixture = await createCalendarBusiness();

    const reply = await say(fixture.conversationId, "I'd like to book an appointment");

    expect(reply.actionResult.action).not.toBe("confirm_calendar_booking");
    expect(fakeCalendarProvider.listEvents()).toEqual([]);
    expect(await prisma.appointment.count({ where: { conversationId: fixture.conversationId } })).toBe(0);
  });

  it("cancels a confirmed booking when the caller asks", async () => {
    const fixture = await createCalendarBusiness();
    const slot = nextWeekdaySlot();

    await say(fixture.conversationId, `Book me ${slot.phrase}`);
    await say(fixture.conversationId, "yes");
    const cancelled = await say(fixture.conversationId, "actually I need to cancel my appointment");

    expect(cancelled.actionResult.action).toBe("cancel_calendar_booking");
    expect(cancelled.actionResult.status).toBe("completed");
    expect(fakeCalendarProvider.listEvents()[0].status).toBe("cancelled");

    const booking = await prisma.appointment.findFirstOrThrow({
      where: { conversationId: fixture.conversationId },
      orderBy: { createdAt: "desc" }
    });
    expect(booking.status).toBe("cancelled");
  });

  it("never tells the caller a cancellation happened when the provider refused", async () => {
    const fixture = await createCalendarBusiness();
    const slot = nextWeekdaySlot();

    await say(fixture.conversationId, `Book me ${slot.phrase}`);
    await say(fixture.conversationId, "yes");

    fakeCalendarProvider.setFailure("unavailable");
    const cancelled = await say(fixture.conversationId, "please cancel my appointment");

    expect(cancelled.actionResult.status).toBe("failed");
    expect(cancelled.receptionistMessage.text).not.toMatch(/that's cancelled/i);
    expect(fakeCalendarProvider.listEvents()[0].status).toBe("confirmed");
  });

  it("keeps answering ordinary questions without touching the calendar", async () => {
    const fixture = await createCalendarBusiness();

    const reply = await say(fixture.conversationId, "how much is teeth whitening?");

    expect(reply.receptionistMessage.text).toContain("$250");
    expect(reply.actionResult.action).not.toBe("check_calendar_availability");
    expect(fakeCalendarProvider.listEvents()).toEqual([]);
  });
});
