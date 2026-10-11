import type { Business } from "@prisma/client";
import { type CreateWorkspaceRequest, INDUSTRY_TEMPLATES } from "@veyra/shared";
import { prisma } from "../../db/client.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { createDefaultSubscription } from "../access/accessService.js";
import { recordConfigChange } from "./audit.js";

/**
 * Self-service workspace creation.
 *
 * One transaction creates everything a new business needs and nothing it
 * didn't say: the business itself (in draft, so Reception isn't answering
 * until the owner activates it), the creator's OWNER membership, a Starter
 * subscription, safe booking-rule defaults from the industry template, an
 * onboarding record and an audit entry. No services, FAQs or hours are
 * invented — a new workspace starts genuinely empty.
 */

/** A simple guard against one account spinning up workspaces without limit. */
export const MAX_OWNED_WORKSPACES = 5;

export async function createWorkspace(userId: string, input: CreateWorkspaceRequest): Promise<Business> {
  const owned = await prisma.businessMembership.count({ where: { userId, role: "OWNER" } });
  if (owned >= MAX_OWNED_WORKSPACES) {
    throw new HttpError(409, `An account can own up to ${MAX_OWNED_WORKSPACES} workspaces.`);
  }

  const template = INDUSTRY_TEMPLATES[input.industry];

  return prisma.$transaction(async (tx) => {
    const business = await tx.business.create({
      data: {
        name: input.name.trim(),
        industry: input.industry,
        timezone: input.timezone,
        contactEmail: input.email.trim().toLowerCase(),
        contactPhone: input.phone.trim(),
        website: input.website?.trim() || null,
        location: input.address?.trim() ?? "",
        description: "",
        greeting: `Thanks for contacting ${input.name.trim()}. How can I help you today?`,
        // Structured hours drive what Reception says; nothing is assumed.
        hours: "",
        // Not answering until the owner reviews and activates it.
        receptionStatus: "draft",
        receptionStatusChangedAt: new Date(),
        // Capabilities: the safe core only. Live calendar is off until the
        // plan includes it and the owner connects one.
        capBookingRequests: true,
        capHumanEscalation: true,
        capCalendarBooking: false,
        capWhatsapp: false,
        capSms: false,
        capEmailNotifications: false,
        // Safe starting rules from the template — editable, and not facts.
        minNoticeMinutes: template.bookingDefaults.minNoticeMinutes,
        maxHorizonDays: template.bookingDefaults.maxHorizonDays,
        slotIntervalMinutes: template.bookingDefaults.slotIntervalMinutes,
        bufferAfterMinutes: template.bookingDefaults.bufferAfterMinutes,
        bufferBeforeMinutes: 0
      }
    });

    await tx.businessMembership.create({ data: { userId, businessId: business.id, role: "OWNER" } });
    await createDefaultSubscription(business.id, tx);
    await tx.onboardingProgress.create({ data: { businessId: business.id } });
    await recordConfigChange(
      {
        businessId: business.id,
        actorUserId: userId,
        entityType: "workspace",
        entityId: business.id,
        changeType: "created",
        changedFields: ["name", "industry", "timezone", "contactEmail", "contactPhone"]
      },
      tx
    );

    return business;
  });
}
