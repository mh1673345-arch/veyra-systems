import { DateTime } from "luxon";

/**
 * Booking rules: everything that decides whether a time is bookable *before*
 * the calendar is consulted at all. A slot is bookable only if these rules
 * allow it AND the calendar says it is free — free/busy alone is never enough,
 * or Veyra would happily book 3am on a closed Sunday.
 *
 * Every calculation happens in the business's IANA timezone. Server and
 * browser clocks are only ever used as instants (UTC); no local formatting of
 * the host machine takes part in a decision.
 */

export interface BusinessHourRule {
  /** ISO weekday: 1 = Monday ... 7 = Sunday. */
  dayOfWeek: number;
  /** Minutes from local midnight. */
  opensMinute: number;
  closesMinute: number;
  bookable: boolean;
}

export interface BookingRules {
  timezone: string;
  minNoticeMinutes: number;
  maxHorizonDays: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  slotIntervalMinutes: number;
  hours: BusinessHourRule[];
}

/** Why a requested time is not bookable. Structured, never prose. */
export type RuleViolation =
  | "too_soon"
  | "too_far"
  | "outside_business_hours"
  | "invalid_time"
  | "unknown_duration";

export interface RuleCheckResult {
  ok: boolean;
  violation?: RuleViolation;
  /** The window that must be free on the calendar, buffers included. */
  window?: { start: Date; end: Date };
  appointment?: { start: Date; end: Date };
}

export class InvalidTimezoneError extends Error {}

export function assertValidTimezone(timezone: string): void {
  if (!DateTime.local().setZone(timezone).isValid) {
    throw new InvalidTimezoneError(`"${timezone}" is not a valid IANA timezone.`);
  }
}

export function isValidTimezone(timezone: string): boolean {
  return DateTime.local().setZone(timezone).isValid;
}

/**
 * Resolves a local wall-clock time in a zone to an instant.
 *
 * Returns null for a time that does not exist there — the spring-forward gap,
 * e.g. 02:30 on a US DST morning. Guessing (silently shifting to 03:30) would
 * book a customer at a time nobody asked for.
 */
export function instantFromLocal(
  local: { year: number; month: number; day: number; hour: number; minute: number },
  timezone: string
): Date | null {
  const dt = DateTime.fromObject(local, { zone: timezone });
  if (!dt.isValid) return null;
  // Luxon shifts a nonexistent local time forward; if what comes back isn't
  // what was asked for, the time doesn't exist in this zone.
  if (dt.hour !== local.hour || dt.minute !== local.minute || dt.day !== local.day) return null;
  return dt.toJSDate();
}

/** Local wall-clock parts of an instant, in the business timezone. */
export function localParts(instant: Date, timezone: string) {
  const dt = DateTime.fromJSDate(instant, { zone: timezone });
  return {
    year: dt.year,
    month: dt.month,
    day: dt.day,
    hour: dt.hour,
    minute: dt.minute,
    weekday: dt.weekday,
    minuteOfDay: dt.hour * 60 + dt.minute
  };
}

/** Human-readable time in the business timezone, e.g. "Tuesday 9 October at 3:00 PM". */
export function formatLocal(instant: Date, timezone: string): string {
  return DateTime.fromJSDate(instant, { zone: timezone }).toFormat("cccc d LLLL 'at' h:mm a");
}

export function formatLocalTimeOnly(instant: Date, timezone: string): string {
  return DateTime.fromJSDate(instant, { zone: timezone }).toFormat("h:mm a");
}

/** Bookable opening periods for a weekday, earliest first. A day may have several (split days). */
function periodsFor(rules: BookingRules, weekday: number): BusinessHourRule[] {
  return rules.hours
    .filter((hour) => hour.dayOfWeek === weekday && hour.bookable)
    .sort((a, b) => a.opensMinute - b.opensMinute);
}

/**
 * Checks a requested appointment against the business rules alone.
 * `now` is injected so tests (and the caller's request) share one clock.
 */
export function checkBookingRules(params: {
  rules: BookingRules;
  start: Date;
  durationMinutes: number | null;
  now: Date;
}): RuleCheckResult {
  const { rules, start, durationMinutes, now } = params;

  if (Number.isNaN(start.getTime())) return { ok: false, violation: "invalid_time" };
  if (!durationMinutes || durationMinutes <= 0) return { ok: false, violation: "unknown_duration" };
  if (!isValidTimezone(rules.timezone)) return { ok: false, violation: "invalid_time" };

  const end = new Date(start.getTime() + durationMinutes * 60_000);

  const minutesAway = (start.getTime() - now.getTime()) / 60_000;
  if (minutesAway < rules.minNoticeMinutes) return { ok: false, violation: "too_soon" };

  const horizonEnd = DateTime.fromJSDate(now, { zone: rules.timezone })
    .plus({ days: rules.maxHorizonDays })
    .toJSDate();
  if (start.getTime() > horizonEnd.getTime()) return { ok: false, violation: "too_far" };

  // Working hours are compared in local wall-clock minutes, so a DST change
  // never moves opening time.
  const startLocal = localParts(start, rules.timezone);
  const periods = periodsFor(rules, startLocal.weekday);
  if (periods.length === 0) return { ok: false, violation: "outside_business_hours" };

  const endLocal = localParts(end, rules.timezone);
  const endMinuteOfDay =
    endLocal.day === startLocal.day ? endLocal.minuteOfDay : endLocal.minuteOfDay + 24 * 60;

  // The whole appointment must fit inside one opening period: a booking can't
  // straddle a lunch break.
  const fits = periods.some(
    (period) => startLocal.minuteOfDay >= period.opensMinute && endMinuteOfDay <= period.closesMinute
  );
  if (!fits) return { ok: false, violation: "outside_business_hours" };

  return {
    ok: true,
    appointment: { start, end },
    window: {
      start: new Date(start.getTime() - rules.bufferBeforeMinutes * 60_000),
      end: new Date(end.getTime() + rules.bufferAfterMinutes * 60_000)
    }
  };
}

/**
 * Every slot the rules allow between `from` and `horizon`, at the business's
 * slot interval. Calendar availability is applied by the caller — this function
 * never claims a slot is free.
 */
export function candidateSlots(params: {
  rules: BookingRules;
  durationMinutes: number;
  now: Date;
  from: Date;
  limitDays?: number;
}): { start: Date; end: Date; window: { start: Date; end: Date } }[] {
  const { rules, durationMinutes, now, from } = params;
  const limitDays = Math.min(params.limitDays ?? 14, rules.maxHorizonDays);
  const slots: { start: Date; end: Date; window: { start: Date; end: Date } }[] = [];

  let day = DateTime.fromJSDate(from, { zone: rules.timezone }).startOf("day");

  for (let dayOffset = 0; dayOffset <= limitDays; dayOffset += 1) {
    for (const hours of periodsFor(rules, day.weekday)) {
      for (
        let minute = hours.opensMinute;
        minute + durationMinutes <= hours.closesMinute;
        minute += rules.slotIntervalMinutes
      ) {
        const start = instantFromLocal(
          {
            year: day.year,
            month: day.month,
            day: day.day,
            hour: Math.floor(minute / 60),
            minute: minute % 60
          },
          rules.timezone
        );
        // Skips local times that don't exist (spring-forward gap).
        if (!start) continue;

        const check = checkBookingRules({ rules, start, durationMinutes, now });
        if (check.ok && check.appointment && check.window) {
          slots.push({ start: check.appointment.start, end: check.appointment.end, window: check.window });
        }
      }
    }
    day = day.plus({ days: 1 });
  }

  return slots;
}

/** True when [aStart, aEnd) and [bStart, bEnd) overlap. Touching is not overlapping. */
export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}
