import { DateTime } from "luxon";
import type { PilotRange, PilotRangeKey } from "@veyra/shared";
import { HttpError } from "../../middleware/errorHandler.js";

/**
 * Date ranges for pilot analytics.
 *
 * Day boundaries are resolved in the *business's* timezone, never the server's
 * or the browser's: "today" for a clinic in New York is not the same window as
 * "today" for the machine running this process, and a pilot report that
 * silently used UTC midnight would miscount every evening conversation.
 *
 * `from` is inclusive, `to` is exclusive.
 */

export interface ResolveRangeParams {
  key?: string;
  from?: string;
  to?: string;
  timezone: string;
  /** Start of the pilot, for "pilot_lifetime". */
  pilotStartedAt?: Date | null;
  /** End of the pilot, so a completed pilot's lifetime stops where it stopped. */
  pilotEndedAt?: Date | null;
  now?: Date;
}

const KEYS: PilotRangeKey[] = ["today", "last_7_days", "last_30_days", "pilot_lifetime", "custom"];

function zone(timezone: string): string {
  return DateTime.local().setZone(timezone).isValid ? timezone : "UTC";
}

export function resolveRange(params: ResolveRangeParams): PilotRange {
  const tz = zone(params.timezone);
  const now = DateTime.fromJSDate(params.now ?? new Date()).setZone(tz);
  const key = (KEYS as string[]).includes(params.key ?? "") ? (params.key as PilotRangeKey) : "last_7_days";
  // Exclusive end: tomorrow's local midnight, so today's activity is included.
  const endOfToday = now.startOf("day").plus({ days: 1 });

  switch (key) {
    case "today":
      return build("today", now.startOf("day"), endOfToday, tz, "Today");

    case "last_30_days":
      return build("last_30_days", endOfToday.minus({ days: 30 }), endOfToday, tz, "Last 30 days");

    case "pilot_lifetime": {
      if (!params.pilotStartedAt) {
        throw new HttpError(400, "This business has no pilot start date, so pilot lifetime can't be measured.");
      }
      const start = DateTime.fromJSDate(params.pilotStartedAt).setZone(tz).startOf("day");
      const end = params.pilotEndedAt
        ? DateTime.fromJSDate(params.pilotEndedAt).setZone(tz).startOf("day").plus({ days: 1 })
        : endOfToday;
      return build("pilot_lifetime", start, end < start ? start.plus({ days: 1 }) : end, tz, "Pilot lifetime");
    }

    case "custom": {
      if (!params.from || !params.to) {
        throw new HttpError(400, "A custom range needs both from and to dates (YYYY-MM-DD).");
      }
      const start = DateTime.fromISO(params.from, { zone: tz }).startOf("day");
      // `to` is given as an inclusive calendar day by the client, so the
      // exclusive boundary is the following local midnight.
      const end = DateTime.fromISO(params.to, { zone: tz }).startOf("day").plus({ days: 1 });
      if (!start.isValid || !end.isValid) throw new HttpError(400, "from and to must be valid dates (YYYY-MM-DD).");
      if (end <= start) throw new HttpError(400, "The end of the range must be on or after the start.");
      if (end.diff(start, "days").days > 366) throw new HttpError(400, "A custom range can cover at most one year.");
      return build("custom", start, end, tz, `${start.toFormat("d LLL yyyy")} – ${end.minus({ days: 1 }).toFormat("d LLL yyyy")}`);
    }

    case "last_7_days":
    default:
      return build("last_7_days", endOfToday.minus({ days: 7 }), endOfToday, tz, "Last 7 days");
  }
}

function build(key: PilotRangeKey, from: DateTime, to: DateTime, timezone: string, label: string): PilotRange {
  return { key, from: from.toUTC().toISO()!, to: to.toUTC().toISO()!, timezone, label };
}

export function rangeWindow(range: PilotRange): { gte: Date; lt: Date } {
  return { gte: new Date(range.from), lt: new Date(range.to) };
}

/** Every local day in the range, so a chart shows zeroes instead of gaps. */
export function localDays(range: PilotRange): string[] {
  const start = DateTime.fromISO(range.from).setZone(range.timezone).startOf("day");
  const end = DateTime.fromISO(range.to).setZone(range.timezone).startOf("day");
  const days: string[] = [];
  for (let day = start; day < end && days.length <= 400; day = day.plus({ days: 1 })) {
    days.push(day.toFormat("yyyy-LL-dd"));
  }
  return days;
}

/** Which local day an instant falls on, in the business's zone. */
export function localDay(instant: Date, timezone: string): string {
  return DateTime.fromJSDate(instant).setZone(zone(timezone)).toFormat("yyyy-LL-dd");
}
