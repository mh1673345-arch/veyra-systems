import type { ReadinessCheck, ReadinessReport, ReceptionStatus } from "@veyra/shared";
import { prisma } from "../../db/client.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { isValidTimezone } from "../calendar/rules.js";
import { calendarStatus } from "../calendar/service.js";

/**
 * Server-side readiness: can this business's Reception go live, and what would
 * make it better?
 *
 *   blocking — Reception would mislead or strand callers; activation refused
 *   warning  — it works, but callers will hit gaps
 *   ready    — nothing to do
 *
 * Only what is essential blocks: a name, a valid timezone and a way for
 * callers to reach the business. Optional features — including a live
 * calendar, which Starter doesn't include — never block going live.
 */
export async function evaluateReadiness(businessId: string): Promise<ReadinessReport> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: {
      services: { where: { active: true } },
      faqs: { where: { active: true } },
      businessHours: true
    }
  });
  if (!business) throw new HttpError(404, "Business not found");

  const checks: ReadinessCheck[] = [];

  // Profile
  if (!business.name.trim()) {
    checks.push({ key: "business_profile", level: "blocking", message: "Add your business name." });
  } else if (!isValidTimezone(business.timezone)) {
    checks.push({ key: "business_profile", level: "blocking", message: "Choose a valid timezone." });
  } else {
    checks.push({ key: "business_profile", level: "ready", message: "Business details are complete." });
  }

  // Contact
  if (!business.contactPhone && !business.contactEmail) {
    checks.push({
      key: "contact_method",
      level: "blocking",
      message: "Add a phone number or email so callers can reach you when Reception can't help."
    });
  } else {
    checks.push({ key: "contact_method", level: "ready", message: "Callers can reach you directly." });
  }

  // Services
  checks.push(
    business.services.length === 0
      ? {
          key: "services",
          level: "warning",
          message: "No services yet — Reception can't tell callers what you offer or what it costs."
        }
      : {
          key: "services",
          level: "ready",
          message: `${business.services.length} service${business.services.length === 1 ? "" : "s"} on offer.`
        }
  );

  // Knowledge
  checks.push(
    business.faqs.length === 0
      ? { key: "knowledge", level: "warning", message: "No FAQs yet — common questions will be passed to your team." }
      : {
          key: "knowledge",
          level: "ready",
          message: `${business.faqs.length} FAQ${business.faqs.length === 1 ? "" : "s"} available.`
        }
  );

  // Hours
  checks.push(
    business.businessHours.length === 0 && !business.hours.trim()
      ? { key: "working_hours", level: "warning", message: "No working hours yet — Reception can't say when you're open." }
      : { key: "working_hours", level: "ready", message: "Working hours are set." }
  );

  // Booking
  const calendar = await calendarStatus(businessId);
  if (calendar.entitled && business.capCalendarBooking && !calendar.live) {
    checks.push({
      key: "booking_configuration",
      level: "warning",
      message: "Live calendar booking is switched on but no calendar is connected — booking requests are used until it is."
    });
  } else if (!business.capBookingRequests && !calendar.live) {
    checks.push({
      key: "booking_configuration",
      level: "warning",
      message: "Booking is switched off — callers can't ask for an appointment."
    });
  } else {
    checks.push({
      key: "booking_configuration",
      level: "ready",
      // A plan without live calendar is not a problem: request-only is a
      // complete way to take bookings.
      message: calendar.live ? "Live calendar booking is on." : "Booking requests go to your team for review."
    });
  }

  // Escalation
  const hasEscalationContact = Boolean(
    business.escalationPhone || business.escalationEmail || business.contactPhone || business.contactEmail
  );
  if (!business.capHumanEscalation) {
    checks.push({
      key: "escalation_configuration",
      level: business.escalationFallbackMessage ? "ready" : "warning",
      message: business.escalationFallbackMessage
        ? "Human handoff is off; callers asking for a person get your fallback message."
        : "Human handoff is off — add a fallback message for callers who ask for a person."
    });
  } else if (!hasEscalationContact) {
    checks.push({
      key: "escalation_configuration",
      level: "warning",
      message: "Handoff is on, but there's no phone or email for your team."
    });
  } else {
    checks.push({ key: "escalation_configuration", level: "ready", message: "Callers can be handed to your team." });
  }

  return {
    businessId,
    canActivate: !checks.some((check) => check.level === "blocking"),
    status: business.receptionStatus as ReceptionStatus,
    checks
  };
}
