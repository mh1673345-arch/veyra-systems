import { Router } from "express";
import { z } from "zod";
import type { Business } from "@veyra/shared";
import { prisma } from "../db/client.js";
import { HttpError } from "../middleware/errorHandler.js";
import { toCapabilities } from "../services/businessContext.js";
import { createDefaultSubscription } from "../services/access/accessService.js";

export const businessesRouter = Router();

const serviceInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  priceLabel: z.string().optional()
});

const faqInputSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1)
});

const capabilitiesSchema = z
  .object({
    booking_requests: z.boolean(),
    calendar_booking: z.boolean(),
    human_escalation: z.boolean(),
    whatsapp: z.boolean(),
    sms: z.boolean(),
    email_notifications: z.boolean()
  })
  .partial();

const createBusinessSchema = z.object({
  name: z.string().min(1),
  capabilities: capabilitiesSchema.optional(),
  description: z.string().min(1).optional(),
  greeting: z.string().min(1).optional(),
  hours: z.string().min(1).optional(),
  location: z.string().min(1).optional(),
  contactPhone: z.string().min(1).optional(),
  contactEmail: z.string().min(1).optional(),
  bookingRules: z.string().min(1).optional(),
  escalationRules: z.string().min(1).optional(),
  services: z.array(serviceInputSchema).optional(),
  faqs: z.array(faqInputSchema).optional()
});

type BusinessWithRelations = {
  id: string;
  name: string;
  description: string;
  greeting: string;
  hours: string;
  location: string;
  contactPhone: string | null;
  contactEmail: string | null;
  bookingRules: string;
  escalationRules: string;
  capBookingRequests: boolean;
  capCalendarBooking: boolean;
  capHumanEscalation: boolean;
  capWhatsapp: boolean;
  capSms: boolean;
  capEmailNotifications: boolean;
  createdAt: Date;
  services: { id: string; name: string; description: string; priceLabel: string }[];
  faqs: { id: string; question: string; answer: string }[];
};

function toBusinessDto(business: BusinessWithRelations): Business {
  return {
    id: business.id,
    name: business.name,
    description: business.description,
    greeting: business.greeting,
    hours: business.hours,
    location: business.location,
    contactPhone: business.contactPhone,
    contactEmail: business.contactEmail,
    bookingRules: business.bookingRules,
    escalationRules: business.escalationRules,
    capabilities: toCapabilities(business),
    services: business.services.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      priceLabel: s.priceLabel
    })),
    faqs: business.faqs.map((f) => ({ id: f.id, question: f.question, answer: f.answer })),
    createdAt: business.createdAt.toISOString()
  };
}

const withRelations = { services: true, faqs: true } as const;

businessesRouter.get("/businesses", async (_req, res) => {
  const businesses = await prisma.business.findMany({
    orderBy: { createdAt: "desc" },
    include: withRelations
  });
  res.json(businesses.map(toBusinessDto));
});

businessesRouter.post("/businesses", async (req, res, next) => {
  try {
    const parsed = createBusinessSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    const data = parsed.data;
    const business = await prisma.business.create({
      data: {
        name: data.name,
        ...(data.description ? { description: data.description } : {}),
        ...(data.greeting ? { greeting: data.greeting } : {}),
        ...(data.hours ? { hours: data.hours } : {}),
        ...(data.location ? { location: data.location } : {}),
        ...(data.contactPhone ? { contactPhone: data.contactPhone } : {}),
        ...(data.contactEmail ? { contactEmail: data.contactEmail } : {}),
        ...(data.bookingRules ? { bookingRules: data.bookingRules } : {}),
        ...(data.escalationRules ? { escalationRules: data.escalationRules } : {}),
        ...(data.capabilities?.booking_requests !== undefined
          ? { capBookingRequests: data.capabilities.booking_requests }
          : {}),
        ...(data.capabilities?.calendar_booking !== undefined
          ? { capCalendarBooking: data.capabilities.calendar_booking }
          : {}),
        ...(data.capabilities?.human_escalation !== undefined
          ? { capHumanEscalation: data.capabilities.human_escalation }
          : {}),
        ...(data.capabilities?.whatsapp !== undefined
          ? { capWhatsapp: data.capabilities.whatsapp }
          : {}),
        ...(data.capabilities?.sms !== undefined ? { capSms: data.capabilities.sms } : {}),
        ...(data.capabilities?.email_notifications !== undefined
          ? { capEmailNotifications: data.capabilities.email_notifications }
          : {}),
        ...(data.services && data.services.length > 0
          ? {
              services: {
                create: data.services.map((s) => ({
                  name: s.name,
                  description: s.description ?? "",
                  priceLabel: s.priceLabel ?? ""
                }))
              }
            }
          : {}),
        ...(data.faqs && data.faqs.length > 0
          ? { faqs: { create: data.faqs.map((f) => ({ question: f.question, answer: f.answer })) } }
          : {})
      },
      include: withRelations
    });

    // Every business has a subscription; new ones start on Starter.
    await createDefaultSubscription(business.id);

    res.status(201).json(toBusinessDto(business));
  } catch (err) {
    next(err);
  }
});

businessesRouter.get("/businesses/:id", async (req, res, next) => {
  try {
    const business = await prisma.business.findUnique({
      where: { id: req.params.id },
      include: withRelations
    });
    if (!business) {
      throw new HttpError(404, "Business not found");
    }
    res.json(toBusinessDto(business));
  } catch (err) {
    next(err);
  }
});
