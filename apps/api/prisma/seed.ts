import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

/**
 * Development operators. Credentials come from the environment so nothing
 * real is ever committed; the defaults below are obviously-local values and
 * the seed refuses to run outside development.
 */
async function seedOperators(businessId: string) {
  if (process.env.NODE_ENV === "production") {
    console.log("Refusing to seed development users in production.");
    return;
  }

  const password = process.env.VEYRA_DEV_PASSWORD ?? "veyra-dev-password";
  const operators = [
    { email: process.env.VEYRA_DEV_OWNER_EMAIL ?? "owner@smilecare.local", name: "Dev Owner", role: "OWNER" },
    { email: process.env.VEYRA_DEV_OPERATOR_EMAIL ?? "operator@smilecare.local", name: "Dev Operator", role: "OPERATOR" },
    { email: process.env.VEYRA_DEV_VIEWER_EMAIL ?? "viewer@smilecare.local", name: "Dev Viewer", role: "VIEWER" }
  ];

  const passwordHash = await bcrypt.hash(password, 12);

  for (const operator of operators) {
    const user = await prisma.user.upsert({
      where: { email: operator.email.toLowerCase() },
      update: {},
      create: { email: operator.email.toLowerCase(), name: operator.name, passwordHash }
    });

    await prisma.businessMembership.upsert({
      where: { userId_businessId: { userId: user.id, businessId } },
      update: { role: operator.role },
      create: { userId: user.id, businessId, role: operator.role }
    });

    console.log(`Seeded ${operator.role} ${operator.email}`);
  }

  console.log("Sign in at http://localhost:5173/login with the password from VEYRA_DEV_PASSWORD.");
}

/**
 * Demo business used to exercise the AI receptionist with realistic content:
 * services, prices, hours, location, contact info, FAQs, and the rules that
 * get folded into the system prompt. Run with `npm run db:seed -w apps/api`.
 */
async function main() {
  const existing = await prisma.business.findFirst({ where: { name: "SmileCare Dental" } });
  if (existing) {
    console.log(`SmileCare Dental already exists (id=${existing.id}), skipping business seed.`);
    await backfillSmileCareScheduling(existing.id);
    const starterId = await seedStarterBusiness();
    await seedOperators(existing.id);
    // The same dev accounts can open the Starter demo, so both tiers can be
    // compared from one sign-in. Three members is exactly Starter's limit.
    await seedOperators(starterId);
    await ensureDemoPlans(existing.id, starterId);
    return;
  }

  const business = await prisma.business.create({
    data: {
      name: "SmileCare Dental",
      description:
        "A friendly, modern general dentistry practice offering preventive, cosmetic, and restorative care for the whole family.",
      greeting: "Thanks for calling SmileCare Dental, how can I help you today?",
      hours: "Mon-Fri 8am-6pm, Sat 9am-1pm, closed Sundays",
      location: "245 Maple Street, Suite 2, Springfield",
      contactPhone: "(555) 018-2345",
      contactEmail: "hello@smilecaredental.example",
      bookingRules:
        "Appointment requests collected here are not confirmed automatically — a staff member reviews availability and calls or emails back to confirm the exact time.",
      escalationRules:
        "Escalate to staff for: dental emergencies or pain, insurance/billing questions, anything not covered by the services or FAQs on file, or whenever the caller asks for a real person.",

      // What SmileCare can genuinely do today. Channels stay off until they
      // actually exist — the assistant must never offer them.
      capBookingRequests: true,
      // Demo "Growth" business: calendar booking is switched on. It still only
      // goes live once a calendar is actually connected and selected.
      capCalendarBooking: true,
      capHumanEscalation: true,
      capWhatsapp: false,
      capSms: false,
      capEmailNotifications: false,

      // Scheduling. Every calendar calculation for this business happens in
      // this zone, matching the "Springfield" demo address.
      timezone: "America/New_York",
      minNoticeMinutes: 120,
      maxHorizonDays: 60,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 15,
      slotIntervalMinutes: 30,
      // Mon-Fri 8am-6pm, Sat 9am-1pm, closed Sunday — the same hours the
      // receptionist quotes callers.
      businessHours: {
        create: [
          { dayOfWeek: 1, opensMinute: 8 * 60, closesMinute: 18 * 60 },
          { dayOfWeek: 2, opensMinute: 8 * 60, closesMinute: 18 * 60 },
          { dayOfWeek: 3, opensMinute: 8 * 60, closesMinute: 18 * 60 },
          { dayOfWeek: 4, opensMinute: 8 * 60, closesMinute: 18 * 60 },
          { dayOfWeek: 5, opensMinute: 8 * 60, closesMinute: 18 * 60 },
          { dayOfWeek: 6, opensMinute: 9 * 60, closesMinute: 13 * 60 }
        ]
      },

      services: {
        create: [
          {
            name: "Routine cleaning",
            description: "Standard cleaning and checkup, includes a polish and cavity check.",
            priceLabel: "$120",
            durationMinutes: 60
          },
          {
            name: "Teeth whitening",
            description: "In-office professional whitening treatment, about 60 minutes.",
            priceLabel: "$250",
            durationMinutes: 60
          },
          {
            name: "Dental implants",
            description: "Single-tooth implant placement; consultation required before pricing is finalized.",
            priceLabel: "starting at $2,800",
            durationMinutes: 45
          },
          {
            name: "Emergency exam",
            description: "Same-day or next-day exam for pain, injury, or urgent dental issues.",
            priceLabel: "$95",
            durationMinutes: 30
          },
          {
            name: "Invisalign consultation",
            description: "Initial consultation to see if clear aligners are a good fit.",
            priceLabel: "free",
            durationMinutes: 30
          }
        ]
      },
      faqs: {
        create: [
          {
            question: "Do you accept insurance?",
            answer:
              "We accept most major dental insurance plans. Bring your insurance card to your first visit and our front desk will verify your coverage."
          },
          {
            question: "Do you see children?",
            answer: "Yes, we see patients of all ages starting from age 3."
          },
          {
            question: "Is parking available?",
            answer: "Yes, there's free parking directly behind the building."
          },
          {
            question: "What should I bring to my first appointment?",
            answer: "Please bring a photo ID, your insurance card if you have one, and a list of any current medications."
          }
        ]
      }
    },
    include: { services: true, faqs: true }
  });

  console.log(`Seeded SmileCare Dental (id=${business.id}) with ${business.services.length} services and ${business.faqs.length} FAQs.`);

  const starterId = await seedStarterBusiness();
  await seedOperators(business.id);
  await seedOperators(starterId);
  await ensureDemoPlans(business.id, starterId);
}

/**
 * Demo tiers, through the same audited path any plan change takes:
 *   SmileCare Dental     → Pro  (Act: live calendar)
 *   Bright Smile Studio  → Starter (Answer: request-only)
 * Only changes a plan that differs, so re-running the seed doesn't pile up
 * audit rows.
 */
async function ensureDemoPlans(smileCareId: string, starterId: string) {
  const { changePlan, accessFor } = await import("../src/services/access/accessService.js");
  for (const [businessId, plan, label] of [
    [smileCareId, "PRO", "SmileCare Dental"],
    [starterId, "STARTER", "Bright Smile Studio"]
  ] as const) {
    const access = await accessFor(businessId);
    if (access.plan === plan && access.status === "active") {
      console.log(`${label} is already on ${plan}.`);
      continue;
    }
    await changePlan({ businessId, plan, status: "active", actorType: "system", reason: "Demo seed" });
    console.log(`${label} → ${plan}.`);
  }
}

/** SmileCare's demo scheduling config: explicit, never inferred at runtime. */
const SMILECARE_DURATIONS: Record<string, number> = {
  "Routine cleaning": 60,
  "Teeth whitening": 60,
  "Dental implants": 45,
  "Emergency exam": 30,
  "Invisalign consultation": 30
};

/**
 * Brings a SmileCare created before Phase 8 up to date: timezone, hours, rules
 * and demo durations. Only fills what is unset, so it never overwrites a value
 * someone changed by hand.
 */
async function backfillSmileCareScheduling(businessId: string) {
  const business = await prisma.business.findUniqueOrThrow({
    where: { id: businessId },
    include: { services: true, businessHours: true }
  });

  if (business.timezone === "UTC") {
    await prisma.business.update({
      where: { id: businessId },
      data: {
        timezone: "America/New_York",
        capCalendarBooking: true,
        bufferAfterMinutes: 15
      }
    });
    console.log("Backfilled SmileCare timezone (America/New_York) and calendar capability.");
  }

  if (business.businessHours.length === 0) {
    await prisma.businessHour.createMany({
      data: [
        ...[1, 2, 3, 4, 5].map((dayOfWeek) => ({
          businessId,
          dayOfWeek,
          opensMinute: 8 * 60,
          closesMinute: 18 * 60
        })),
        { businessId, dayOfWeek: 6, opensMinute: 9 * 60, closesMinute: 13 * 60 }
      ]
    });
    console.log("Backfilled SmileCare working hours.");
  }

  for (const service of business.services) {
    const duration = SMILECARE_DURATIONS[service.name];
    if (service.durationMinutes === null && duration) {
      await prisma.service.update({ where: { id: service.id }, data: { durationMinutes: duration } });
      console.log(`Backfilled ${service.name}: ${duration} minutes.`);
    }
  }
}

/**
 * A second demo business on the request-only package: booking requests on,
 * calendar booking off. Same code path, different capability — which is the
 * whole Starter/Growth distinction.
 */
async function seedStarterBusiness() {
  const existing = await prisma.business.findFirst({ where: { name: "Bright Smile Studio" } });
  if (existing) {
    console.log(`Bright Smile Studio already exists (id=${existing.id}).`);
    return existing.id;
  }

  const business = await prisma.business.create({
    data: {
      name: "Bright Smile Studio",
      description: "A small independent dental studio on the request-only package.",
      greeting: "Thanks for calling Bright Smile Studio, how can I help?",
      hours: "Mon-Fri 9am-5pm",
      location: "12 High Street, Springfield",
      contactPhone: "(555) 019-7788",
      contactEmail: "hello@brightsmile.example",
      capBookingRequests: true,
      // Starter: no live calendar, so Veyra stays request-only.
      capCalendarBooking: false,
      capHumanEscalation: true,
      timezone: "America/New_York",
      businessHours: {
        create: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
          dayOfWeek,
          opensMinute: 9 * 60,
          closesMinute: 17 * 60
        }))
      },
      services: {
        create: [
          { name: "Routine cleaning", description: "Cleaning and checkup.", priceLabel: "$110", durationMinutes: 60 },
          { name: "Teeth whitening", description: "In-office whitening.", priceLabel: "$240", durationMinutes: 60 }
        ]
      }
    }
  });

  console.log(`Seeded Bright Smile Studio (id=${business.id}) — request-only package.`);
  return business.id;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
