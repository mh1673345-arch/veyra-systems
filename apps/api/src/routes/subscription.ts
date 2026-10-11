import { Router } from "express";
import {
  ENTITLEMENT_DEFINITIONS,
  type OpsPlanSummary,
  type OpsSubscription,
  PLAN_CATALOG,
  PLAN_ORDER,
  type PlanCode,
  lowestPlanWith
} from "@veyra/shared";
import { prisma } from "../db/client.js";
import { HttpError } from "../middleware/errorHandler.js";
import { requireAuth, requireBusinessPermission } from "../middleware/auth.js";
import { accessFor, limitUsage } from "../services/access/accessService.js";
import { roleHasPermission } from "../services/auth/permissions.js";
import { billingOverview } from "../services/billing/billingService.js";

export const subscriptionRouter = Router();

/**
 * The business's subscription and billing state as the Console shows it.
 * Read-only.
 *
 * No route sets a plan directly. A plan changes only when the payment
 * provider's verified webhook says so (services/billing/lifecycle.ts), or by
 * the admin script — so no member can grant themselves a higher plan.
 * Everything below is computed from the same catalog AccessService enforces.
 */

function planSummary(code: PlanCode): OpsPlanSummary {
  const plan = PLAN_CATALOG[code];
  return {
    code: plan.code,
    name: plan.name,
    tagline: plan.tagline,
    description: plan.description,
    entitlements: [...plan.entitlements],
    limits: plan.limits
  };
}

subscriptionRouter.get(
  "/ops/businesses/:businessId/subscription",
  requireAuth,
  requireBusinessPermission("subscription:read"),
  async (req, res, next) => {
    try {
      const business = await prisma.business.findUnique({
        where: { id: req.params.businessId },
        select: { id: true, name: true }
      });
      if (!business) throw new HttpError(404, "Business not found");

      const access = await accessFor(business.id);
      const subscription = access.subscription;
      const billing = await billingOverview(business.id, roleHasPermission(req.membership!.role, "billing:manage"));

      const body: OpsSubscription = {
        businessId: business.id,
        businessName: business.name,
        plan: access.plan ? planSummary(access.plan) : null,
        status: access.status,
        degraded: access.degraded,
        billingAttention: access.billingAttention,
        startsAt: subscription?.startsAt.toISOString() ?? null,
        currentPeriodStart: subscription?.currentPeriodStart?.toISOString() ?? null,
        currentPeriodEnd: subscription?.currentPeriodEnd?.toISOString() ?? null,
        trialEndsAt: subscription?.trialEndsAt?.toISOString() ?? null,
        cancelledAt: subscription?.cancelledAt?.toISOString() ?? null,
        entitlements: ENTITLEMENT_DEFINITIONS.map((definition) => ({
          key: definition.key,
          label: definition.label,
          description: definition.description,
          group: definition.group,
          implemented: definition.implemented,
          included: access.entitlements.has(definition.key),
          requiredPlan: lowestPlanWith(definition.key)
        })),
        limits: await limitUsage(business.id),
        plans: PLAN_ORDER.map(planSummary),
        billingAvailable: billing.available,
        billing
      };

      res.json(body);
    } catch (err) {
      next(err);
    }
  }
);
