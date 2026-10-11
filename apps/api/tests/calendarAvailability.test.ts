import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client.js";
import { checkAvailability } from "../src/services/calendar/service.js";
import { formatLocal } from "../src/services/calendar/rules.js";
import {
  type CalendarBusinessFixture,
  at,
  createCalendarBusiness,
  fakeCalendarProvider,
  resetFakeCalendar
} from "./helpers/calendarFixtures.js";

/**
 * Availability, through the real CalendarService. Only the provider is the
 * in-memory fake — the capability check, the booking rules, the free/busy
 * filtering and the alternative search are the production code paths.
 */

const NOW = () => at("2026-10-05T09:00");
const TUE_3PM = () => at("2026-10-06T15:00");

beforeEach(() => {
  resetFakeCalendar();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function check(fixture: CalendarBusinessFixture, start = TUE_3PM(), now = NOW()) {
  return checkAvailability({
    businessId: fixture.businessId,
    serviceId: fixture.serviceId,
    startTime: start,
    now
  });
}

describe("capability and connection gating", () => {
  it("stays request-only when calendar booking is switched off", async () => {
    const fixture = await createCalendarBusiness({ calendarBooking: false, connect: true });
    const result = await check(fixture);

    expect(result.status).toBe("requires_manual_review");
    expect(result.detail).toContain("not enabled");
  });

  it("stays request-only when the capability is on but nothing is connected", async () => {
    const fixture = await createCalendarBusiness({ connect: false });
    const result = await check(fixture);

    expect(result.status).toBe("requires_manual_review");
    expect(result.detail).toContain("no healthy calendar connection");
  });

  it("stays request-only when the connection needs re-authentication", async () => {
    const fixture = await createCalendarBusiness({ connectionStatus: "needs_reauth" });
    expect((await check(fixture)).status).toBe("requires_manual_review");
  });

  it("stays request-only when no calendar has been selected yet", async () => {
    const fixture = await createCalendarBusiness({ selectedCalendarId: null });
    expect((await check(fixture)).status).toBe("requires_manual_review");
  });

  it("checks live availability when the capability is on and a calendar is connected", async () => {
    const fixture = await createCalendarBusiness();
    const result = await check(fixture);

    expect(result.status).toBe("available");
    expect(result.slot?.start.toISOString()).toBe(TUE_3PM().toISOString());
    expect(result.timezone).toBe("America/New_York");
  });

  it("requires a configured duration rather than inventing one", async () => {
    const fixture = await createCalendarBusiness({ serviceDurationMinutes: null });
    const result = await check(fixture);

    expect(result.status).toBe("requires_manual_review");
    expect(result.detail).toContain("no configured duration");
  });
});

describe("availability answers", () => {
  it("reports a free slot as available", async () => {
    const fixture = await createCalendarBusiness();
    expect((await check(fixture)).status).toBe("available");
  });

  it("reports a busy slot as unavailable and offers real alternatives", async () => {
    const fixture = await createCalendarBusiness();
    fakeCalendarProvider.setBusy([{ start: TUE_3PM(), end: at("2026-10-06T16:00") }]);

    const result = await check(fixture);
    expect(result.status).toBe("unavailable");
    expect(result.alternatives.length).toBeGreaterThan(0);

    // Every alternative is genuinely free and inside working hours.
    const busyStart = TUE_3PM().getTime();
    const busyEnd = at("2026-10-06T16:00").getTime();
    for (const slot of result.alternatives) {
      expect(slot.start.getTime() >= busyEnd || slot.end.getTime() <= busyStart).toBe(true);
      const label = formatLocal(slot.start, result.timezone);
      expect(label).toMatch(/AM|PM/);
    }
  });

  it("offers the free slots nearest the requested time, not merely the earliest", async () => {
    const fixture = await createCalendarBusiness();
    fakeCalendarProvider.setBusy([{ start: TUE_3PM(), end: at("2026-10-06T16:00") }]);

    const result = await check(fixture);
    const labels = result.alternatives.map((slot) => formatLocal(slot.start, result.timezone));

    // 2:00 and 4:00 are an hour away; 1:30 is next. 9:00 AM is free too, but far.
    expect(labels).toEqual([
      "Tuesday 6 October at 1:30 PM",
      "Tuesday 6 October at 2:00 PM",
      "Tuesday 6 October at 4:00 PM"
    ]);
  });

  it("does not offer a slot that another appointment already occupies", async () => {
    const fixture = await createCalendarBusiness();
    // The whole of Tuesday afternoon is taken.
    fakeCalendarProvider.setBusy([{ start: at("2026-10-06T12:00"), end: at("2026-10-06T17:00") }]);

    const result = await check(fixture);
    expect(result.status).toBe("unavailable");
    for (const slot of result.alternatives) {
      const overlapsBusy =
        slot.start.getTime() < at("2026-10-06T17:00").getTime() &&
        slot.end.getTime() > at("2026-10-06T12:00").getTime();
      expect(overlapsBusy).toBe(false);
    }
  });

  it("treats the buffer around an appointment as busy", async () => {
    const fixture = await createCalendarBusiness({ bufferBeforeMinutes: 15, bufferAfterMinutes: 15 });
    // Ends 10 minutes before the requested 3 PM — inside the 15 minute buffer.
    fakeCalendarProvider.setBusy([{ start: at("2026-10-06T14:00"), end: at("2026-10-06T14:50") }]);

    expect((await check(fixture)).status).toBe("unavailable");
  });

  it("reports rule violations with their own status, not as 'busy'", async () => {
    const fixture = await createCalendarBusiness();

    expect((await check(fixture, at("2026-10-06T07:00"))).status).toBe("outside_business_hours");
    expect((await check(fixture, at("2026-10-11T10:00"))).status).toBe("outside_business_hours");
    expect((await check(fixture, at("2026-10-05T10:00"))).status).toBe("too_soon");
    expect((await check(fixture, at("2027-06-01T10:00"))).status).toBe("too_far");
  });

  it("never claims availability when the calendar cannot be reached", async () => {
    const fixture = await createCalendarBusiness();
    fakeCalendarProvider.setFailure("unavailable");

    const result = await check(fixture);
    expect(result.status).toBe("calendar_unavailable");
    // No invented alternatives either.
    expect(result.alternatives).toEqual([]);
  });

  it("marks the connection as needing re-auth when the provider rejects the credentials", async () => {
    const fixture = await createCalendarBusiness();
    fakeCalendarProvider.setFailure("auth");

    expect((await check(fixture)).status).toBe("calendar_unavailable");

    const connection = await prisma.calendarConnection.findFirstOrThrow({
      where: { businessId: fixture.businessId }
    });
    expect(connection.status).toBe("needs_reauth");
  });

  it("offers no alternatives it cannot verify", async () => {
    const fixture = await createCalendarBusiness();
    // Busy everywhere the rules would allow.
    fakeCalendarProvider.setBusy([{ start: at("2026-10-05T00:00"), end: at("2026-12-31T00:00") }]);

    const result = await check(fixture);
    expect(result.status).toBe("unavailable");
    expect(result.alternatives).toEqual([]);
  });
});

describe("timezone correctness end to end", () => {
  it("applies the business's own working hours, not the server's", async () => {
    // 09:00-17:00 in Karachi. 15:00 New York is 00:00 next day in Karachi.
    const fixture = await createCalendarBusiness({ timezone: "Asia/Karachi" });

    const localAfternoon = at("2026-10-06T15:00", "Asia/Karachi");
    expect((await check(fixture, localAfternoon)).status).toBe("available");

    const middleOfNight = at("2026-10-06T03:00", "Asia/Karachi");
    expect((await check(fixture, middleOfNight)).status).toBe("outside_business_hours");
  });

  it("keeps a 9 AM slot at 9 AM local across a daylight-saving change", async () => {
    const fixture = await createCalendarBusiness();
    const now = at("2026-10-26T09:00");

    // The Monday after the US autumn change.
    const result = await checkAvailability({
      businessId: fixture.businessId,
      serviceId: fixture.serviceId,
      startTime: at("2026-11-02T09:00"),
      now
    });

    expect(result.status).toBe("available");
    expect(result.slot?.start.toISOString()).toBe("2026-11-02T14:00:00.000Z");
    expect(formatLocal(result.slot!.start, result.timezone)).toBe("Monday 2 November at 9:00 AM");
  });
});
