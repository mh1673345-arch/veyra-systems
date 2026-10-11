import { DateTime } from "luxon";
import { instantFromLocal } from "./rules.js";

/**
 * Turns a caller's phrasing ("Tuesday at 3", "tomorrow 10am") into an instant,
 * resolved in the **business** timezone.
 *
 * This is deliberately application code, not model output: the AI may say a
 * caller wants to book, but the time Veyra acts on is parsed and re-checked
 * here, so a hallucinated timestamp can never reach a calendar. Anything this
 * cannot parse confidently returns null, and the caller is asked instead of
 * guessed at.
 *
 * The parse is intentionally narrow. It never resolves a date in the past, and
 * a bare hour with no am/pm is flagged (`assumedMeridiem`) so the confirmation
 * step can spell the full local time back before anything is booked.
 */

export interface ParsedRequestedTime {
  start: Date;
  /** The phrase this came from, kept for the operator-facing record. */
  text: string;
  /** True when "3" was read as 3 PM rather than 3 AM. */
  assumedMeridiem: boolean;
}

const WEEKDAYS: Record<string, number> = {
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
  sunday: 7, sun: 7
};

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
};

interface TimeOfDay {
  hour: number;
  minute: number;
  assumedMeridiem: boolean;
}

function parseTimeOfDay(text: string): TimeOfDay | null {
  // "3pm", "3:30 pm", "15:00", "at 3"
  const explicit = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/);
  if (explicit) {
    const meridiem = explicit[3].startsWith("a") ? "am" : "pm";
    let hour = Number(explicit[1]);
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "pm" && hour !== 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    return { hour, minute: Number(explicit[2] ?? 0), assumedMeridiem: false };
  }

  const twentyFour = text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (twentyFour) {
    const hour = Number(twentyFour[1]);
    const minute = Number(twentyFour[2]);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute, assumedMeridiem: false };
  }

  // A bare hour, only when it is clearly a time ("at 3", "3 o'clock").
  const bare = text.match(/\b(?:at|around|for)\s+(\d{1,2})\b(?!\s*(?:st|nd|rd|th|:|\d))|\b(\d{1,2})\s*o'?clock\b/);
  if (bare) {
    const hour = Number(bare[1] ?? bare[2]);
    if (hour < 1 || hour > 23) return null;
    if (hour >= 13) return { hour, minute: 0, assumedMeridiem: false };
    // 1-7 almost always means the afternoon for an appointment; 8-12 the morning.
    const assumed = hour >= 1 && hour <= 7;
    return { hour: assumed ? hour + 12 : hour, minute: 0, assumedMeridiem: assumed };
  }

  return null;
}

/** Parses a caller phrase into an instant in `timezone`, or null. */
export function parseRequestedTime(
  rawText: string,
  timezone: string,
  now: Date = new Date()
): ParsedRequestedTime | null {
  const text = rawText.toLowerCase();
  const nowLocal = DateTime.fromJSDate(now, { zone: timezone });
  if (!nowLocal.isValid) return null;

  // ISO first: "2026-10-09T11:00" or "2026-10-09 11:00".
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})[t ](\d{2}):(\d{2})\b/);
  if (iso) {
    const start = instantFromLocal(
      {
        year: Number(iso[1]),
        month: Number(iso[2]),
        day: Number(iso[3]),
        hour: Number(iso[4]),
        minute: Number(iso[5])
      },
      timezone
    );
    return start ? { start, text: rawText.trim(), assumedMeridiem: false } : null;
  }

  const time = parseTimeOfDay(text);
  if (!time) return null;

  let day: DateTime | null = null;

  if (/\btoday\b|\bthis afternoon\b|\bthis morning\b/.test(text)) {
    day = nowLocal.startOf("day");
  } else if (/\btomorrow\b/.test(text)) {
    day = nowLocal.startOf("day").plus({ days: 1 });
  } else {
    const weekdayMatch = text.match(
      /\b(monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun)\b/
    );
    if (weekdayMatch) {
      const target = WEEKDAYS[weekdayMatch[1]];
      const nextWeek = /\bnext\b/.test(text);
      let candidate = nowLocal.startOf("day");
      // Always forward: "Tuesday" never means the Tuesday that has passed.
      let guard = 0;
      do {
        candidate = candidate.plus({ days: 1 });
        guard += 1;
      } while (candidate.weekday !== target && guard < 14);
      if (nextWeek) candidate = candidate.plus({ weeks: 1 });
      day = candidate;
    } else {
      // "9 October", "October 9", "on the 9th"
      const monthFirst = text.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})\b/);
      const dayFirst = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/);
      if (monthFirst || dayFirst) {
        const month = MONTHS[(monthFirst?.[1] ?? dayFirst?.[2])!];
        const dayOfMonth = Number(monthFirst?.[2] ?? dayFirst?.[1]);
        let candidate = DateTime.fromObject(
          { year: nowLocal.year, month, day: dayOfMonth },
          { zone: timezone }
        );
        if (!candidate.isValid) return null;
        // A date already past this year means next year.
        if (candidate.startOf("day") < nowLocal.startOf("day")) candidate = candidate.plus({ years: 1 });
        day = candidate.startOf("day");
      }
    }
  }

  if (!day) return null;

  const start = instantFromLocal(
    { year: day.year, month: day.month, day: day.day, hour: time.hour, minute: time.minute },
    timezone
  );
  if (!start) return null;
  // Never resolve into the past; the rules layer decides how much notice is needed.
  if (start.getTime() <= now.getTime()) return null;

  return { start, text: rawText.trim(), assumedMeridiem: time.assumedMeridiem };
}

/** Does this message look like a plain "yes" to a held slot? */
export function isAffirmation(rawText: string): boolean {
  const text = rawText.toLowerCase().trim().replace(/[!.]+$/, "");
  if (/\b(no|not|don't|dont|cancel|change|different|instead)\b/.test(text)) return false;
  return /^(y|ye|yes|yep|yeah|yup|sure|ok|okay|confirm|confirmed|please do|go ahead|sounds good|that works|book it|perfect|great)\b/.test(
    text
  ) || /\b(confirm|book it|go ahead|that works|sounds good)\b/.test(text);
}

/**
 * Does this message ask to MOVE an existing appointment?
 *
 * Deliberately narrow: it needs a rescheduling verb, not merely a date. A
 * caller saying "Wednesday works better for me" has not asked for anything to
 * change, and mentioning a day must never be enough to move a real booking.
 */
export function isRescheduleRequest(rawText: string): boolean {
  const text = rawText.toLowerCase();
  const verb = /\b(reschedul\w*|move|change|switch|push|shift|postpone|bring forward|rearrange)\b/.test(text);
  const target = /\b(appointment|booking|slot|visit|session|it|that|my)\b/.test(text);
  return verb && target && !isCancellationRequest(text);
}

/** Does this message ask to cancel an existing appointment? */
export function isCancellationRequest(rawText: string): boolean {
  const text = rawText.toLowerCase();
  return /\b(cancel|call off|scrap)\b/.test(text) && /\b(appointment|booking|slot|it|that)\b/.test(text);
}
