import type { PilotReadinessCheck, PilotReadinessReport, ReadinessLevel } from "@veyra/shared";
import { prisma } from "../../db/client.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { accessFor } from "../access/accessService.js";
import { calendarStatus } from "../calendar/service.js";
import { providerHealthSnapshot } from "../ai/telemetry.js";
import { evaluateReadiness } from "../setup/readiness.js";

/**
 * Pilot readiness.
 *
 * Reception readiness asks "can this business go live?". This asks a harder
 * question: "can we put a real customer's phone calls through this and be able
 * to explain, afterwards, what happened?"
 *
 * So it checks the things a pilot review depends on — an owner to talk to, a
 * subscription that grants what the pilot needs, a notification path so nobody
 * misses a handoff, an audit trail that is actually recording — as well as the
 * configuration checks Reception already makes.
 *
 * Optional integrations do not block. A request-only pilot is a perfectly good
 * pilot; it is only when the business has live calendar booking switched on
 * that a healthy calendar connection becomes required.
 */

function worst(checks: PilotReadinessCheck[]): ReadinessLevel {
  if (checks.some((check) => check.level === "blocking")) return "blocking";
  if (checks.some((check) => check.level === "warning")) return "warning";
  return "ready";
}

export async function evaluatePilotReadiness(businessId: string): Promise<PilotReadinessReport> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: {
      services: { where: { active: true }, select: { id: true } },
      faqs: { where: { active: true }, select: { id: true } },
      businessHours: { select: { id: true, bookable: true } },
      memberships: { select: { role: true } }
    }
  });
  if (!business) throw new HttpError(404, "Business not found");

  const [access, calendar, reception] = await Promise.all([
    accessFor(businessId),
    calendarStatus(businessId),
    evaluateReadiness(businessId)
  ]);

  // The pilot needs live booking when the business has switched it on — that
  // is the promise being made to callers.
  const requiresLiveBooking = business.capCalendarBooking;
  const checks: PilotReadinessCheck[] = [];

  // --- Reception is actually answering ---
  checks.push(
    business.receptionStatus === "active"
      ? { key: "reception_live", level: "ready", message: "Reception is live and answering callers." }
      : {
          key: "reception_live",
          level: "blocking",
          message: `Reception is ${business.receptionStatus}, so callers get contact details instead of answers.`,
          hint: "Activate Reception from Business Settings before starting the pilot."
        }
  );

  // --- Someone accountable ---
  const owners = business.memberships.filter((membership) => membership.role === "OWNER").length;
  checks.push(
    owners > 0
      ? { key: "owner", level: "ready", message: `${owners} owner${owners === 1 ? "" : "s"} can act on pilot findings.` }
      : { key: "owner", level: "blocking", message: "No owner on this workspace.", hint: "Invite the business owner as an OWNER member." }
  );

  // --- What Reception can answer from ---
  checks.push(
    business.services.length > 0
      ? { key: "services", level: "ready", message: `${business.services.length} service${business.services.length === 1 ? "" : "s"} on file.` }
      : {
          key: "services",
          level: "blocking",
          message: "No services configured — a pilot would measure Reception failing to answer basic questions.",
          hint: "Add the services this business offers."
        }
  );
  checks.push(
    business.faqs.length > 0
      ? { key: "knowledge", level: "ready", message: `${business.faqs.length} FAQ${business.faqs.length === 1 ? "" : "s"} on file.` }
      : {
          key: "knowledge",
          level: "warning",
          message: "No FAQs yet, so common questions will show up as knowledge gaps.",
          hint: "Add a few FAQs now, or use the pilot's knowledge gaps to decide which to write."
        }
  );
  checks.push(
    business.businessHours.length > 0
      ? { key: "working_hours", level: "ready", message: "Working hours are configured." }
      : {
          key: "working_hours",
          level: requiresLiveBooking ? "blocking" : "warning",
          message: requiresLiveBooking
            ? "Live booking is on but there are no working hours, so no slot can ever be offered."
            : "No working hours set, so Reception can't tell callers when you're open.",
          hint: "Set the weekly schedule."
        }
  );

  // --- Where a handoff goes ---
  const hasEscalationContact = Boolean(business.escalationPhone || business.escalationEmail || business.contactPhone || business.contactEmail);
  checks.push(
    hasEscalationContact
      ? { key: "escalation_contact", level: "ready", message: "Callers who need a person are given a real contact." }
      : {
          key: "escalation_contact",
          level: "blocking",
          message: "No escalation contact, so a caller asking for a person reaches a dead end.",
          hint: "Add an escalation phone number or email."
        }
  );

  // --- Commercial state ---
  if (access.status === "none") {
    checks.push({ key: "subscription", level: "blocking", message: "No subscription on this business.", hint: "Set a plan before running a pilot." });
  } else if (access.degraded) {
    checks.push({
      key: "subscription",
      level: "blocking",
      message: `The subscription is ${access.status}, so paid features are switched off during the pilot.`,
      hint: "Restore the subscription before measuring anything."
    });
  } else if (access.billingAttention) {
    checks.push({ key: "subscription", level: "warning", message: "Payment is overdue. Service continues, but this should be settled during the pilot." });
  } else {
    checks.push({ key: "subscription", level: "ready", message: `${access.plan} subscription is ${access.status}.` });
  }

  // --- Entitlements the pilot actually needs ---
  if (requiresLiveBooking && !access.entitlements.has("calendar_booking")) {
    checks.push({
      key: "entitlements",
      level: "blocking",
      message: "This pilot expects live booking, but the plan doesn't include it.",
      hint: "Upgrade to Pro, or run a request-only pilot with calendar booking switched off."
    });
  } else {
    checks.push({ key: "entitlements", level: "ready", message: "The plan includes everything this pilot needs." });
  }

  // --- Somebody hears about it ---
  const recipients = business.memberships.length;
  if (recipients === 0) {
    checks.push({ key: "notifications", level: "blocking", message: "Nobody would be notified about handoffs or bookings." });
  } else if (!business.allowNotifications) {
    checks.push({
      key: "notifications",
      level: "warning",
      message: "Notifications are switched off by a pilot safety control, so the team won't be alerted.",
      hint: "Turn notifications back on unless the pilot is deliberately silent."
    });
  } else {
    checks.push({
      key: "notifications",
      level: "ready",
      message: `In-app notifications reach ${recipients} member${recipients === 1 ? "" : "s"}.`
    });
  }

  // --- Calendar, only when the pilot needs it ---
  if (!requiresLiveBooking) {
    checks.push({ key: "calendar", level: "ready", message: "Request-only pilot: no calendar connection needed." });
  } else if (calendar.live) {
    checks.push({ key: "calendar", level: "ready", message: "Calendar is connected and live." });
  } else {
    checks.push({
      key: "calendar",
      level: "blocking",
      message: "Live booking is switched on but the calendar isn't usable, so bookings would fail in front of callers.",
      hint: "Connect and select a calendar, or switch live booking off for a request-only pilot."
    });
  }

  // --- Can Reception answer at all right now ---
  const provider = providerHealthSnapshot();
  checks.push(
    provider.degraded
      ? {
          key: "responder",
          level: "warning",
          message: "The AI provider has been failing; Reception is answering deterministically. Callers are still served.",
          hint: "Expect a high fallback rate in the pilot metrics until this clears."
        }
      : {
          key: "responder",
          level: "ready",
          message: process.env.ANTHROPIC_API_KEY
            ? "Reception responder is available."
            : "No AI provider configured — Reception answers deterministically, which is a valid pilot as long as everyone knows."
        }
  );

  // --- Nothing blocking in the ordinary configuration checks ---
  const receptionBlocking = reception.checks.filter((check) => check.level === "blocking");
  checks.push(
    receptionBlocking.length === 0
      ? { key: "configuration", level: "ready", message: "No blocking configuration problems." }
      : {
          key: "configuration",
          level: "blocking",
          message: `${receptionBlocking.length} blocking configuration problem${receptionBlocking.length === 1 ? "" : "s"}: ${receptionBlocking
            .map((check) => check.message)
            .join(" ")}`
        }
  );

  // --- Can we explain what happened afterwards? ---
  // A pilot without an audit trail cannot be reviewed, so this is checked by
  // actually reading the tables rather than assuming they work.
  let auditWorking = true;
  try {
    await Promise.all([
      prisma.configAuditEvent.count({ where: { businessId } }),
      prisma.statusEvent.count({ where: { businessId } })
    ]);
  } catch {
    auditWorking = false;
  }
  checks.push(
    auditWorking
      ? { key: "audit", level: "ready", message: "Audit history is recording." }
      : { key: "audit", level: "blocking", message: "The audit tables can't be read, so pilot activity couldn't be reviewed." }
  );

  const level = worst(checks);
  return {
    businessId,
    canActivate: level !== "blocking",
    requiresLiveBooking,
    level,
    checks
  };
}
