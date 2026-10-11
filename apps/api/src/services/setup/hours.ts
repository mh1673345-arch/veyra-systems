import type { HoursPeriod, WorkingDay } from "@veyra/shared";
import { HttpError } from "../../middleware/errorHandler.js";

/**
 * Working hours: a weekly schedule of one or more periods per day, stored as
 * minutes from local midnight in the business timezone. Validation lives
 * here so the API rejects a bad schedule rather than storing it.
 */

export interface HourRow {
  dayOfWeek: number;
  opensMinute: number;
  closesMinute: number;
  bookable: boolean;
}

const DAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function parseTime(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value) ?? (value === "24:00" ? ["24:00", "24", "00"] : null);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Validates a full week and turns it into rows. Throws 400 with a specific reason. */
export function validateWeek(days: WorkingDay[]): HourRow[] {
  const seen = new Set<number>();
  const rows: HourRow[] = [];

  for (const day of days) {
    if (!Number.isInteger(day.dayOfWeek) || day.dayOfWeek < 1 || day.dayOfWeek > 7) {
      throw new HttpError(400, "Each day needs a weekday from 1 (Monday) to 7 (Sunday).");
    }
    if (seen.has(day.dayOfWeek)) {
      throw new HttpError(400, `${DAY_SHORT[day.dayOfWeek]} appears more than once.`);
    }
    seen.add(day.dayOfWeek);

    const periods = day.periods.map((period: HoursPeriod) => {
      const opens = parseTime(period.opens);
      const closes = parseTime(period.closes);
      if (opens === null || closes === null) {
        throw new HttpError(400, `${DAY_SHORT[day.dayOfWeek]}: times must be HH:MM.`);
      }
      if (opens >= closes) {
        throw new HttpError(400, `${DAY_SHORT[day.dayOfWeek]}: opening time must be before closing time.`);
      }
      return { opens, closes };
    });

    periods.sort((a, b) => a.opens - b.opens);
    for (let i = 1; i < periods.length; i += 1) {
      if (periods[i].opens < periods[i - 1].closes) {
        throw new HttpError(400, `${DAY_SHORT[day.dayOfWeek]}: opening periods overlap.`);
      }
    }

    for (const period of periods) {
      rows.push({
        dayOfWeek: day.dayOfWeek,
        opensMinute: period.opens,
        closesMinute: period.closes,
        bookable: day.bookable
      });
    }
  }

  return rows;
}

/** Rows back into the Console's one-entry-per-weekday shape. */
export function toWorkingDays(rows: HourRow[]): WorkingDay[] {
  return [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => {
    const dayRows = rows.filter((row) => row.dayOfWeek === dayOfWeek).sort((a, b) => a.opensMinute - b.opensMinute);
    return {
      dayOfWeek,
      periods: dayRows.map((row) => ({ opens: formatTime(row.opensMinute), closes: formatTime(row.closesMinute) })),
      // A closed day has no rows; default it to bookable so opening it later
      // doesn't silently exclude it.
      bookable: dayRows.length === 0 ? true : dayRows.every((row) => row.bookable)
    };
  });
}

function formatClock(minutes: number): string {
  const hour = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  const suffix = hour >= 12 ? "pm" : "am";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0 ? `${hour12}${suffix}` : `${hour12}:${String(minute).padStart(2, "0")}${suffix}`;
}

/**
 * A caller-friendly summary ("Mon-Fri 9am-5pm; Sat 9am-1pm; closed Sun"),
 * derived from the structured schedule so Reception always quotes the hours the
 * business actually configured. Consecutive days with identical periods are
 * grouped.
 */
export function summarizeHours(rows: HourRow[]): string {
  if (rows.length === 0) return "";

  const describe = (day: number) =>
    rows
      .filter((row) => row.dayOfWeek === day)
      .sort((a, b) => a.opensMinute - b.opensMinute)
      .map((row) => `${formatClock(row.opensMinute)}-${formatClock(row.closesMinute)}`)
      .join(", ");

  const parts: string[] = [];
  const closed: string[] = [];
  let day = 1;
  while (day <= 7) {
    const text = describe(day);
    if (!text) {
      closed.push(DAY_SHORT[day]);
      day += 1;
      continue;
    }
    let end = day;
    while (end + 1 <= 7 && describe(end + 1) === text) end += 1;
    parts.push(`${end > day ? `${DAY_SHORT[day]}-${DAY_SHORT[end]}` : DAY_SHORT[day]} ${text}`);
    day = end + 1;
  }
  if (closed.length > 0) parts.push(`closed ${closed.join(", ")}`);
  return parts.join("; ");
}
