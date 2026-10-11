import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import {
  type BookingRules,
  candidateSlots,
  checkBookingRules,
  formatLocal,
  instantFromLocal,
  isValidTimezone,
  localParts
} from "../src/services/calendar/rules.js";
import { isAffirmation, isCancellationRequest, parseRequestedTime } from "../src/services/calendar/requestedTime.js";

/**
 * Booking rules and timezone handling, with no database and no provider.
 * Every expectation is written in the business's local time, because that is
 * the only clock that decides anything.
 */

const NY = "America/New_York";
const KARACHI = "Asia/Karachi";

function rules(overrides: Partial<BookingRules> = {}): BookingRules {
  return {
    timezone: NY,
    minNoticeMinutes: 120,
    maxHorizonDays: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    slotIntervalMinutes: 30,
    hours: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
      dayOfWeek,
      opensMinute: 9 * 60,
      closesMinute: 17 * 60,
      bookable: true
    })),
    ...overrides
  };
}

const local = (iso: string, zone = NY) => DateTime.fromISO(iso, { zone }).toJSDate();

describe("timezone handling", () => {
  it("resolves a local wall-clock time in the business zone, not the server zone", () => {
    const start = instantFromLocal({ year: 2026, month: 10, day: 6, hour: 15, minute: 0 }, NY);
    // 3 PM in New York on that date is 19:00 UTC (EDT, UTC-4).
    expect(start?.toISOString()).toBe("2026-10-06T19:00:00.000Z");

    const karachi = instantFromLocal({ year: 2026, month: 10, day: 6, hour: 15, minute: 0 }, KARACHI);
    expect(karachi?.toISOString()).toBe("2026-10-06T10:00:00.000Z");
  });

  it("keeps opening time fixed in local terms across a DST change", () => {
    // 9 AM the day before and the day after the US autumn change are 13:00Z
    // and 14:00Z — the same local hour, a different UTC offset.
    const before = instantFromLocal({ year: 2026, month: 10, day: 30, hour: 9, minute: 0 }, NY);
    const after = instantFromLocal({ year: 2026, month: 11, day: 2, hour: 9, minute: 0 }, NY);
    expect(before?.toISOString()).toBe("2026-10-30T13:00:00.000Z");
    expect(after?.toISOString()).toBe("2026-11-02T14:00:00.000Z");
    expect(localParts(after!, NY).hour).toBe(9);
  });

  it("refuses a local time that does not exist in the spring-forward gap", () => {
    // 2026-03-08 02:30 never happens in New York.
    expect(instantFromLocal({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NY)).toBeNull();
    // The hour either side is fine.
    expect(instantFromLocal({ year: 2026, month: 3, day: 8, hour: 1, minute: 30 }, NY)).not.toBeNull();
    expect(instantFromLocal({ year: 2026, month: 3, day: 8, hour: 3, minute: 30 }, NY)).not.toBeNull();
  });

  it("resolves the ambiguous autumn hour to a single real instant", () => {
    // 01:30 happens twice on 2026-11-01; the earlier (EDT) one is chosen.
    const instant = instantFromLocal({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, NY);
    expect(instant?.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(localParts(instant!, NY).hour).toBe(1);
  });

  it("rejects a timezone that is not a real IANA zone", () => {
    expect(isValidTimezone(NY)).toBe(true);
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(isValidTimezone("EST5EDT")).toBe(true);
  });

  it("formats times in the business zone", () => {
    expect(formatLocal(local("2026-10-06T15:00"), NY)).toBe("Tuesday 6 October at 3:00 PM");
  });
});

describe("booking rules", () => {
  const now = local("2026-10-05T09:00");

  it("accepts a slot inside working hours with enough notice", () => {
    const result = checkBookingRules({ rules: rules(), start: local("2026-10-06T15:00"), durationMinutes: 60, now });
    expect(result.ok).toBe(true);
    expect(result.appointment?.end.toISOString()).toBe(local("2026-10-06T16:00").toISOString());
  });

  it("rejects a time before the business opens or after it closes", () => {
    expect(checkBookingRules({ rules: rules(), start: local("2026-10-06T08:00"), durationMinutes: 60, now }).violation)
      .toBe("outside_business_hours");
    // 16:30 + 60 minutes runs past a 17:00 close.
    expect(checkBookingRules({ rules: rules(), start: local("2026-10-06T16:30"), durationMinutes: 60, now }).violation)
      .toBe("outside_business_hours");
  });

  it("rejects a closed day", () => {
    // Sunday has no row at all.
    expect(checkBookingRules({ rules: rules(), start: local("2026-10-11T10:00"), durationMinutes: 60, now }).violation)
      .toBe("outside_business_hours");
    // A day that is open but explicitly not bookable.
    const saturdayNotBookable = rules({
      hours: [...rules().hours, { dayOfWeek: 6, opensMinute: 9 * 60, closesMinute: 13 * 60, bookable: false }]
    });
    expect(
      checkBookingRules({ rules: saturdayNotBookable, start: local("2026-10-10T10:00"), durationMinutes: 60, now }).violation
    ).toBe("outside_business_hours");
  });

  it("enforces minimum notice", () => {
    // 10:00 today is only an hour away.
    expect(checkBookingRules({ rules: rules(), start: local("2026-10-05T10:00"), durationMinutes: 60, now }).violation)
      .toBe("too_soon");
    expect(checkBookingRules({ rules: rules(), start: local("2026-10-05T11:30"), durationMinutes: 60, now }).ok).toBe(true);
  });

  it("enforces the booking horizon", () => {
    expect(checkBookingRules({ rules: rules({ maxHorizonDays: 7 }), start: local("2026-10-20T10:00"), durationMinutes: 60, now }).violation)
      .toBe("too_far");
    expect(checkBookingRules({ rules: rules({ maxHorizonDays: 7 }), start: local("2026-10-09T10:00"), durationMinutes: 60, now }).ok)
      .toBe(true);
  });

  it("refuses to compute anything without a known service duration", () => {
    expect(checkBookingRules({ rules: rules(), start: local("2026-10-06T15:00"), durationMinutes: null, now }).violation)
      .toBe("unknown_duration");
  });

  it("widens the window that must be free by the configured buffers", () => {
    const result = checkBookingRules({
      rules: rules({ bufferBeforeMinutes: 15, bufferAfterMinutes: 30 }),
      start: local("2026-10-06T15:00"),
      durationMinutes: 60,
      now
    });
    expect(result.window?.start.toISOString()).toBe(local("2026-10-06T14:45").toISOString());
    expect(result.window?.end.toISOString()).toBe(local("2026-10-06T16:30").toISOString());
    // The appointment itself is unchanged; only the free-time requirement grows.
    expect(result.appointment?.start.toISOString()).toBe(local("2026-10-06T15:00").toISOString());
  });
});

describe("candidate slots", () => {
  const now = local("2026-10-05T09:00");

  it("generates only slots the rules allow, at the configured interval", () => {
    const slots = candidateSlots({ rules: rules(), durationMinutes: 60, now, from: now, limitDays: 1 });
    const times = slots.map((slot) => formatLocal(slot.start, NY));

    // Today's remaining slots start after the 2-hour notice (11:00 is the first
    // half-hour boundary at or after 11:00), and the last one ends by 17:00.
    expect(times[0]).toBe("Monday 5 October at 11:00 AM");
    expect(times.at(-1)).toBe("Tuesday 6 October at 4:00 PM");
    expect(slots.every((slot) => slot.end.getTime() - slot.start.getTime() === 60 * 60_000)).toBe(true);
  });

  it("skips a closed weekend", () => {
    const friday = local("2026-10-09T09:00");
    const slots = candidateSlots({ rules: rules(), durationMinutes: 60, now: friday, from: friday, limitDays: 3 });
    const days = new Set(slots.map((slot) => DateTime.fromJSDate(slot.start, { zone: NY }).weekday));
    expect(days.has(6)).toBe(false);
    expect(days.has(7)).toBe(false);
    expect(days.has(1)).toBe(true);
  });
});

describe("parsing what the caller asked for", () => {
  const now = local("2026-10-05T09:00");

  it("reads a weekday and time as the next such day in the business zone", () => {
    const parsed = parseRequestedTime("Book me Tuesday at 3", NY, now);
    expect(parsed?.start.toISOString()).toBe(local("2026-10-06T15:00").toISOString());
    // "3" with no am/pm was read as the afternoon, and is flagged as assumed.
    expect(parsed?.assumedMeridiem).toBe(true);
  });

  it("handles explicit meridiems, 24-hour times, tomorrow and dates", () => {
    expect(parseRequestedTime("can I come tomorrow at 10am", NY, now)?.start.toISOString())
      .toBe(local("2026-10-06T10:00").toISOString());
    expect(parseRequestedTime("wednesday 14:30 please", NY, now)?.start.toISOString())
      .toBe(local("2026-10-07T14:30").toISOString());
    expect(parseRequestedTime("9 October at 11am", NY, now)?.start.toISOString())
      .toBe(local("2026-10-09T11:00").toISOString());
    expect(parseRequestedTime("next tuesday at 3pm", NY, now)?.start.toISOString())
      .toBe(local("2026-10-13T15:00").toISOString());
  });

  it("returns null rather than guessing", () => {
    expect(parseRequestedTime("book me in sometime soon", NY, now)).toBeNull();
    expect(parseRequestedTime("how much is whitening?", NY, now)).toBeNull();
    // A weekday with no time at all is not a bookable request.
    expect(parseRequestedTime("are you open tuesday", NY, now)).toBeNull();
  });

  it("never resolves a time in the past", () => {
    expect(parseRequestedTime("today at 8am", NY, now)).toBeNull();
  });

  it("resolves the same phrase differently for businesses in different zones", () => {
    const ny = parseRequestedTime("tomorrow at 10am", NY, now);
    const karachi = parseRequestedTime("tomorrow at 10am", KARACHI, now);
    expect(ny?.start.toISOString()).not.toBe(karachi?.start.toISOString());
  });

  it("recognises a confirmation and a cancellation, and is not fooled by a refusal", () => {
    expect(isAffirmation("yes please")).toBe(true);
    expect(isAffirmation("yes")).toBe(true);
    expect(isAffirmation("that works")).toBe(true);
    expect(isAffirmation("no thanks")).toBe(false);
    expect(isAffirmation("not that one")).toBe(false);
    expect(isCancellationRequest("I need to cancel my appointment")).toBe(true);
    expect(isCancellationRequest("how much is a cleaning")).toBe(false);
  });
});
