import type { Prisma, Subscription } from "@prisma/client";
import {
  type BusinessCapabilities,
  DEGRADED_ENTITLEMENTS,
  type Entitlement,
  FULL_ACCESS_STATUSES,
  LIMIT_DEFINITIONS,
  type LimitKey,
  type LimitValue,
  type OpsLimitUsage,
  PLAN_CATALOG,
  PLAN_ORDER,
  type PlanCode,
  isRolloutEntitlement,
  type SubscriptionStatus,
  lowestPlanWith
} from "@veyra/shared";
import { prisma } from "../../db/client.js";
import { HttpError } from "../../middleware/errorHandler.js";

/**
 * AccessService — the one place that decides what a business may use.
 *
 *   Business → Subscription → Plan → Entitlements / Limits
 *            → business configuration → runtime health → available
 *
 * Two questions, kept apart on purpose:
 *   ENTITLEMENT:   has this business paid for the feature?        (here)
 *   CONFIGURATION: has this business actually set the feature up? (Business
 *                  capability flags, calendar connection, ...)
 *
 * A feature is available only when both say yes (and the integration is
 * healthy where one is needed). A configuration flag can never grant what the
 * plan does not include, and a plan never switches on something the business
 * hasn't configured.
 *
 * Routes, the action executor and service layers ask this service. Nothing
 * else compares plan codes.
 */

export interface AccessSnapshot {
  businessId: string;
  plan: PlanCode | null;
  status: SubscriptionStatus | "none";
  /** Paid features are off because of the subscription status. */
  degraded: boolean;
  /** Past due: service continues, but the owner needs to know. */
  billingAttention: boolean;
  entitlements: ReadonlySet<Entitlement>;
  subscription: Subscription | null;
}

/** The subscription does not include a feature. Serialised as ENTITLEMENT_REQUIRED. */
export class EntitlementError extends HttpError {
  readonly code = "ENTITLEMENT_REQUIRED";
  constructor(
    readonly entitlement: Entitlement,
    readonly requiredPlan: PlanCode | null
  ) {
    super(
      403,
      requiredPlan
        ? `This feature is available on the ${PLAN_CATALOG[requiredPlan].name} plan.`
        : "This feature is not available on any plan yet."
    );
  }
}

/** Adding one more would exceed a plan limit. Serialised as PLAN_LIMIT_REACHED. */
export class PlanLimitError extends HttpError {
  readonly code = "PLAN_LIMIT_REACHED";
  constructor(
    readonly limit: LimitKey,
    readonly allowed: number,
    readonly requiredPlan: PlanCode | null
  ) {
    super(
      403,
      `Your plan includes ${allowed} ${LIMIT_DEFINITIONS.find((d) => d.key === limit)?.label.toLowerCase() ?? limit}.`
    );
  }
}

/* ------------------------------------------------------------------ *
 * Entitlements
 * ------------------------------------------------------------------ */

export async function getSubscription(businessId: string): Promise<Subscription | null> {
  return prisma.subscription.findUnique({ where: { businessId } });
}

/**
 * Entitlements granted to this business outside any plan.
 *
 * Filtered against ROLLOUT_ENTITLEMENTS on the way out, so a stale or
 * hand-written row naming a paid feature grants nothing. Expired and revoked
 * grants are ignored.
 */
async function activeRolloutGrants(businessId: string): Promise<Entitlement[]> {
  const now = new Date();
  const grants = await prisma.entitlementGrant.findMany({
    where: {
      businessId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
    },
    select: { entitlement: true }
  });

  return grants
    .map((grant) => grant.entitlement as Entitlement)
    .filter((entitlement) => isRolloutEntitlement(entitlement));
}

export async function accessFor(businessId: string): Promise<AccessSnapshot> {
  const subscription = await getSubscription(businessId);

  if (!subscription) {
    // No subscription at all is treated like a lapsed one: core Reception
    // keeps answering, nothing paid is available.
    return {
      businessId,
      plan: null,
      status: "none",
      degraded: true,
      billingAttention: true,
      entitlements: new Set(DEGRADED_ENTITLEMENTS),
      subscription: null
    };
  }

  const plan = subscription.plan as PlanCode;
  const status = subscription.status as SubscriptionStatus;
  const fullAccess = FULL_ACCESS_STATUSES.includes(status);

  const entitlements = new Set<Entitlement>(
    fullAccess ? PLAN_CATALOG[plan].entitlements : DEGRADED_ENTITLEMENTS
  );

  // Rollout grants sit alongside the plan, never inside it. Only entitlements
  // that belong to no plan can be granted this way, and only while the
  // subscription is in good standing — a grant is a rollout decision, not a
  // way to keep paid features running through a lapse.
  if (fullAccess) {
    for (const entitlement of await activeRolloutGrants(businessId)) entitlements.add(entitlement);
  }

  return {
    businessId,
    plan,
    status,
    degraded: !fullAccess,
    billingAttention: status === "past_due" || !fullAccess,
    entitlements,
    subscription
  };
}

export async function hasEntitlement(businessId: string, entitlement: Entitlement): Promise<boolean> {
  return (await accessFor(businessId)).entitlements.has(entitlement);
}

/** Throws ENTITLEMENT_REQUIRED unless the business's current access includes it. */
export async function requireEntitlement(businessId: string, entitlement: Entitlement): Promise<void> {
  if (!(await hasEntitlement(businessId, entitlement))) {
    throw new EntitlementError(entitlement, lowestPlanWith(entitlement));
  }
}

/**
 * Capability flags as the rest of the app should see them: what the business
 * configured AND what its subscription includes. This is what the AI context,
 * the action executor and the Console read — never the raw column.
 */
export function effectiveCapabilities(
  business: {
    capBookingRequests: boolean;
    capCalendarBooking: boolean;
    capHumanEscalation: boolean;
    capWhatsapp: boolean;
    capSms: boolean;
    capEmailNotifications: boolean;
    // Pilot safety controls. Optional so partial callers still compile, and
    // absent means "not restricted" — they can only ever take away.
    allowAutoBooking?: boolean;
    allowEscalation?: boolean;
    allowNotifications?: boolean;
  },
  access: Pick<AccessSnapshot, "entitlements">
): BusinessCapabilities {
  const entitled = (entitlement: Entitlement) => access.entitlements.has(entitlement);
  // Order matters only for readability; every clause must hold. A pilot safety
  // control is ANDed in last precisely so it can never grant anything: if the
  // plan or the configuration says no, the answer is already no.
  const safe = (flag: boolean | undefined) => flag !== false;
  return {
    booking_requests: business.capBookingRequests && entitled("booking_requests"),
    calendar_booking: business.capCalendarBooking && entitled("calendar_booking") && safe(business.allowAutoBooking),
    human_escalation: business.capHumanEscalation && entitled("human_escalation") && safe(business.allowEscalation),
    whatsapp: business.capWhatsapp && entitled("whatsapp"),
    sms: business.capSms && entitled("sms"),
    email_notifications:
      business.capEmailNotifications && entitled("email_notifications") && safe(business.allowNotifications)
  };
}

export async function effectiveCapabilitiesFor(businessId: string): Promise<BusinessCapabilities> {
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) throw new HttpError(404, "Business not found");
  return effectiveCapabilities(business, await accessFor(businessId));
}

/* ------------------------------------------------------------------ *
 * Limits
 * ------------------------------------------------------------------ */

/** Limits in force: the plan's, or Starter's while degraded. */
export async function getPlanLimits(businessId: string): Promise<Record<LimitKey, LimitValue>> {
  const access = await accessFor(businessId);
  const plan = access.plan && !access.degraded ? access.plan : "STARTER";
  return PLAN_CATALOG[plan].limits;
}

/** Real usage where a reliable counter exists. Null means "not tracked", never 0. */
async function currentUsage(businessId: string, access: AccessSnapshot): Promise<Record<LimitKey, number | null>> {
  const periodStart =
    access.subscription?.currentPeriodStart ??
    new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));

  const [teamMembers, conversations, calendarConnections, voiceSeconds] = await Promise.all([
    prisma.businessMembership.count({ where: { businessId } }),
    prisma.conversation.count({ where: { businessId, createdAt: { gte: periodStart } } }),
    prisma.calendarConnection.count({ where: { businessId, status: { not: "disconnected" } } }),
    // Completed calls only: a call still in progress has no duration yet, and
    // counting it as zero would be as wrong as guessing.
    prisma.callSession.aggregate({
      where: { businessId, startedAt: { gte: periodStart }, durationSeconds: { not: null } },
      _sum: { durationSeconds: true }
    })
  ]);

  return {
    team_members: teamMembers,
    monthly_conversations: conversations,
    calendar_connections: calendarConnections,
    // Rounded up, the way carriers bill: a 10-second call is a minute.
    monthly_voice_minutes: Math.ceil((voiceSeconds._sum.durationSeconds ?? 0) / 60),
    // No counter exists yet: reported as unknown rather than a made-up zero.
    business_locations: null
  };
}

export async function limitUsage(businessId: string): Promise<OpsLimitUsage[]> {
  const access = await accessFor(businessId);
  const limits = await getPlanLimits(businessId);
  const usage = await currentUsage(businessId, access);
  return LIMIT_DEFINITIONS.map((definition) => ({
    key: definition.key,
    label: definition.label,
    limit: limits[definition.key],
    used: usage[definition.key],
    enforcement: definition.enforcement
  }));
}

/** The lowest plan whose limit would allow `needed`, for the upgrade hint. */
function lowestPlanAllowing(limit: LimitKey, needed: number): PlanCode | null {
  return (
    PLAN_ORDER.find((plan) => {
      const value = PLAN_CATALOG[plan].limits[limit];
      return value.kind === "unlimited" || value.value >= needed;
    }) ?? null
  );
}

/** Throws PLAN_LIMIT_REACHED if adding `adding` more would exceed the limit. */
export async function assertWithinLimit(
  businessId: string,
  limit: LimitKey,
  adding = 1
): Promise<void> {
  const limits = await getPlanLimits(businessId);
  const value = limits[limit];
  if (value.kind === "unlimited") return;

  const access = await accessFor(businessId);
  const used = (await currentUsage(businessId, access))[limit];
  if (used === null) return; // Not counted yet: never enforced on a guess.

  if (used + adding > value.value) {
    throw new PlanLimitError(limit, value.value, lowestPlanAllowing(limit, used + adding));
  }
}

/* ------------------------------------------------------------------ *
 * Plan changes (development/admin only — no customer-facing route)
 * ------------------------------------------------------------------ */

export interface ChangePlanParams {
  businessId: string;
  plan: PlanCode;
  status?: SubscriptionStatus;
  actorType: "admin_script" | "system" | "billing_provider" | "migration";
  actorUserId?: string | null;
  reason?: string;
  now?: Date;
}

/**
 * Moves a business to a plan and/or status, effective immediately, and audits
 * it. Nothing is deleted on a downgrade: configuration (a calendar connection,
 * for instance) stays stored and simply stops being usable, so upgrading again
 * restores it without reconnecting.
 */
export async function changePlan(
  params: ChangePlanParams,
  /** Join an existing transaction (e.g. workspace creation) instead of opening one. */
  outerTx?: Prisma.TransactionClient
): Promise<Subscription> {
  const now = params.now ?? new Date();
  const client = outerTx ?? prisma;
  const business = await client.business.findUnique({ where: { id: params.businessId }, select: { id: true } });
  if (!business) throw new HttpError(404, "Business not found");

  const run = async (tx: Prisma.TransactionClient) => {
    const existing = await tx.subscription.findUnique({ where: { businessId: params.businessId } });
    const status = params.status ?? (existing?.status as SubscriptionStatus | undefined) ?? "active";

    const data: Prisma.SubscriptionUncheckedUpdateInput = {
      plan: params.plan,
      status,
      cancelledAt: status === "cancelled" ? existing?.cancelledAt ?? now : null
    };

    const subscription = existing
      ? await tx.subscription.update({ where: { id: existing.id }, data })
      : await tx.subscription.create({
          data: {
            businessId: params.businessId,
            plan: params.plan,
            status,
            startsAt: now,
            currentPeriodStart: now,
            cancelledAt: status === "cancelled" ? now : null
          }
        });

    await tx.subscriptionEvent.create({
      data: {
        businessId: params.businessId,
        subscriptionId: subscription.id,
        previousPlan: existing?.plan ?? null,
        newPlan: params.plan,
        previousStatus: existing?.status ?? null,
        newStatus: status,
        actorType: params.actorType,
        actorUserId: params.actorUserId ?? null,
        reason: params.reason ?? null
      }
    });

    return subscription;
  };

  return outerTx ? run(outerTx) : prisma.$transaction(run);
}

/** Every new business starts on Starter, audited like any other change. */
export async function createDefaultSubscription(
  businessId: string,
  tx?: Prisma.TransactionClient
): Promise<Subscription> {
  return changePlan(
    {
      businessId,
      plan: "STARTER",
      status: "active",
      actorType: "system",
      reason: "New business"
    },
    tx
  );
}
