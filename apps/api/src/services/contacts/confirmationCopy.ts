import { DateTime } from "luxon";

/**
 * What a confirmation actually says.
 *
 * Every word here is written by hand. The responder never sees these and is
 * never asked to phrase them: a confirmation is a statement of fact about a
 * commitment the business has made, and a model that improvises around a date
 * is a model that eventually gets one wrong.
 *
 * The facts come from the booking record, formatted in the business's own
 * timezone, and nothing is added that the record does not contain.
 */

export type BookingTransition = "confirmed" | "rescheduled" | "cancelled";

export interface ConfirmationFacts {
  businessName: string;
  serviceName: string | null;
  /** The booking's own timezone; times are rendered in it. */
  timezone: string;
  start: Date | null;
  /**
   * Reschedules only: where it moved from, already formatted by the booking
   * lifecycle. Taken from the event payload rather than re-derived, so the
   * customer and the audit trail describe the same move.
   */
  previousLabel?: string | null;
  /** Shown only when the business has configured one. */
  contactPhone?: string | null;
}

export interface ConfirmationCopy {
  /** For email, and the Veyra-side template key for WhatsApp. */
  subject: string;
  /** Plain text. The channel formatter shapes it; it never rewrites it. */
  body: string;
}

/** Veyra's own template keys, mapped to a provider's id by the template layer. */
export const TEMPLATE_KEYS: Record<BookingTransition, string> = {
  confirmed: "booking_confirmed",
  rescheduled: "booking_rescheduled",
  cancelled: "booking_cancelled"
};

/** "9 Oct at 3:00 PM" — short, unambiguous, no weekday padding out an SMS. */
function when(at: Date | null, timezone: string): string | null {
  if (!at) return null;
  return DateTime.fromJSDate(at).setZone(timezone).toFormat("d LLL 'at' h:mm a");
}

/**
 * Whether to name the timezone. Worth the characters only when it is not the
 * one the customer is almost certainly in — which Veyra cannot know — so the
 * rule is simply: include it when the business is not on UTC, where the
 * abbreviation is meaningless anyway.
 */
function zoneSuffix(timezone: string, at: Date | null): string {
  if (!at || timezone === "UTC") return "";
  const abbreviation = DateTime.fromJSDate(at).setZone(timezone).toFormat("ZZZZ");
  return abbreviation ? ` (${abbreviation})` : "";
}

function serviceClause(serviceName: string | null): string {
  return serviceName ? ` Service: ${serviceName}.` : "";
}

export function confirmationCopy(
  transition: BookingTransition,
  facts: ConfirmationFacts
): ConfirmationCopy {
  const at = when(facts.start, facts.timezone);
  const zone = zoneSuffix(facts.timezone, facts.start);
  const previous = facts.previousLabel?.trim() || null;
  const help = facts.contactPhone ? ` Call ${facts.contactPhone} if you need to change it.` : "";

  switch (transition) {
    case "confirmed":
      return {
        subject: `Your appointment with ${facts.businessName} is confirmed`,
        body:
          `Your appointment with ${facts.businessName} is confirmed for ${at ?? "the agreed time"}${zone}.` +
          serviceClause(facts.serviceName) +
          help
      };

    case "rescheduled":
      return {
        subject: `Your appointment with ${facts.businessName} has moved`,
        body:
          `Your appointment with ${facts.businessName} has moved` +
          (previous ? ` from ${previous}` : "") +
          ` to ${at ?? "a new time"}${zone}.` +
          serviceClause(facts.serviceName) +
          help
      };

    case "cancelled":
      return {
        subject: `Your appointment with ${facts.businessName} is cancelled`,
        body:
          `Your appointment with ${facts.businessName}` +
          (at ? ` on ${at}${zone}` : "") +
          ` is cancelled.` +
          serviceClause(facts.serviceName) +
          (facts.contactPhone ? ` Call ${facts.contactPhone} to rebook.` : "")
      };
  }
}

/**
 * The variables an approved WhatsApp template is filled with. Deliberately
 * the same facts as the free-form copy, so the two cannot drift into saying
 * different things about the same booking.
 */
export function templateVariables(
  transition: BookingTransition,
  facts: ConfirmationFacts
): Record<string, string> {
  return {
    business: facts.businessName,
    service: facts.serviceName ?? "your appointment",
    when: when(facts.start, facts.timezone) ?? "the agreed time",
    previous: facts.previousLabel?.trim() ?? "",
    body: confirmationCopy(transition, facts).body
  };
}
