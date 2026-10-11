import type { BusinessCapabilities } from "@veyra/shared";
import { prisma } from "../db/client.js";
import { HttpError } from "../middleware/errorHandler.js";
import type { BusinessContext } from "./ai/types.js";
import { accessFor, effectiveCapabilities } from "./access/accessService.js";
import { summarizeHours } from "./setup/hours.js";
import { TONE_GUIDANCE } from "./ai/presentation.js";

/** Maps the flat capability columns onto the shared capability shape. */
export function toCapabilities(business: {
  capBookingRequests: boolean;
  capCalendarBooking: boolean;
  capHumanEscalation: boolean;
  capWhatsapp: boolean;
  capSms: boolean;
  capEmailNotifications: boolean;
}): BusinessCapabilities {
  return {
    booking_requests: business.capBookingRequests,
    calendar_booking: business.capCalendarBooking,
    human_escalation: business.capHumanEscalation,
    whatsapp: business.capWhatsapp,
    sms: business.capSms,
    email_notifications: business.capEmailNotifications
  };
}

/**
 * Server-side assembly of everything the AI responder is allowed to know
 * about a business, pulled straight from the DB — the prompt never hand-
 * duplicates this data, it just formats what's already configured.
 */
export async function loadBusinessContext(businessId: string): Promise<BusinessContext> {
  // Read fresh on every turn: a change saved in the Console is what the very
  // next caller hears. Only active services and FAQs are ever given to
  // Reception; archived ones stay stored for history.
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: {
      services: { where: { active: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      faqs: { where: { active: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      businessHours: true
    }
  });

  if (!business) {
    throw new HttpError(404, "Business not found");
  }

  return {
    name: business.name,
    description: business.description,
    // The structured schedule is the source of truth when there is one.
    hours: summarizeHours(business.businessHours) || business.hours,
    location: business.location,
    contactPhone: business.contactPhone,
    contactEmail: business.contactEmail,
    bookingRules: business.bookingRules,
    escalationRules: business.escalationRules,
    // What the business configured AND its subscription includes. The raw
    // flag alone can never let the receptionist offer a feature the plan lacks.
    capabilities: effectiveCapabilities(business, await accessFor(business.id)),
    services: business.services.map((s) => ({
      name: s.name,
      description: s.description,
      priceLabel: s.priceNote && s.priceLabel ? `${s.priceLabel} (${s.priceNote})` : s.priceLabel
    })),
    assistantName: business.assistantName,
    tone: business.receptionTone,
    closingStyle: business.closingStyle,
    escalationContact:
      business.escalationPhone || business.escalationEmail
        ? { phone: business.escalationPhone, email: business.escalationEmail }
        : undefined,
    fallbackMessage: business.escalationFallbackMessage,
    faqs: business.faqs.map((f) => ({ question: f.question, answer: f.answer }))
  };
}

export function formatBusinessContextForPrompt(context: BusinessContext): string {
  const lines: string[] = [];

  lines.push(`Business name: ${context.name}`);
  // Presentation comes from fixed choices; the tone's wording is ours, and the
  // assistant name is validated to be a plain name.
  if (context.assistantName) lines.push(`Your name when greeting callers: ${context.assistantName}`);
  lines.push(`Tone: ${TONE_GUIDANCE[context.tone ?? "professional"]}`);
  if (context.description) lines.push(`Description: ${context.description}`);
  lines.push(`Hours: ${context.hours}`);
  if (context.location) lines.push(`Location: ${context.location}`);
  if (context.contactPhone) lines.push(`Phone: ${context.contactPhone}`);
  if (context.contactEmail) lines.push(`Email: ${context.contactEmail}`);

  if (context.services.length > 0) {
    lines.push("Services:");
    for (const service of context.services) {
      const price = service.priceLabel ? ` — ${service.priceLabel}` : "";
      const description = service.description ? `: ${service.description}` : "";
      lines.push(`  - ${service.name}${price}${description}`);
    }
  } else {
    lines.push("Services: none on file.");
  }

  if (context.faqs.length > 0) {
    lines.push("Frequently asked questions:");
    for (const faq of context.faqs) {
      lines.push(`  Q: ${faq.question}`);
      lines.push(`  A: ${faq.answer}`);
    }
  }

  lines.push(`Booking rules: ${context.bookingRules}`);
  lines.push(`Escalation rules: ${context.escalationRules}`);

  const { capabilities } = context;
  lines.push("Capabilities — you may ONLY offer what is marked available:");
  lines.push(
    `  Take an appointment request for staff to review: ${available(capabilities.booking_requests)}`
  );
  lines.push(
    `  Book or confirm a time against a live calendar: ${available(capabilities.calendar_booking)}`
  );
  lines.push(`  Hand over to a human staff member: ${available(capabilities.human_escalation)}`);
  lines.push(`  WhatsApp follow-up: ${available(capabilities.whatsapp)}`);
  lines.push(`  SMS follow-up: ${available(capabilities.sms)}`);
  lines.push(`  Email notifications: ${available(capabilities.email_notifications)}`);

  return lines.join("\n");
}

function available(enabled: boolean): string {
  return enabled ? "AVAILABLE" : "NOT AVAILABLE — never offer this";
}
