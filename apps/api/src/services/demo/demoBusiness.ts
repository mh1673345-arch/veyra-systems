import type { DemoBusinessInfo } from "@veyra/shared";
import { prisma } from "../../db/client.js";
import { currentEnvironment } from "../../config/database.js";

/**
 * Which business the public Reception demo talks to.
 *
 * The demo used to open whichever business was created most recently, which
 * meant any throwaway workspace — a test signup, a half-finished onboarding —
 * silently became the thing prospects saw. That is the bug this fixes.
 *
 * Resolution order:
 *
 *   1. VEYRA_DEMO_BUSINESS_ID, if it names a business that exists. Pinned:
 *      nothing a user creates can displace it.
 *   2. Otherwise the OLDEST business that is actually presentable — live
 *      Reception with at least one service. Oldest, not newest, so a new
 *      workspace can never take the demo over by being new.
 *   3. Otherwise nothing, and the demo page says so rather than improvising.
 */

export interface DemoResolution extends DemoBusinessInfo {
  /** True when this deployment is running the configured demo business. */
  demoMode: boolean;
}

export function configuredDemoBusinessId(env: NodeJS.ProcessEnv = process.env): string | null {
  const id = env.VEYRA_DEMO_BUSINESS_ID?.trim();
  return id ? id : null;
}

export async function resolveDemoBusiness(env: NodeJS.ProcessEnv = process.env): Promise<DemoResolution> {
  const configured = configuredDemoBusinessId(env);

  if (configured) {
    const pinned = await prisma.business.findUnique({ where: { id: configured }, select: { id: true, name: true } });
    if (pinned) {
      return { businessId: pinned.id, name: pinned.name, source: "configured", pinned: true, demoMode: true };
    }
    // Configured but missing: say so loudly in the log rather than silently
    // falling back to somebody's real business.
    console.warn("[veyra:demo] VEYRA_DEMO_BUSINESS_ID does not match any business; falling back.");
  }

  const fallback = await prisma.business.findFirst({
    where: { receptionStatus: "active", services: { some: { active: true } } },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true }
  });

  if (!fallback) return { businessId: null, name: null, source: "none", pinned: false, demoMode: false };
  return { businessId: fallback.id, name: fallback.name, source: "fallback", pinned: false, demoMode: false };
}

/** True only for the explicitly configured demo business. */
export async function isDemoBusiness(businessId: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return configuredDemoBusinessId(env) === businessId;
}

export class DemoResetRefused extends Error {}

/**
 * Clears the demo business's conversation history so a presentation starts
 * from a known state. Development only, and never reachable over HTTP — it is
 * called from `npm run demo:reset`.
 *
 * It refuses unless every one of these holds:
 *   - the environment is not production;
 *   - the database is a local development database;
 *   - a demo business is explicitly configured, and the target *is* that one.
 *
 * Configuration (services, FAQs, hours, members, subscription) is left alone,
 * and no other business is touched.
 */
export async function resetDemoBusiness(params: { businessId: string; env?: NodeJS.ProcessEnv }): Promise<{
  businessId: string;
  name: string;
  deleted: Record<string, number>;
}> {
  const env = params.env ?? process.env;

  if (currentEnvironment(env.NODE_ENV) === "production") {
    throw new DemoResetRefused("Refusing to reset demo data in production.");
  }
  const databaseUrl = env.DATABASE_URL ?? "";
  if (!/localhost|127\.0\.0\.1/.test(databaseUrl)) {
    throw new DemoResetRefused("Refusing to reset: DATABASE_URL does not point at a local database.");
  }
  const configured = configuredDemoBusinessId(env);
  if (!configured) {
    throw new DemoResetRefused("Refusing to reset: VEYRA_DEMO_BUSINESS_ID is not set, so there is no demo business.");
  }
  if (configured !== params.businessId) {
    throw new DemoResetRefused("Refusing to reset: that business is not the configured demo business.");
  }

  const business = await prisma.business.findUnique({ where: { id: params.businessId }, select: { id: true, name: true } });
  if (!business) throw new DemoResetRefused("Refusing to reset: the configured demo business does not exist.");

  const where = { businessId: business.id };
  const deleted: Record<string, number> = {};

  await prisma.$transaction(async (tx) => {
    const conversationIds = (await tx.conversation.findMany({ where, select: { id: true } })).map((row) => row.id);

    deleted.knowledgeGaps = (await tx.knowledgeGapSignal.deleteMany({ where })).count;
    deleted.feedback = (await tx.conversationFeedback.deleteMany({ where })).count;
    deleted.pilotIssues = (await tx.pilotIssue.deleteMany({ where })).count;
    deleted.notifications = (await tx.notification.deleteMany({ where })).count;
    deleted.domainEvents = (await tx.domainEvent.deleteMany({ where })).count;
    deleted.statusEvents = (await tx.statusEvent.deleteMany({ where: { ...where, entityType: { in: ["booking", "escalation"] } } })).count;
    deleted.escalations = (await tx.escalation.deleteMany({ where })).count;
    deleted.appointments = (await tx.appointment.deleteMany({ where })).count;
    deleted.messages = (await tx.message.deleteMany({ where: { conversationId: { in: conversationIds } } })).count;
    deleted.conversations = (await tx.conversation.deleteMany({ where })).count;
  });

  return { businessId: business.id, name: business.name, deleted };
}
