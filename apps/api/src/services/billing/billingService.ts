import type { Subscription } from "@prisma/client";
import {
  LIMIT_DEFINITIONS,
  type OpsBilling,
  type OpsOverLimit,
  PLAN_ORDER,
  type PlanCode,
  isPlanCode
} from "@veyra/shared";
import { prisma } from "../../db/client.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { getPlanLimits, limitUsage } from "../access/accessService.js";
import { configuredPrices, priceForPlan, trialDays } from "./prices.js";
import { billingProvider, configuredProviderName } from "./registry.js";
import { BillingProviderError, type BillingProvider } from "./types.js";

/**
 * What an owner can do with billing, and the calls that do it.
 *
 * Every mutation here asks the provider to change something and returns
 * "pending". None of them touches the Subscription: that only happens in
 * lifecycle.ts when the provider's signed webhook confirms the change. The
 * client only ever names a target plan; the price is looked up server-side.
 */

const PENDING_CHECKOUT_WINDOW_MS = 60 * 60 * 1000;

/** A coded error the Console can act on (e.g. "use the billing portal"). */
export class BillingError extends HttpError {
  constructor(
    status: number,
    readonly code: "BILLING_UNAVAILABLE" | "BILLING_NOT_ALLOWED" | "BILLING_USE_PORTAL" | "BILLING_PROVIDER_ERROR",
    message: string
  ) {
    super(status, message);
  }
}

function consoleOrigin(): string {
  return (process.env.VEYRA_WEB_ORIGIN ?? "http://localhost:5173").split(",")[0].trim();
}

function settingsUrl(businessId: string, query: string): string {
  return `${consoleOrigin()}/dashboard/${businessId}/settings?${query}`;
}

const rank = (plan: PlanCode) => PLAN_ORDER.indexOf(plan);

/** The subscription is a live paid one at the configured provider. */
function paidSubscription(subscription: Subscription | null, provider: BillingProvider | null): subscription is Subscription & {
  externalBillingSubscriptionId: string;
} {
  return Boolean(
    provider &&
      subscription?.externalBillingSubscriptionId &&
      subscription.billingProvider === provider.name &&
      subscription.status !== "cancelled" &&
      subscription.status !== "expired"
  );
}

function requireProvider(): BillingProvider {
  const provider = billingProvider();
  if (!provider) {
    throw new BillingError(503, "BILLING_UNAVAILABLE", "Billing is not set up on this server, so plans can't be bought in the Console yet.");
  }
  return provider;
}

function providerFailure(err: unknown): never {
  if (err instanceof BillingProviderError) {
    if (err.kind === "unsupported") throw new BillingError(409, "BILLING_USE_PORTAL", err.message);
    console.error("[veyra:billing] provider call failed (%s)", err.kind);
    throw new BillingError(502, "BILLING_PROVIDER_ERROR", "The payment provider could not complete that. Nothing was changed — try again.");
  }
  throw err;
}

interface Available {
  checkout: PlanCode[];
  changePlan: PlanCode[];
  portal: boolean;
  cancel: boolean;
  resume: boolean;
}

function availableActions(
  subscription: Subscription | null,
  provider: BillingProvider | null,
  hasCustomer: boolean
): Available {
  const none: Available = { checkout: [], changePlan: [], portal: false, cancel: false, resume: false };
  if (!provider) return none;

  const priced = configuredPrices(provider.name).map((price) => price.plan);
  const currentPlan = subscription?.plan as PlanCode | undefined;

  if (paidSubscription(subscription, provider)) {
    const scheduled = subscription.cancelAtPeriodEnd || subscription.scheduledPlan !== null;
    // Moving to a free Starter is a cancellation at period end.
    const starterFree = !priced.includes("STARTER");
    const changePlan = scheduled
      ? []
      : PLAN_ORDER.filter(
          (plan) => plan !== currentPlan && (priced.includes(plan) || (plan === "STARTER" && starterFree))
        );
    return {
      checkout: [],
      changePlan,
      portal: hasCustomer,
      cancel: !subscription.cancelAtPeriodEnd,
      resume: scheduled
    };
  }

  // No paid subscription: buy a priced plan. On an active plan only upgrades
  // make sense; after a paid plan has lapsed any priced plan can be bought.
  const lapsed = !subscription || subscription.status === "cancelled" || subscription.status === "expired";
  const checkout = priced.filter((plan) => lapsed || !currentPlan || rank(plan) > rank(currentPlan));
  return { ...none, checkout, portal: hasCustomer };
}

async function overLimit(businessId: string): Promise<OpsOverLimit[]> {
  const usage = await limitUsage(businessId);
  const limits = await getPlanLimits(businessId);
  return usage.flatMap((row) => {
    const limit = limits[row.key];
    // Only limits Veyra actually enforces: a stored-but-idle calendar
    // connection on Starter, say, is expected and not a warning.
    if (row.enforcement !== "enforced") return [];
    if (limit.kind !== "count" || row.used === null || row.used <= limit.value) return [];
    const label = LIMIT_DEFINITIONS.find((definition) => definition.key === row.key)?.label ?? row.key;
    return [{ key: row.key, label, used: row.used, allowed: limit.value }];
  });
}

export async function billingOverview(businessId: string, canManage: boolean): Promise<OpsBilling> {
  const provider = billingProvider();
  const [subscription, customer, pending] = await Promise.all([
    prisma.subscription.findUnique({ where: { businessId } }),
    prisma.billingCustomer.findUnique({ where: { businessId } }),
    prisma.billingCheckout.findFirst({
      where: { businessId, status: "open", createdAt: { gte: new Date(Date.now() - PENDING_CHECKOUT_WINDOW_MS) } },
      orderBy: { createdAt: "desc" }
    })
  ]);
  const hasCustomer = Boolean(customer && provider && customer.provider === provider.name);
  const actions = availableActions(subscription, provider, hasCustomer);

  return {
    available: provider !== null,
    provider: configuredProviderName(),
    simulated: provider?.name === "fake",
    prices: configuredPrices(provider?.name ?? null).map(({ providerPriceId: _hidden, ...price }) => price),
    billingInterval: subscription?.billingInterval ?? null,
    hasPaidSubscription: paidSubscription(subscription, provider),
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
    scheduledPlan: (subscription?.scheduledPlan as PlanCode | null) ?? null,
    scheduledChangeAt: subscription?.scheduledChangeAt?.toISOString() ?? null,
    canManage,
    actions: canManage ? actions : { checkout: [], changePlan: [], portal: false, cancel: false, resume: false },
    pendingCheckout:
      pending && isPlanCode(pending.targetPlan)
        ? { targetPlan: pending.targetPlan, createdAt: pending.createdAt.toISOString() }
        : null,
    overLimit: await overLimit(businessId),
    trialDays: provider ? trialDays() : null
  };
}

function parseTargetPlan(value: unknown): PlanCode {
  if (typeof value !== "string" || !isPlanCode(value)) {
    throw new HttpError(400, "targetPlan must be one of STARTER, PRO or MAX.");
  }
  return value;
}

async function ensureCustomer(provider: BillingProvider, businessId: string, email: string | null) {
  const existing = await prisma.billingCustomer.findUnique({ where: { businessId } });
  if (existing && existing.provider === provider.name) return existing;
  if (existing) {
    throw new BillingError(409, "BILLING_NOT_ALLOWED", "This business is billed through a different provider.");
  }
  const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { name: true } });
  const { externalCustomerId } = await provider.createCustomer({ businessId, email, name: business.name }).catch(providerFailure);
  // businessId and (provider, externalCustomerId) are both unique: a customer
  // can never be attached to two businesses.
  return prisma.billingCustomer.create({ data: { businessId, provider: provider.name, externalCustomerId } });
}

/** Starts a provider-hosted checkout for a plan. Changes nothing in Veyra. */
export async function startCheckout(params: {
  businessId: string;
  userId: string;
  email: string | null;
  targetPlan: unknown;
}): Promise<{ url: string }> {
  const provider = requireProvider();
  const targetPlan = parseTargetPlan(params.targetPlan);
  const subscription = await prisma.subscription.findUnique({ where: { businessId: params.businessId } });
  const customer = await prisma.billingCustomer.findUnique({ where: { businessId: params.businessId } });

  const actions = availableActions(subscription, provider, Boolean(customer));
  if (!actions.checkout.includes(targetPlan)) {
    throw new BillingError(
      409,
      "BILLING_NOT_ALLOWED",
      paidSubscription(subscription, provider)
        ? "This business already has a paid plan — change it instead of starting a new checkout."
        : `${targetPlan} can't be bought from the current plan.`
    );
  }

  // The price comes from server configuration, never from the request.
  const price = priceForPlan(targetPlan, provider.name);
  if (!price) throw new BillingError(409, "BILLING_NOT_ALLOWED", `${targetPlan} has no price configured.`);

  const billingCustomer = await ensureCustomer(provider, params.businessId, params.email);
  const session = await provider
    .createCheckoutSession({
      externalCustomerId: billingCustomer.externalCustomerId,
      priceId: price.providerPriceId,
      businessId: params.businessId,
      successUrl: settingsUrl(params.businessId, "billing=success"),
      cancelUrl: settingsUrl(params.businessId, "billing=cancelled"),
      trialDays: trialDays()
    })
    .catch(providerFailure);

  await prisma.billingCheckout.create({
    data: {
      businessId: params.businessId,
      provider: provider.name,
      externalSessionId: session.externalSessionId,
      targetPlan,
      status: "open",
      createdByUserId: params.userId
    }
  });

  return { url: session.url };
}

async function paidOrThrow(businessId: string, provider: BillingProvider) {
  const subscription = await prisma.subscription.findUnique({ where: { businessId } });
  if (!paidSubscription(subscription, provider)) {
    throw new BillingError(409, "BILLING_NOT_ALLOWED", "This business has no paid subscription to change.");
  }
  return subscription;
}

/**
 * Asks the provider to move a paid subscription to another plan.
 * Upgrades apply now (the provider prorates); downgrades wait for the end of
 * the period the customer has already paid for; moving to a free Starter is a
 * cancellation at period end.
 */
export async function requestPlanChange(params: { businessId: string; targetPlan: unknown }): Promise<string> {
  const provider = requireProvider();
  const targetPlan = parseTargetPlan(params.targetPlan);
  const subscription = await paidOrThrow(params.businessId, provider);
  const customer = await prisma.billingCustomer.findUnique({ where: { businessId: params.businessId } });
  if (!availableActions(subscription, provider, Boolean(customer)).changePlan.includes(targetPlan)) {
    throw new BillingError(
      409,
      "BILLING_NOT_ALLOWED",
      subscription.cancelAtPeriodEnd || subscription.scheduledPlan
        ? "A change is already scheduled. Keep the current plan first, then choose again."
        : `Can't change to ${targetPlan} from the current plan.`
    );
  }

  const currentPlan = subscription.plan as PlanCode;
  const price = priceForPlan(targetPlan, provider.name);
  if (!price) {
    // Free Starter: end the paid subscription when the paid period runs out.
    await provider
      .cancelSubscription({ externalSubscriptionId: subscription.externalBillingSubscriptionId, atPeriodEnd: true })
      .catch(providerFailure);
    return "Requested. Your plan moves to Starter at the end of the current billing period once the payment provider confirms it.";
  }

  const upgrade = rank(targetPlan) > rank(currentPlan);
  await provider
    .changeSubscriptionPrice({
      externalSubscriptionId: subscription.externalBillingSubscriptionId,
      priceId: price.providerPriceId,
      when: upgrade ? "now" : "period_end"
    })
    .catch(providerFailure);
  return upgrade
    ? "Requested. The new plan unlocks as soon as the payment provider confirms the change."
    : "Requested. The change takes effect at the end of the current billing period once the payment provider confirms it.";
}

export async function requestCancel(businessId: string): Promise<string> {
  const provider = requireProvider();
  const subscription = await paidOrThrow(businessId, provider);
  if (subscription.cancelAtPeriodEnd) {
    throw new BillingError(409, "BILLING_NOT_ALLOWED", "Cancellation is already scheduled.");
  }
  await provider
    .cancelSubscription({ externalSubscriptionId: subscription.externalBillingSubscriptionId, atPeriodEnd: true })
    .catch(providerFailure);
  return "Requested. Your paid plan stays active until the end of the current billing period.";
}

export async function requestResume(businessId: string): Promise<string> {
  const provider = requireProvider();
  const subscription = await paidOrThrow(businessId, provider);
  if (!subscription.cancelAtPeriodEnd && !subscription.scheduledPlan) {
    throw new BillingError(409, "BILLING_NOT_ALLOWED", "Nothing is scheduled to change.");
  }
  await provider.resumeSubscription(subscription.externalBillingSubscriptionId).catch(providerFailure);
  return "Requested. Your current plan will continue once the payment provider confirms it.";
}

export async function portalUrl(businessId: string): Promise<{ url: string }> {
  const provider = requireProvider();
  const customer = await prisma.billingCustomer.findUnique({ where: { businessId } });
  if (!customer || customer.provider !== provider.name) {
    throw new BillingError(409, "BILLING_NOT_ALLOWED", "There is no billing account for this business yet.");
  }
  return provider
    .createCustomerPortalSession({
      externalCustomerId: customer.externalCustomerId,
      returnUrl: settingsUrl(businessId, "billing=portal")
    })
    .catch(providerFailure);
}
