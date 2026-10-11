import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type BillingEvent,
  type BillingEventType,
  type BillingProvider,
  BillingProviderError,
  type ProviderSubscription,
  WebhookVerificationError
} from "../types.js";

/**
 * DEVELOPMENT BILLING PROVIDER — NOT REAL PAYMENTS.
 *
 * A deterministic, in-memory stand-in for a payment provider, so the whole
 * billing flow (checkout → signed webhook → entitlements) can be exercised
 * without credentials. It charges nothing and is refused in production by the
 * registry.
 *
 * It behaves like a real provider in the ways that matter for correctness:
 *   - checkout completion does NOT touch Veyra; it only queues webhook events
 *   - every event is HMAC-signed and must pass verifyWebhook
 *   - events have unique ids and strictly increasing timestamps, and can be
 *     delivered more than once or out of order on purpose
 */

export const FAKE_SIGNATURE_HEADER = "veyra-fake-signature";
const SIGNATURE_TOLERANCE_SECONDS = 300;

export function fakeWebhookSecret(env: NodeJS.ProcessEnv = process.env): string {
  return env.VEYRA_FAKE_BILLING_WEBHOOK_SECRET ?? "whsec_veyra_fake_dev_only";
}

interface FakeSubscriptionState extends ProviderSubscription {}

interface FakeCheckout {
  id: string;
  customerId: string;
  priceId: string;
  trialDays: number | null;
  successUrl: string;
  cancelUrl: string;
  status: "open" | "completed" | "expired";
}

export interface SignedWebhook {
  eventId: string;
  rawBody: string;
  headers: Record<string, string>;
}

export class FakeBillingProvider implements BillingProvider {
  readonly name = "fake" as const;

  private counter = 0;
  // Ids must not collide with rows left by an earlier process (the fake's
  // memory does not survive a restart; the database does).
  private readonly run = randomBytes(3).toString("hex");
  private clock = 0;
  private readonly customers = new Map<string, { businessId: string }>();
  private readonly checkouts = new Map<string, FakeCheckout>();
  private readonly subscriptions = new Map<string, FakeSubscriptionState>();
  private queue: { id: string; type: string; created: number; data: Record<string, unknown> }[] = [];
  private failNext: BillingProviderError | null = null;

  constructor(private readonly apiBaseUrl = process.env.VEYRA_PUBLIC_API_URL ?? "http://localhost:4000") {}

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_fake_${this.run}_${this.counter}`;
  }

  /** Strictly increasing event timestamps, so ordering is deterministic. */
  private tick(): number {
    this.clock = Math.max(Date.now(), this.clock + 1);
    return this.clock;
  }

  private emit(type: string, data: Record<string, unknown>): void {
    this.queue.push({ id: this.nextId("evt"), type, created: this.tick(), data });
  }

  private guard(): void {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
  }

  private subscription(id: string): FakeSubscriptionState {
    const subscription = this.subscriptions.get(id);
    if (!subscription) throw new BillingProviderError("not_found", `Subscription ${id} not found.`);
    return subscription;
  }

  private snapshot(subscription: FakeSubscriptionState): ProviderSubscription {
    return { ...subscription };
  }

  /* ----------------------------- the contract ----------------------------- */

  async createCustomer(params: { businessId: string }): Promise<{ externalCustomerId: string }> {
    this.guard();
    const id = this.nextId("cus");
    this.customers.set(id, { businessId: params.businessId });
    return { externalCustomerId: id };
  }

  async createCheckoutSession(params: {
    externalCustomerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    trialDays?: number | null;
  }): Promise<{ externalSessionId: string; url: string }> {
    this.guard();
    const id = this.nextId("cs");
    this.checkouts.set(id, {
      id,
      customerId: params.externalCustomerId,
      priceId: params.priceId,
      trialDays: params.trialDays ?? null,
      successUrl: params.successUrl,
      cancelUrl: params.cancelUrl,
      status: "open"
    });
    return { externalSessionId: id, url: `${this.apiBaseUrl}/api/billing/fake/checkout/${id}` };
  }

  async createCustomerPortalSession(params: { externalCustomerId: string; returnUrl: string }): Promise<{ url: string }> {
    this.guard();
    return {
      url: `${this.apiBaseUrl}/api/billing/fake/portal/${params.externalCustomerId}?return=${encodeURIComponent(params.returnUrl)}`
    };
  }

  async getSubscription(externalSubscriptionId: string): Promise<ProviderSubscription> {
    return this.snapshot(this.subscription(externalSubscriptionId));
  }

  async changeSubscriptionPrice(params: {
    externalSubscriptionId: string;
    priceId: string;
    when: "now" | "period_end";
  }): Promise<ProviderSubscription> {
    this.guard();
    const subscription = this.subscription(params.externalSubscriptionId);
    if (params.when === "now") {
      subscription.priceId = params.priceId;
      subscription.scheduledPriceId = null;
      subscription.scheduledChangeAt = null;
    } else {
      subscription.scheduledPriceId = params.priceId;
      subscription.scheduledChangeAt = subscription.currentPeriodEnd;
    }
    this.emit("subscription.updated", { subscription: this.snapshot(subscription) });
    return this.snapshot(subscription);
  }

  async cancelSubscription(params: { externalSubscriptionId: string; atPeriodEnd: boolean }): Promise<ProviderSubscription> {
    this.guard();
    const subscription = this.subscription(params.externalSubscriptionId);
    if (params.atPeriodEnd) {
      subscription.cancelAtPeriodEnd = true;
      this.emit("subscription.updated", { subscription: this.snapshot(subscription) });
    } else {
      subscription.status = "canceled";
      this.emit("subscription.deleted", { subscription: this.snapshot(subscription) });
    }
    return this.snapshot(subscription);
  }

  async resumeSubscription(externalSubscriptionId: string): Promise<ProviderSubscription> {
    this.guard();
    const subscription = this.subscription(externalSubscriptionId);
    if (subscription.status === "canceled") {
      throw new BillingProviderError("rejected", "An ended subscription can't be resumed.");
    }
    subscription.cancelAtPeriodEnd = false;
    subscription.scheduledPriceId = null;
    subscription.scheduledChangeAt = null;
    this.emit("subscription.updated", { subscription: this.snapshot(subscription) });
    return this.snapshot(subscription);
  }

  verifyWebhook(params: { rawBody: Buffer; headers: Record<string, string | string[] | undefined> }): BillingEvent {
    const header = params.headers[FAKE_SIGNATURE_HEADER];
    const value = Array.isArray(header) ? header[0] : header;
    if (!value) throw new WebhookVerificationError("Missing signature.");

    const parts = Object.fromEntries(value.split(",").map((part) => part.split("=") as [string, string]));
    const timestamp = Number(parts.t);
    const signature = parts.v1;
    if (!Number.isFinite(timestamp) || !signature) throw new WebhookVerificationError("Malformed signature.");
    if (Math.abs(Date.now() / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
      throw new WebhookVerificationError("Signature timestamp outside the tolerance window.");
    }

    const expected = sign(`${timestamp}.${params.rawBody.toString("utf8")}`);
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(signature, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new WebhookVerificationError("Signature mismatch.");

    const payload = JSON.parse(params.rawBody.toString("utf8")) as {
      id: string;
      type: string;
      created: number;
      data: { subscription?: Record<string, unknown>; checkoutSessionId?: string; customerId?: string };
    };

    const subscription = payload.data.subscription ? revive(payload.data.subscription) : null;
    const typeMap: Record<string, BillingEventType> = {
      "checkout.completed": "checkout.completed",
      "subscription.updated": "subscription.updated",
      "subscription.deleted": "subscription.deleted",
      "payment.failed": "payment.failed"
    };

    return {
      id: payload.id,
      type: typeMap[payload.type] ?? "other",
      providerType: payload.type,
      createdAt: new Date(payload.created),
      customerId: payload.data.customerId ?? subscription?.externalCustomerId ?? null,
      checkoutSessionId: payload.data.checkoutSessionId ?? null,
      subscriptionId: subscription?.externalSubscriptionId ?? null,
      subscription
    };
  }

  /* ----------------------- simulation controls (dev/test) ----------------------- */

  checkoutInfo(sessionId: string): FakeCheckout | null {
    return this.checkouts.get(sessionId) ?? null;
  }

  /**
   * The customer "pays" on the fake checkout page. Creates the subscription at
   * the provider and queues webhook events — Veyra itself is not touched until
   * those events are delivered and verified.
   */
  completeCheckout(sessionId: string): ProviderSubscription {
    const checkout = this.checkouts.get(sessionId);
    if (!checkout || checkout.status !== "open") throw new BillingProviderError("rejected", "Checkout is not open.");
    checkout.status = "completed";

    const now = new Date();
    const trialEnd = checkout.trialDays ? new Date(now.getTime() + checkout.trialDays * 86_400_000) : null;
    const periodEnd = new Date(now);
    periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);

    const subscription: FakeSubscriptionState = {
      externalSubscriptionId: this.nextId("sub"),
      externalCustomerId: checkout.customerId,
      priceId: checkout.priceId,
      status: trialEnd ? "trialing" : "active",
      currentPeriodStart: now,
      currentPeriodEnd: trialEnd ?? periodEnd,
      trialEnd,
      cancelAtPeriodEnd: false,
      scheduledPriceId: null,
      scheduledChangeAt: null
    };
    this.subscriptions.set(subscription.externalSubscriptionId, subscription);
    this.emit("checkout.completed", {
      checkoutSessionId: sessionId,
      customerId: checkout.customerId,
      subscription: this.snapshot(subscription)
    });
    return this.snapshot(subscription);
  }

  cancelCheckout(sessionId: string): void {
    const checkout = this.checkouts.get(sessionId);
    if (checkout && checkout.status === "open") checkout.status = "expired";
  }

  /** A card payment fails: the subscription goes past due. */
  failPayment(externalSubscriptionId: string): void {
    const subscription = this.subscription(externalSubscriptionId);
    subscription.status = "past_due";
    this.emit("payment.failed", { subscription: this.snapshot(subscription) });
  }

  recoverPayment(externalSubscriptionId: string): void {
    const subscription = this.subscription(externalSubscriptionId);
    subscription.status = "active";
    this.emit("subscription.updated", { subscription: this.snapshot(subscription) });
  }

  /** Time passes to the end of the period: scheduled changes and cancellations take effect. */
  advanceToPeriodEnd(externalSubscriptionId: string): void {
    const subscription = this.subscription(externalSubscriptionId);
    if (subscription.cancelAtPeriodEnd) {
      subscription.status = "canceled";
      this.emit("subscription.deleted", { subscription: this.snapshot(subscription) });
      return;
    }
    const start = subscription.currentPeriodEnd ?? new Date();
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    subscription.currentPeriodStart = start;
    subscription.currentPeriodEnd = end;
    if (subscription.scheduledPriceId) {
      subscription.priceId = subscription.scheduledPriceId;
      subscription.scheduledPriceId = null;
      subscription.scheduledChangeAt = null;
    }
    if (subscription.status === "trialing") subscription.status = "active";
    this.emit("subscription.updated", { subscription: this.snapshot(subscription) });
  }

  /** Makes the next provider call fail, to test error handling. */
  failNextCall(error: BillingProviderError): void {
    this.failNext = error;
  }

  /** Signs and removes every queued event, oldest first — ready to POST to the webhook. */
  drainSignedEvents(secret = fakeWebhookSecret()): SignedWebhook[] {
    const events = this.queue;
    this.queue = [];
    return events.map((event) => signEvent(event, secret));
  }

  pendingEventCount(): number {
    return this.queue.length;
  }

  reset(): void {
    this.customers.clear();
    this.checkouts.clear();
    this.subscriptions.clear();
    this.queue = [];
    this.failNext = null;
  }
}

function sign(payload: string, secret = fakeWebhookSecret()): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function signEvent(
  event: { id: string; type: string; created: number; data: Record<string, unknown> },
  secret = fakeWebhookSecret(),
  timestamp = Math.floor(Date.now() / 1000)
): SignedWebhook {
  const rawBody = JSON.stringify(event);
  return {
    eventId: event.id,
    rawBody,
    headers: {
      "content-type": "application/json",
      [FAKE_SIGNATURE_HEADER]: `t=${timestamp},v1=${sign(`${timestamp}.${rawBody}`, secret)}`
    }
  };
}

/** Dates come back from JSON as strings. */
function revive(raw: Record<string, unknown>): ProviderSubscription {
  const date = (value: unknown) => (value ? new Date(value as string) : null);
  return {
    externalSubscriptionId: String(raw.externalSubscriptionId),
    externalCustomerId: String(raw.externalCustomerId),
    priceId: String(raw.priceId),
    status: raw.status as ProviderSubscription["status"],
    currentPeriodStart: date(raw.currentPeriodStart),
    currentPeriodEnd: date(raw.currentPeriodEnd),
    trialEnd: date(raw.trialEnd),
    cancelAtPeriodEnd: Boolean(raw.cancelAtPeriodEnd),
    scheduledPriceId: (raw.scheduledPriceId as string | null) ?? null,
    scheduledChangeAt: date(raw.scheduledChangeAt)
  };
}
