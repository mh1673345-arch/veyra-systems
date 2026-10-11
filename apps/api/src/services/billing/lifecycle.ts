import { Prisma, type Subscription } from "@prisma/client";
import { PLAN_CATALOG, PLAN_ORDER, type PlanCode, type SubscriptionStatus } from "@veyra/shared";
import { prisma } from "../../db/client.js";
import { configuredPrices, planForPriceId, starterIsFree } from "./prices.js";
import type { BillingEvent, BillingProvider, ProviderSubscription } from "./types.js";

/**
 * Billing lifecycle: the only code that changes a Subscription because of a
 * payment provider.
 *
 * Webhooks are authoritative. Returning from checkout, a success URL or
 * anything the browser says changes nothing; a verified provider event does.
 *
 *   verify signature → dedupe by event id → resolve business → ordering guard
 *   → map provider state to Veyra state → update Subscription + audit
 *   → record the event id — all in one transaction.
 *
 * AccessService is untouched: it reads the Subscription this writes, so
 * entitlements follow automatically.
 *
 * Provider status → Veyra status:
 *   trialing            → trialing
 *   active              → active
 *   past_due, unpaid    → past_due   (service continues; Console warns)
 *   canceled            → back to Starter (active) when Starter is free,
 *                         otherwise cancelled (core features only)
 *   incomplete          → no change (payment not confirmed yet)
 *   incomplete_expired  → expired, only for a subscription Veyra had linked
 */

export type WebhookResult =
  | { outcome: "processed"; businessId: string; changed: boolean }
  | { outcome: "ignored"; detail: string; businessId: string | null }
  | { outcome: "duplicate" };

interface NextState {
  plan: PlanCode;
  status: SubscriptionStatus;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
  scheduledPlan: PlanCode | null;
  scheduledChangeAt: Date | null;
  externalBillingSubscriptionId: string | null;
  cancelledAt: Date | null;
}

function nextState(
  snapshot: ProviderSubscription,
  plan: PlanCode,
  current: Subscription | null,
  providerName: string,
  now: Date
): NextState | { ignore: string } {
  const freeStarter = starterIsFree(providerName);
  const scheduledFromPrice = snapshot.scheduledPriceId ? planForPriceId(snapshot.scheduledPriceId, providerName) : null;

  const base: NextState = {
    plan,
    status: "active",
    currentPeriodStart: snapshot.currentPeriodStart,
    currentPeriodEnd: snapshot.currentPeriodEnd,
    trialEndsAt: snapshot.trialEnd,
    cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
    // Cancelling a paid plan while Starter is free means "back to Starter at
    // period end" — shown as a scheduled change, not a loss of service.
    scheduledPlan: scheduledFromPrice ?? (snapshot.cancelAtPeriodEnd && freeStarter ? "STARTER" : null),
    scheduledChangeAt:
      snapshot.scheduledChangeAt ?? (snapshot.cancelAtPeriodEnd ? snapshot.currentPeriodEnd : null),
    externalBillingSubscriptionId: snapshot.externalSubscriptionId,
    cancelledAt: null
  };

  switch (snapshot.status) {
    case "trialing":
      return { ...base, status: "trialing" };
    case "active":
      return base;
    case "past_due":
    case "unpaid":
      return { ...base, status: "past_due" };
    case "canceled":
      if (freeStarter) {
        // The paid subscription has ended: back on the free plan. Nothing is
        // deleted; paid features simply stop through AccessService.
        return {
          ...base,
          plan: "STARTER",
          status: "active",
          cancelAtPeriodEnd: false,
          scheduledPlan: null,
          scheduledChangeAt: null,
          externalBillingSubscriptionId: null,
          currentPeriodStart: now,
          currentPeriodEnd: null,
          trialEndsAt: null
        };
      }
      return { ...base, status: "cancelled", cancelAtPeriodEnd: false, scheduledPlan: null, scheduledChangeAt: null, cancelledAt: now };
    case "incomplete":
      return { ignore: "Payment not confirmed yet." };
    case "incomplete_expired":
      return current?.externalBillingSubscriptionId === snapshot.externalSubscriptionId
        ? { ...base, status: "expired" }
        : { ignore: "Checkout expired before payment; nothing to change." };
    default:
      return { ignore: `Unhandled subscription status.` };
  }
}

const rank = (plan: PlanCode) => PLAN_ORDER.indexOf(plan);
const day = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : "the end of the period");

/** A short, human reason for the audit trail — never provider payload. */
function describeChange(previous: Subscription | null, next: NextState): string[] {
  const reasons: string[] = [];
  if (!previous || previous.plan !== next.plan) {
    const from = previous?.plan as PlanCode | undefined;
    reasons.push(
      !from
        ? `Subscribed to ${PLAN_CATALOG[next.plan].name}`
        : rank(next.plan) > rank(from)
          ? `Upgraded to ${PLAN_CATALOG[next.plan].name}`
          : `Changed to ${PLAN_CATALOG[next.plan].name}`
    );
  }
  if (previous && previous.status !== next.status) {
    reasons.push(
      next.status === "past_due"
        ? "Payment failed — subscription past due"
        : previous.status === "past_due" && next.status === "active"
          ? "Payment recovered"
          : `Status ${previous.status} → ${next.status}`
    );
  }
  if (previous && !previous.cancelAtPeriodEnd && next.cancelAtPeriodEnd) {
    reasons.push(`Cancellation scheduled for ${day(next.currentPeriodEnd)}`);
  }
  if (previous?.cancelAtPeriodEnd && !next.cancelAtPeriodEnd && next.externalBillingSubscriptionId) {
    reasons.push("Cancellation withdrawn — subscription resumed");
  }
  if (next.scheduledPlan && previous?.scheduledPlan !== next.scheduledPlan && !next.cancelAtPeriodEnd) {
    reasons.push(`Change to ${PLAN_CATALOG[next.scheduledPlan].name} scheduled for ${day(next.scheduledChangeAt)}`);
  }
  if (previous?.scheduledPlan && !next.scheduledPlan && previous.plan === next.plan && !previous.cancelAtPeriodEnd) {
    reasons.push("Scheduled plan change withdrawn");
  }
  if (previous?.externalBillingSubscriptionId && !next.externalBillingSubscriptionId) {
    reasons.push("Paid subscription ended");
  }
  return reasons;
}

async function resolveBusiness(
  tx: Prisma.TransactionClient,
  provider: string,
  event: BillingEvent,
  snapshot: ProviderSubscription | null
): Promise<{ businessId: string } | { ignore: string }> {
  if (event.checkoutSessionId) {
    const checkout = await tx.billingCheckout.findUnique({
      where: { provider_externalSessionId: { provider, externalSessionId: event.checkoutSessionId } }
    });
    if (!checkout) return { ignore: "Checkout session not started by Veyra." };
    // The customer on the event must be the one Veyra created for that business.
    const customer = await tx.billingCustomer.findUnique({ where: { businessId: checkout.businessId } });
    const eventCustomer = snapshot?.externalCustomerId ?? event.customerId;
    if (!customer || (eventCustomer && customer.externalCustomerId !== eventCustomer)) {
      return { ignore: "Checkout customer does not match the business." };
    }
    return { businessId: checkout.businessId };
  }

  const customerId = snapshot?.externalCustomerId ?? event.customerId;
  if (customerId) {
    const customer = await tx.billingCustomer.findUnique({
      where: { provider_externalCustomerId: { provider, externalCustomerId: customerId } }
    });
    if (customer) return { businessId: customer.businessId };
  }

  if (snapshot) {
    const subscription = await tx.subscription.findFirst({
      where: { billingProvider: provider, externalBillingSubscriptionId: snapshot.externalSubscriptionId }
    });
    if (subscription) return { businessId: subscription.businessId };
  }

  return { ignore: "Not linked to a Veyra business." };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * Verifies and applies one webhook delivery. Throws WebhookVerificationError
 * for anything unverified (the route answers 400 and changes nothing); any
 * other error propagates after the transaction rolls back, so the provider's
 * retry finds no record of the event and applies it cleanly.
 */
export async function processBillingWebhook(
  provider: BillingProvider,
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  now = new Date()
): Promise<WebhookResult> {
  const event = provider.verifyWebhook({ rawBody, headers });

  const seen = await prisma.billingWebhookEvent.findUnique({
    where: { provider_externalEventId: { provider: provider.name, externalEventId: event.id } }
  });
  if (seen) return { outcome: "duplicate" };

  // Events that only reference a subscription are resolved against the
  // provider's current state rather than trusting partial data.
  let snapshot = event.subscription;
  if (!snapshot && event.subscriptionId && event.type !== "other") {
    snapshot = await provider.getSubscription(event.subscriptionId);
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const record = (outcome: "processed" | "ignored", businessId: string | null, detail?: string) =>
        tx.billingWebhookEvent.create({
          data: {
            provider: provider.name,
            externalEventId: event.id,
            type: event.providerType.slice(0, 80),
            outcome,
            detail: detail ?? null,
            businessId,
            eventCreatedAt: event.createdAt
          }
        });

      const resolved = await resolveBusiness(tx, provider.name, event, snapshot);
      if ("ignore" in resolved) {
        await record("ignored", null, resolved.ignore);
        return { outcome: "ignored", detail: resolved.ignore, businessId: null } as const;
      }
      const { businessId } = resolved;

      if (!snapshot) {
        await record("ignored", businessId, "No subscription in this event.");
        return { outcome: "ignored", detail: "No subscription in this event.", businessId } as const;
      }

      const current = await tx.subscription.findUnique({ where: { businessId } });

      // Ordering: a late, older event never rolls newer state back.
      if (current?.lastBillingEventAt && event.createdAt < current.lastBillingEventAt) {
        await record("ignored", businessId, "Older than state already applied.");
        return { outcome: "ignored", detail: "Older than state already applied.", businessId } as const;
      }
      // An event about a subscription Veyra has since replaced is history.
      if (
        current?.externalBillingSubscriptionId &&
        current.externalBillingSubscriptionId !== snapshot.externalSubscriptionId &&
        event.type !== "checkout.completed"
      ) {
        await record("ignored", businessId, "Event for a superseded subscription.");
        return { outcome: "ignored", detail: "Event for a superseded subscription.", businessId } as const;
      }

      // The plan comes from the server's own price mapping — never from
      // checkout metadata or anything a client could have influenced.
      const plan = planForPriceId(snapshot.priceId, provider.name);
      if (!plan) {
        console.error("[veyra:billing] event %s has a price that is not configured", event.id);
        await record("ignored", businessId, "Price is not mapped to a Veyra plan.");
        return { outcome: "ignored", detail: "Price is not mapped to a Veyra plan.", businessId } as const;
      }

      const next = nextState(snapshot, plan, current, provider.name, now);
      if ("ignore" in next) {
        await record("ignored", businessId, next.ignore);
        return { outcome: "ignored", detail: next.ignore, businessId } as const;
      }

      const reasons = describeChange(current, next);

      // A second checkout completed while another paid subscription is still
      // live (e.g. two tabs). The newest purchase wins, and the older one is
      // flagged for a refund review rather than silently left charging.
      if (
        event.type === "checkout.completed" &&
        current?.externalBillingSubscriptionId &&
        current.externalBillingSubscriptionId !== snapshot.externalSubscriptionId &&
        current.status !== "cancelled" &&
        current.status !== "expired"
      ) {
        console.error("[veyra:billing] business %s completed a second checkout; previous provider subscription needs review", businessId);
        reasons.push("A previous paid subscription still exists at the provider — review it for cancellation/refund");
      }

      const interval = next.externalBillingSubscriptionId
        ? configuredPrices(provider.name).find((price) => price.providerPriceId === snapshot!.priceId)?.interval ?? null
        : null;
      const data = {
        plan: next.plan,
        status: next.status,
        currentPeriodStart: next.currentPeriodStart,
        currentPeriodEnd: next.currentPeriodEnd,
        trialEndsAt: next.trialEndsAt,
        cancelAtPeriodEnd: next.cancelAtPeriodEnd,
        scheduledPlan: next.scheduledPlan,
        scheduledChangeAt: next.scheduledChangeAt,
        cancelledAt: next.cancelledAt,
        billingInterval: interval,
        billingProvider: provider.name,
        externalBillingCustomerId: snapshot.externalCustomerId,
        externalBillingSubscriptionId: next.externalBillingSubscriptionId,
        lastBillingEventAt: event.createdAt
      };

      const subscription = current
        ? await tx.subscription.update({ where: { id: current.id }, data })
        : await tx.subscription.create({ data: { businessId, startsAt: now, ...data } });

      if (reasons.length > 0) {
        await tx.subscriptionEvent.create({
          data: {
            businessId,
            subscriptionId: subscription.id,
            previousPlan: current?.plan ?? null,
            newPlan: next.plan,
            previousStatus: current?.status ?? null,
            newStatus: next.status,
            actorType: "billing_provider",
            reason: reasons.join("; ").slice(0, 300),
            externalEventRef: event.id
          }
        });
      }

      if (event.checkoutSessionId) {
        await tx.billingCheckout.updateMany({
          where: { provider: provider.name, externalSessionId: event.checkoutSessionId },
          data: { status: "completed", completedAt: now }
        });
        // Any other checkout this business left open is superseded, so the
        // Console stops waiting on it.
        await tx.billingCheckout.updateMany({
          where: { businessId, status: "open", NOT: { externalSessionId: event.checkoutSessionId } },
          data: { status: "expired" }
        });
      }

      // Written last, in the same transaction: if anything above failed, no
      // record exists and the provider's retry is processed normally.
      await record("processed", businessId);
      return { outcome: "processed", businessId, changed: reasons.length > 0 } as const;
    });
  } catch (err) {
    // A concurrent delivery of the same event won the race and committed first.
    if (isUniqueViolation(err)) return { outcome: "duplicate" };
    throw err;
  }
}
