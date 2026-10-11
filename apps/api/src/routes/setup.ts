import { Router } from "express";
import { z } from "zod";
import {
  type BookingSettings,
  type BusinessProfile,
  type ConfigFaq,
  type ConfigService,
  type EscalationSettings,
  type Industry,
  type KnowledgePreview,
  PLAN_CATALOG,
  type ReceptionSettings,
  type ReceptionStatus,
  type WorkingHours,
  isIndustry,
  isOnboardingStep,
  lowestPlanWith
} from "@veyra/shared";
import { prisma } from "../db/client.js";
import { HttpError } from "../middleware/errorHandler.js";
import { requireAuth, requireBusinessPermission } from "../middleware/auth.js";
import { requireCsrfToken } from "../middleware/csrf.js";
import { EntitlementError, accessFor, hasEntitlement } from "../services/access/accessService.js";
import { isValidTimezone } from "../services/calendar/rules.js";
import { calendarStatus } from "../services/calendar/service.js";
import { changedFields, recordConfigChange } from "../services/setup/audit.js";
import { summarizeHours, toWorkingDays, validateWeek } from "../services/setup/hours.js";
import { getOnboardingState, markStep, recordStep } from "../services/setup/onboarding.js";
import { evaluateReadiness } from "../services/setup/readiness.js";
import { createWorkspace } from "../services/setup/workspace.js";

export const setupRouter = Router();

/**
 * Self-service configuration.
 *
 * Every route is business-scoped through requireBusinessPermission (a
 * non-member gets 404, a member without the permission 403), and every
 * resource id is looked up *inside* that business, so one tenant can never
 * reach another's services or FAQs even with a valid id. Reads need
 * settings:read; changes need settings:write (OWNER/ADMIN) plus CSRF.
 *
 * Nothing is cached: Reception reads the database on every turn, so a change
 * saved here is what the next caller hears.
 */

const read = [requireAuth, requireBusinessPermission("settings:read")];
const write = [requireAuth, requireCsrfToken, requireBusinessPermission("settings:write")];

const actor = (req: import("express").Request) => req.auth!.user.id;

/* ------------------------------- validation ------------------------------- */

const phoneSchema = z
  .string()
  .trim()
  .regex(/^[+()0-9 .-]{6,25}$/, "Enter a valid phone number.");
const optionalPhone = z.union([phoneSchema, z.literal(""), z.null()]).optional();
const optionalEmail = z.union([z.string().trim().email("Enter a valid email."), z.literal(""), z.null()]).optional();
const websiteSchema = z
  .union([
    z
      .string()
      .trim()
      .max(200)
      .regex(/^https?:\/\/[^\s]+\.[^\s]+$/i, "Website must start with http:// or https://"),
    z.literal(""),
    z.null()
  ])
  .optional();
const industrySchema = z.string().refine(isIndustry, "Choose an industry.");
const timezoneSchema = z.string().refine(isValidTimezone, "Choose a valid timezone.");

const emptyToNull = (value: string | null | undefined) =>
  value === undefined ? undefined : value === null || value.trim() === "" ? null : value.trim();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid request.");
  return parsed.data;
}

/* ------------------------------- workspace -------------------------------- */

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(2, "Business name is required.").max(120),
  industry: industrySchema,
  timezone: timezoneSchema,
  email: z.string().trim().email("Enter a valid email."),
  phone: phoneSchema,
  website: websiteSchema,
  address: z.string().trim().max(300).optional()
});

/** Any signed-in user may create a workspace; they become its OWNER. */
setupRouter.post("/workspaces", requireAuth, requireCsrfToken, async (req, res, next) => {
  try {
    const input = parse(createWorkspaceSchema, req.body);
    const business = await createWorkspace(actor(req), {
      ...input,
      industry: input.industry as Industry,
      website: input.website ?? undefined
    });
    res.status(201).json({ businessId: business.id, name: business.name, receptionStatus: business.receptionStatus });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------- onboarding ------------------------------- */

setupRouter.get("/ops/businesses/:businessId/onboarding", ...read, async (req, res, next) => {
  try {
    res.json(await getOnboardingState(req.params.businessId));
  } catch (err) {
    next(err);
  }
});

setupRouter.post("/ops/businesses/:businessId/onboarding/steps/:step", ...write, async (req, res, next) => {
  try {
    const step = req.params.step;
    if (!isOnboardingStep(step)) throw new HttpError(404, "Unknown onboarding step.");
    const { action } = parse(z.object({ action: z.enum(["complete", "skip"]) }), req.body);
    res.json(await recordStep(req.params.businessId, step, action));
  } catch (err) {
    next(err);
  }
});

/* -------------------------------- profile --------------------------------- */

async function loadBusiness(businessId: string) {
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) throw new HttpError(404, "Business not found");
  return business;
}

function toProfile(business: Awaited<ReturnType<typeof loadBusiness>>): BusinessProfile {
  return {
    businessId: business.id,
    name: business.name,
    industry: (isIndustry(business.industry) ? business.industry : "general") as Industry,
    timezone: business.timezone,
    contactPhone: business.contactPhone,
    contactEmail: business.contactEmail,
    website: business.website,
    address: business.location,
    description: business.description
  };
}

const profileSchema = z.object({
  name: z.string().trim().min(2, "Business name is required.").max(120).optional(),
  industry: industrySchema.optional(),
  timezone: timezoneSchema.optional(),
  contactPhone: optionalPhone,
  contactEmail: optionalEmail,
  website: websiteSchema,
  address: z.string().trim().max(300).optional(),
  description: z.string().trim().max(1000).optional()
});

setupRouter.get("/ops/businesses/:businessId/profile", ...read, async (req, res, next) => {
  try {
    res.json(toProfile(await loadBusiness(req.params.businessId)));
  } catch (err) {
    next(err);
  }
});

setupRouter.patch("/ops/businesses/:businessId/profile", ...write, async (req, res, next) => {
  try {
    const input = parse(profileSchema, req.body);
    const current = await loadBusiness(req.params.businessId);

    const data = {
      name: input.name,
      industry: input.industry,
      timezone: input.timezone,
      contactPhone: emptyToNull(input.contactPhone),
      contactEmail: emptyToNull(input.contactEmail)?.toLowerCase() ?? emptyToNull(input.contactEmail),
      website: emptyToNull(input.website),
      location: input.address,
      description: input.description
    };
    const fields = changedFields(current as unknown as Record<string, unknown>, data);
    const updated = await prisma.business.update({ where: { id: current.id }, data });

    if (fields.length > 0) {
      await recordConfigChange({
        businessId: current.id,
        actorUserId: actor(req),
        entityType: "business_profile",
        entityId: current.id,
        changeType: "updated",
        changedFields: fields
      });
    }
    res.json(toProfile(updated));
  } catch (err) {
    next(err);
  }
});

/* -------------------------------- services -------------------------------- */

const serviceSchema = z.object({
  name: z.string().trim().min(1, "Service name is required.").max(120),
  description: z.string().trim().max(500).optional(),
  price: z.string().trim().max(60).optional(),
  priceNote: z.union([z.string().trim().max(120), z.null()]).optional(),
  durationMinutes: z.union([z.number().int().min(5).max(24 * 60), z.null()]).optional(),
  bookable: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional()
});

async function serviceDtos(businessId: string): Promise<ConfigService[]> {
  const services = await prisma.service.findMany({
    where: { businessId },
    orderBy: [{ active: "desc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
    include: { _count: { select: { appointments: true } } }
  });
  return services.map((service) => ({
    id: service.id,
    name: service.name,
    description: service.description,
    price: service.priceLabel,
    priceNote: service.priceNote,
    durationMinutes: service.durationMinutes,
    bookable: service.bookable,
    active: service.active,
    sortOrder: service.sortOrder,
    bookingCount: service._count.appointments
  }));
}

/** Looks a service up inside the business: another tenant's id is simply not found. */
async function scopedService(businessId: string, serviceId: string) {
  const service = await prisma.service.findFirst({ where: { id: serviceId, businessId } });
  if (!service) throw new HttpError(404, "Service not found");
  return service;
}

setupRouter.get("/ops/businesses/:businessId/services", ...read, async (req, res, next) => {
  try {
    res.json({ services: await serviceDtos(req.params.businessId) });
  } catch (err) {
    next(err);
  }
});

setupRouter.post("/ops/businesses/:businessId/services", ...write, async (req, res, next) => {
  try {
    const input = parse(serviceSchema, req.body);
    const businessId = req.params.businessId;
    const count = await prisma.service.count({ where: { businessId } });
    const service = await prisma.service.create({
      data: {
        businessId,
        name: input.name,
        description: input.description ?? "",
        priceLabel: input.price ?? "",
        priceNote: input.priceNote ?? null,
        durationMinutes: input.durationMinutes ?? null,
        bookable: input.bookable ?? true,
        sortOrder: input.sortOrder ?? count
      }
    });
    await recordConfigChange({
      businessId,
      actorUserId: actor(req),
      entityType: "service",
      entityId: service.id,
      changeType: "created",
      changedFields: Object.keys(input)
    });
    res.status(201).json({ services: await serviceDtos(businessId) });
  } catch (err) {
    next(err);
  }
});

setupRouter.patch("/ops/businesses/:businessId/services/:serviceId", ...write, async (req, res, next) => {
  try {
    const input = parse(serviceSchema.partial(), req.body);
    const businessId = req.params.businessId;
    const current = await scopedService(businessId, req.params.serviceId);
    const data = {
      name: input.name,
      description: input.description,
      priceLabel: input.price,
      priceNote: input.priceNote,
      durationMinutes: input.durationMinutes,
      bookable: input.bookable,
      sortOrder: input.sortOrder
    };
    const fields = changedFields(current as unknown as Record<string, unknown>, data);
    await prisma.service.update({ where: { id: current.id }, data });
    if (fields.length > 0) {
      await recordConfigChange({
        businessId,
        actorUserId: actor(req),
        entityType: "service",
        entityId: current.id,
        changeType: "updated",
        changedFields: fields
      });
    }
    res.json({ services: await serviceDtos(businessId) });
  } catch (err) {
    next(err);
  }
});

/**
 * Archive, never delete: a service that past bookings refer to must keep
 * existing so those bookings stay intact. Archived services disappear from
 * Reception immediately.
 */
for (const [path, active, changeType] of [
  ["archive", false, "archived"],
  ["restore", true, "restored"]
] as const) {
  setupRouter.post(`/ops/businesses/:businessId/services/:serviceId/${path}`, ...write, async (req, res, next) => {
    try {
      const businessId = req.params.businessId;
      const current = await scopedService(businessId, req.params.serviceId);
      if (current.active !== active) {
        await prisma.service.update({ where: { id: current.id }, data: { active } });
        await recordConfigChange({
          businessId,
          actorUserId: actor(req),
          entityType: "service",
          entityId: current.id,
          changeType,
          changedFields: ["active"]
        });
      }
      res.json({ services: await serviceDtos(businessId) });
    } catch (err) {
      next(err);
    }
  });
}

/* ---------------------------------- FAQs ---------------------------------- */

const faqSchema = z.object({
  question: z.string().trim().min(3, "Write the question.").max(300),
  // An FAQ without an answer would have Reception say nothing useful; the
  // business must supply it — templates never do.
  answer: z.string().trim().min(1, "Write the answer.").max(2000),
  category: z.union([z.string().trim().max(60), z.null()]).optional()
});

async function faqDtos(businessId: string): Promise<ConfigFaq[]> {
  const faqs = await prisma.faq.findMany({
    where: { businessId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }]
  });
  return faqs.map((faq) => ({
    id: faq.id,
    question: faq.question,
    answer: faq.answer,
    category: faq.category,
    active: faq.active,
    sortOrder: faq.sortOrder
  }));
}

async function scopedFaq(businessId: string, faqId: string) {
  const faq = await prisma.faq.findFirst({ where: { id: faqId, businessId } });
  if (!faq) throw new HttpError(404, "FAQ not found");
  return faq;
}

setupRouter.get("/ops/businesses/:businessId/faqs", ...read, async (req, res, next) => {
  try {
    res.json({ faqs: await faqDtos(req.params.businessId) });
  } catch (err) {
    next(err);
  }
});

setupRouter.post("/ops/businesses/:businessId/faqs", ...write, async (req, res, next) => {
  try {
    const input = parse(faqSchema, req.body);
    const businessId = req.params.businessId;
    const count = await prisma.faq.count({ where: { businessId } });
    const faq = await prisma.faq.create({
      data: {
        businessId,
        question: input.question,
        answer: input.answer,
        category: emptyToNull(input.category ?? null) ?? null,
        sortOrder: count
      }
    });
    await recordConfigChange({
      businessId,
      actorUserId: actor(req),
      entityType: "faq",
      entityId: faq.id,
      changeType: "created",
      changedFields: Object.keys(input)
    });
    res.status(201).json({ faqs: await faqDtos(businessId) });
  } catch (err) {
    next(err);
  }
});

setupRouter.patch("/ops/businesses/:businessId/faqs/:faqId", ...write, async (req, res, next) => {
  try {
    const input = parse(faqSchema.partial(), req.body);
    const businessId = req.params.businessId;
    const current = await scopedFaq(businessId, req.params.faqId);
    const data = {
      question: input.question,
      answer: input.answer,
      category: input.category === undefined ? undefined : emptyToNull(input.category)
    };
    const fields = changedFields(current as unknown as Record<string, unknown>, data);
    await prisma.faq.update({ where: { id: current.id }, data });
    if (fields.length > 0) {
      await recordConfigChange({
        businessId,
        actorUserId: actor(req),
        entityType: "faq",
        entityId: current.id,
        changeType: "updated",
        changedFields: fields
      });
    }
    res.json({ faqs: await faqDtos(businessId) });
  } catch (err) {
    next(err);
  }
});

for (const [path, active, changeType] of [
  ["disable", false, "disabled"],
  ["enable", true, "enabled"]
] as const) {
  setupRouter.post(`/ops/businesses/:businessId/faqs/:faqId/${path}`, ...write, async (req, res, next) => {
    try {
      const businessId = req.params.businessId;
      const current = await scopedFaq(businessId, req.params.faqId);
      if (current.active !== active) {
        await prisma.faq.update({ where: { id: current.id }, data: { active } });
        await recordConfigChange({
          businessId,
          actorUserId: actor(req),
          entityType: "faq",
          entityId: current.id,
          changeType,
          changedFields: ["active"]
        });
      }
      res.json({ faqs: await faqDtos(businessId) });
    } catch (err) {
      next(err);
    }
  });
}

setupRouter.post("/ops/businesses/:businessId/faqs/reorder", ...write, async (req, res, next) => {
  try {
    const { ids } = parse(z.object({ ids: z.array(z.string()).max(500) }), req.body);
    const businessId = req.params.businessId;
    const owned = await prisma.faq.findMany({ where: { businessId }, select: { id: true } });
    const ownedIds = new Set(owned.map((faq) => faq.id));
    // Every id must belong to this business, and every FAQ must be listed once.
    if (ids.length !== ownedIds.size || new Set(ids).size !== ids.length || !ids.every((id) => ownedIds.has(id))) {
      throw new HttpError(400, "Reorder must list each of this business's FAQs exactly once.");
    }
    await prisma.$transaction(ids.map((id, index) => prisma.faq.update({ where: { id }, data: { sortOrder: index } })));
    await recordConfigChange({ businessId, actorUserId: actor(req), entityType: "faq", changeType: "reordered" });
    res.json({ faqs: await faqDtos(businessId) });
  } catch (err) {
    next(err);
  }
});

/* --------------------------------- hours ---------------------------------- */

const hoursSchema = z.object({
  days: z
    .array(
      z.object({
        dayOfWeek: z.number().int(),
        periods: z.array(z.object({ opens: z.string(), closes: z.string() })).max(6),
        bookable: z.boolean()
      })
    )
    .max(7)
});

async function workingHours(businessId: string): Promise<WorkingHours> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { timezone: true, businessHours: true }
  });
  if (!business) throw new HttpError(404, "Business not found");
  return { timezone: business.timezone, days: toWorkingDays(business.businessHours) };
}

setupRouter.get("/ops/businesses/:businessId/hours", ...read, async (req, res, next) => {
  try {
    res.json(await workingHours(req.params.businessId));
  } catch (err) {
    next(err);
  }
});

/** Replaces the whole week in one transaction, after validating every period. */
setupRouter.put("/ops/businesses/:businessId/hours", ...write, async (req, res, next) => {
  try {
    const input = parse(hoursSchema, req.body);
    const rows = validateWeek(input.days);
    const businessId = req.params.businessId;

    await prisma.$transaction([
      prisma.businessHour.deleteMany({ where: { businessId } }),
      prisma.businessHour.createMany({ data: rows.map((row) => ({ ...row, businessId })) }),
      // Keep the legacy free-text summary in step for anything still reading it.
      prisma.business.update({ where: { id: businessId }, data: { hours: summarizeHours(rows) } })
    ]);
    await recordConfigChange({
      businessId,
      actorUserId: actor(req),
      entityType: "working_hours",
      changeType: "replaced",
      changedFields: ["days"]
    });
    res.json(await workingHours(businessId));
  } catch (err) {
    next(err);
  }
});

/* ---------------------------- booking settings ---------------------------- */

const bookingSchema = z.object({
  bookingRequestsEnabled: z.boolean().optional(),
  minNoticeMinutes: z.number().int().min(0).max(30 * 24 * 60).optional(),
  maxHorizonDays: z.number().int().min(1).max(365).optional(),
  slotIntervalMinutes: z.number().int().refine((value) => [5, 10, 15, 20, 30, 60].includes(value), "Choose a slot interval of 5, 10, 15, 20, 30 or 60 minutes.").optional(),
  bufferBeforeMinutes: z.number().int().min(0).max(240).optional(),
  bufferAfterMinutes: z.number().int().min(0).max(240).optional(),
  calendarBookingEnabled: z.boolean().optional()
});

async function bookingSettings(businessId: string): Promise<BookingSettings> {
  const business = await loadBusiness(businessId);
  const entitled = await hasEntitlement(businessId, "calendar_booking");
  return {
    bookingRequestsEnabled: business.capBookingRequests,
    minNoticeMinutes: business.minNoticeMinutes,
    maxHorizonDays: business.maxHorizonDays,
    slotIntervalMinutes: business.slotIntervalMinutes,
    bufferBeforeMinutes: business.bufferBeforeMinutes,
    bufferAfterMinutes: business.bufferAfterMinutes,
    calendarBookingEnabled: business.capCalendarBooking,
    calendarEntitled: entitled,
    calendarRequiredPlan: lowestPlanWith("calendar_booking")
  };
}

setupRouter.get("/ops/businesses/:businessId/booking-settings", ...read, async (req, res, next) => {
  try {
    res.json(await bookingSettings(req.params.businessId));
  } catch (err) {
    next(err);
  }
});

setupRouter.patch("/ops/businesses/:businessId/booking-settings", ...write, async (req, res, next) => {
  try {
    const input = parse(bookingSchema, req.body);
    const businessId = req.params.businessId;

    // Switching live calendar on is a paid feature: enforced here, whatever
    // the Console shows. Switching it off is always allowed.
    if (input.calendarBookingEnabled === true && !(await hasEntitlement(businessId, "calendar_booking"))) {
      throw new EntitlementError("calendar_booking", lowestPlanWith("calendar_booking"));
    }

    const current = await loadBusiness(businessId);
    const data = {
      capBookingRequests: input.bookingRequestsEnabled,
      minNoticeMinutes: input.minNoticeMinutes,
      maxHorizonDays: input.maxHorizonDays,
      slotIntervalMinutes: input.slotIntervalMinutes,
      bufferBeforeMinutes: input.bufferBeforeMinutes,
      bufferAfterMinutes: input.bufferAfterMinutes,
      capCalendarBooking: input.calendarBookingEnabled
    };
    const fields = changedFields(current as unknown as Record<string, unknown>, data);
    await prisma.business.update({ where: { id: businessId }, data });
    if (fields.length > 0) {
      await recordConfigChange({
        businessId,
        actorUserId: actor(req),
        entityType: "booking_settings",
        changeType: "updated",
        changedFields: fields
      });
    }
    res.json(await bookingSettings(businessId));
  } catch (err) {
    next(err);
  }
});

/* --------------------------- escalation settings -------------------------- */

const escalationSchema = z.object({
  humanEscalationEnabled: z.boolean().optional(),
  escalationPhone: optionalPhone,
  escalationEmail: optionalEmail,
  fallbackMessage: z.union([z.string().trim().max(300), z.null()]).optional()
});

async function escalationSettings(businessId: string): Promise<EscalationSettings> {
  const business = await loadBusiness(businessId);
  return {
    humanEscalationEnabled: business.capHumanEscalation,
    escalationPhone: business.escalationPhone,
    escalationEmail: business.escalationEmail,
    fallbackMessage: business.escalationFallbackMessage
  };
}

setupRouter.get("/ops/businesses/:businessId/escalation-settings", ...read, async (req, res, next) => {
  try {
    res.json(await escalationSettings(req.params.businessId));
  } catch (err) {
    next(err);
  }
});

setupRouter.patch("/ops/businesses/:businessId/escalation-settings", ...write, async (req, res, next) => {
  try {
    const input = parse(escalationSchema, req.body);
    const businessId = req.params.businessId;
    const current = await loadBusiness(businessId);
    const data = {
      capHumanEscalation: input.humanEscalationEnabled,
      escalationPhone: emptyToNull(input.escalationPhone),
      escalationEmail: emptyToNull(input.escalationEmail)?.toLowerCase() ?? emptyToNull(input.escalationEmail),
      escalationFallbackMessage: emptyToNull(input.fallbackMessage)
    };
    const fields = changedFields(current as unknown as Record<string, unknown>, data);
    await prisma.business.update({ where: { id: businessId }, data });
    if (fields.length > 0) {
      await recordConfigChange({
        businessId,
        actorUserId: actor(req),
        entityType: "escalation_settings",
        changeType: "updated",
        changedFields: fields
      });
    }
    res.json(await escalationSettings(businessId));
  } catch (err) {
    next(err);
  }
});

/* ---------------------------- reception settings -------------------------- */

const receptionSchema = z.object({
  // A display name, not an instruction: letters, spaces and simple punctuation only.
  assistantName: z
    .union([
      z
        .string()
        .trim()
        .max(40)
        .regex(/^[\p{L}\p{N} .'-]*$/u, "Use letters, numbers, spaces and simple punctuation only."),
      z.null()
    ])
    .optional(),
  greeting: z.string().trim().min(1, "Write a greeting.").max(240).optional(),
  tone: z.enum(["professional", "warm", "concise", "premium"]).optional(),
  closingStyle: z.enum(["none", "offer_help", "thank_you"]).optional()
});

async function receptionSettings(businessId: string): Promise<ReceptionSettings> {
  const business = await loadBusiness(businessId);
  return {
    status: business.receptionStatus as ReceptionStatus,
    statusChangedAt: business.receptionStatusChangedAt?.toISOString() ?? null,
    assistantName: business.assistantName,
    greeting: business.greeting,
    tone: business.receptionTone,
    closingStyle: business.closingStyle
  };
}

setupRouter.get("/ops/businesses/:businessId/reception-settings", ...read, async (req, res, next) => {
  try {
    res.json(await receptionSettings(req.params.businessId));
  } catch (err) {
    next(err);
  }
});

setupRouter.patch("/ops/businesses/:businessId/reception-settings", ...write, async (req, res, next) => {
  try {
    const input = parse(receptionSchema, req.body);
    const businessId = req.params.businessId;
    const current = await loadBusiness(businessId);
    const data = {
      assistantName: input.assistantName === undefined ? undefined : emptyToNull(input.assistantName),
      greeting: input.greeting,
      receptionTone: input.tone,
      closingStyle: input.closingStyle
    };
    const fields = changedFields(current as unknown as Record<string, unknown>, data);
    await prisma.business.update({ where: { id: businessId }, data });
    if (fields.length > 0) {
      await recordConfigChange({
        businessId,
        actorUserId: actor(req),
        entityType: "reception_settings",
        changeType: "updated",
        changedFields: fields
      });
    }
    res.json(await receptionSettings(businessId));
  } catch (err) {
    next(err);
  }
});

/* ------------------------- readiness and activation ----------------------- */

setupRouter.get("/ops/businesses/:businessId/readiness", ...read, async (req, res, next) => {
  try {
    res.json(await evaluateReadiness(req.params.businessId));
  } catch (err) {
    next(err);
  }
});

/** Activate (or resume) Reception. Refused while any readiness check blocks. */
setupRouter.post("/ops/businesses/:businessId/reception/activate", ...write, async (req, res, next) => {
  try {
    const businessId = req.params.businessId;
    const readiness = await evaluateReadiness(businessId);
    if (!readiness.canActivate) {
      res.status(409).json({
        error: "Reception can't go live until the blocking items are fixed.",
        code: "READINESS_BLOCKED",
        checks: readiness.checks.filter((check) => check.level === "blocking")
      });
      return;
    }

    if (readiness.status !== "active") {
      await prisma.business.update({
        where: { id: businessId },
        data: { receptionStatus: "active", receptionStatusChangedAt: new Date() }
      });
      await recordConfigChange({
        businessId,
        actorUserId: actor(req),
        entityType: "reception_status",
        changeType: "activated",
        changedFields: ["receptionStatus"]
      });
    }
    await markStep(businessId, "review", "complete");
    await markStep(businessId, "go_live", "complete");
    res.json(await receptionSettings(businessId));
  } catch (err) {
    next(err);
  }
});

setupRouter.post("/ops/businesses/:businessId/reception/pause", ...write, async (req, res, next) => {
  try {
    const businessId = req.params.businessId;
    const business = await loadBusiness(businessId);
    if (business.receptionStatus !== "active") {
      throw new HttpError(409, "Only a live Reception can be paused.");
    }
    await prisma.business.update({
      where: { id: businessId },
      data: { receptionStatus: "paused", receptionStatusChangedAt: new Date() }
    });
    await recordConfigChange({
      businessId,
      actorUserId: actor(req),
      entityType: "reception_status",
      changeType: "paused",
      changedFields: ["receptionStatus"]
    });
    res.json(await receptionSettings(businessId));
  } catch (err) {
    next(err);
  }
});

/* ---------------------------- knowledge preview --------------------------- */

/**
 * What Reception knows, as facts — the same data the responder is given, never
 * the system instructions around it.
 */
setupRouter.get("/ops/businesses/:businessId/knowledge", ...read, async (req, res, next) => {
  try {
    const businessId = req.params.businessId;
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      include: {
        services: { where: { active: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        faqs: { where: { active: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        businessHours: true
      }
    });
    if (!business) throw new HttpError(404, "Business not found");

    const access = await accessFor(businessId);
    const calendar = await calendarStatus(businessId);
    const restrictions = [
      ...(!calendar.entitled
        ? [
            `Live calendar booking is available on ${calendar.requiredPlan ? PLAN_CATALOG[calendar.requiredPlan].name : "a higher plan"}.`
          ]
        : []),
      ...(access.degraded ? ["Paid features are paused while the subscription is inactive."] : [])
    ];

    const body: KnowledgePreview = {
      business: {
        name: business.name,
        industry: business.industry,
        description: business.description,
        address: business.location,
        phone: business.contactPhone,
        email: business.contactEmail,
        website: business.website,
        timezone: business.timezone
      },
      presentation: {
        assistantName: business.assistantName,
        greeting: business.greeting,
        tone: business.receptionTone,
        closingStyle: business.closingStyle
      },
      hoursSummary: summarizeHours(business.businessHours) || business.hours,
      services: business.services.map((service) => ({
        name: service.name,
        price: service.priceLabel,
        priceNote: service.priceNote,
        durationMinutes: service.durationMinutes,
        bookable: service.bookable
      })),
      faqs: business.faqs.map((faq) => ({ question: faq.question, answer: faq.answer, category: faq.category })),
      booking: {
        requestsEnabled: business.capBookingRequests,
        liveCalendar: calendar.live,
        minNoticeMinutes: business.minNoticeMinutes,
        maxHorizonDays: business.maxHorizonDays
      },
      escalation: {
        enabled: business.capHumanEscalation,
        phone: business.escalationPhone ?? business.contactPhone,
        email: business.escalationEmail ?? business.contactEmail
      },
      integrations: {
        calendar: calendar.live ? "live" : calendar.entitled ? "not_connected" : "not_in_plan"
      },
      planRestrictions: restrictions,
      status: business.receptionStatus as ReceptionStatus
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});
