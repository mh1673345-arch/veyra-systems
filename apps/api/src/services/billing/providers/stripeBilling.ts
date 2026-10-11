import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type BillingEvent,
  type BillingEventType,
  type BillingProvider,
  BillingProviderError,
  type ProviderSubscription,
  WebhookVerificationError
} from "../types.js";

/**
 * Stripe, over its REST API with fetch — no SDK, so no Stripe object shape
 * escapes this file.
 *
 * NOT VERIFIED against Stripe: no Stripe credentials have been configured, so
 * this adapter has never made a real (test-mode) call. Webhook signature
 * verification follows Stripe's documented scheme (HMAC-SHA256 over
 * "<timestamp>.<raw body>" in the Stripe-Signature header, 5 minute
 * tolerance) and is unit-tested with a known secret.
 *
 * Scheduled downgrades between two paid prices need Stripe subscription
 * schedules; rather than guess at that untested flow, "period_end" price
 * changes are reported as unsupported and the Console sends the owner to the
 * Stripe customer portal, which handles them.
 */

const API = "https://api.stripe.com/v1";
const TOLERANCE_SECONDS = 300;

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
}

export function stripeConfig(env: NodeJS.ProcessEnv = process.env): StripeConfig | null {
  const secretKey = env.STRIPE_SECRET_KEY;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey || !webhookSecret) return null;
  return { secretKey, webhookSecret };
}

/** Verifies a Stripe-Signature header. Exported for tests. */
export function verifyStripeSignature(rawBody: Buffer, header: string | undefined, secret: string, now = Date.now()): void {
  if (!header) throw new WebhookVerificationError("Missing Stripe-Signature header.");
  const items = header.split(",").map((item) => item.split("=") as [string, string]);
  const timestamp = Number(items.find(([key]) => key === "t")?.[1]);
  const signatures = items.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!Number.isFinite(timestamp) || signatures.length === 0) {
    throw new WebhookVerificationError("Malformed Stripe-Signature header.");
  }
  if (Math.abs(now / 1000 - timestamp) > TOLERANCE_SECONDS) {
    throw new WebhookVerificationError("Stripe-Signature timestamp outside the tolerance window.");
  }
  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${timestamp}.${rawBody.toString("utf8")}`).digest("hex"),
    "hex"
  );
  const ok = signatures.some((signature) => {
    const candidate = Buffer.from(signature, "hex");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
  if (!ok) throw new WebhookVerificationError("Stripe-Signature does not match.");
}

type StripeObject = Record<string, unknown>;

function seconds(value: unknown): Date | null {
  return typeof value === "number" ? new Date(value * 1000) : null;
}

function toSubscription(raw: StripeObject): ProviderSubscription {
  const items = ((raw.items as StripeObject | undefined)?.data as StripeObject[] | undefined) ?? [];
  const firstItem = items[0] ?? {};
  const price = (firstItem.price as StripeObject | undefined) ?? {};
  // Newer API versions put the period on the item rather than the subscription.
  const periodStart = seconds(raw.current_period_start) ?? seconds(firstItem.current_period_start);
  const periodEnd = seconds(raw.current_period_end) ?? seconds(firstItem.current_period_end);
  const status = String(raw.status) as ProviderSubscription["status"];
  const known: ProviderSubscription["status"][] = [
    "trialing",
    "active",
    "past_due",
    "unpaid",
    "canceled",
    "incomplete",
    "incomplete_expired"
  ];
  return {
    externalSubscriptionId: String(raw.id),
    externalCustomerId: String(raw.customer),
    priceId: String(price.id ?? ""),
    // "paused" and any future status are treated as unpaid rather than active.
    status: known.includes(status) ? status : "unpaid",
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    trialEnd: seconds(raw.trial_end),
    cancelAtPeriodEnd: raw.cancel_at_period_end === true,
    scheduledPriceId: null,
    scheduledChangeAt: null
  };
}

export class StripeBillingProvider implements BillingProvider {
  readonly name = "stripe" as const;

  constructor(private readonly config: StripeConfig) {}

  private async call(method: "GET" | "POST" | "DELETE", path: string, form?: Record<string, string>): Promise<StripeObject> {
    let response: Response;
    try {
      response = await fetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.secretKey}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: form ? new URLSearchParams(form) : undefined,
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw new BillingProviderError("unavailable", "Could not reach Stripe.");
    }
    const json = (await response.json().catch(() => ({}))) as StripeObject;
    if (!response.ok) {
      const message = ((json.error as StripeObject | undefined)?.message as string | undefined) ?? `Stripe returned ${response.status}.`;
      throw new BillingProviderError(response.status >= 500 ? "unavailable" : response.status === 404 ? "not_found" : "rejected", message);
    }
    return json;
  }

  async createCustomer(params: { businessId: string; email: string | null; name: string }) {
    const customer = await this.call("POST", "/customers", {
      name: params.name,
      ...(params.email ? { email: params.email } : {}),
      "metadata[veyra_business_id]": params.businessId
    });
    return { externalCustomerId: String(customer.id) };
  }

  async createCheckoutSession(params: {
    externalCustomerId: string;
    priceId: string;
    businessId: string;
    successUrl: string;
    cancelUrl: string;
    trialDays?: number | null;
  }) {
    const session = await this.call("POST", "/checkout/sessions", {
      mode: "subscription",
      customer: params.externalCustomerId,
      "line_items[0][price]": params.priceId,
      "line_items[0][quantity]": "1",
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      client_reference_id: params.businessId,
      ...(params.trialDays ? { "subscription_data[trial_period_days]": String(params.trialDays) } : {})
    });
    return { externalSessionId: String(session.id), url: String(session.url) };
  }

  async createCustomerPortalSession(params: { externalCustomerId: string; returnUrl: string }) {
    const session = await this.call("POST", "/billing_portal/sessions", {
      customer: params.externalCustomerId,
      return_url: params.returnUrl
    });
    return { url: String(session.url) };
  }

  async getSubscription(externalSubscriptionId: string) {
    return toSubscription(await this.call("GET", `/subscriptions/${encodeURIComponent(externalSubscriptionId)}`));
  }

  async changeSubscriptionPrice(params: { externalSubscriptionId: string; priceId: string; when: "now" | "period_end" }) {
    if (params.when === "period_end") {
      throw new BillingProviderError("unsupported", "Scheduled plan changes are handled in the Stripe billing portal.");
    }
    const current = await this.call("GET", `/subscriptions/${encodeURIComponent(params.externalSubscriptionId)}`);
    const itemId = (((current.items as StripeObject).data as StripeObject[])[0] ?? {}).id;
    return toSubscription(
      await this.call("POST", `/subscriptions/${encodeURIComponent(params.externalSubscriptionId)}`, {
        "items[0][id]": String(itemId),
        "items[0][price]": params.priceId,
        proration_behavior: "create_prorations"
      })
    );
  }

  async cancelSubscription(params: { externalSubscriptionId: string; atPeriodEnd: boolean }) {
    const path = `/subscriptions/${encodeURIComponent(params.externalSubscriptionId)}`;
    return toSubscription(
      params.atPeriodEnd ? await this.call("POST", path, { cancel_at_period_end: "true" }) : await this.call("DELETE", path)
    );
  }

  async resumeSubscription(externalSubscriptionId: string) {
    return toSubscription(
      await this.call("POST", `/subscriptions/${encodeURIComponent(externalSubscriptionId)}`, { cancel_at_period_end: "false" })
    );
  }

  verifyWebhook(params: { rawBody: Buffer; headers: Record<string, string | string[] | undefined> }): BillingEvent {
    const header = params.headers["stripe-signature"];
    verifyStripeSignature(params.rawBody, Array.isArray(header) ? header[0] : header, this.config.webhookSecret);

    const event = JSON.parse(params.rawBody.toString("utf8")) as {
      id: string;
      type: string;
      created: number;
      data: { object: StripeObject };
    };
    const object = event.data.object;

    const typeMap: Record<string, BillingEventType> = {
      "checkout.session.completed": "checkout.completed",
      "customer.subscription.created": "subscription.updated",
      "customer.subscription.updated": "subscription.updated",
      "customer.subscription.deleted": "subscription.deleted",
      "invoice.payment_failed": "payment.failed"
    };
    const type = typeMap[event.type] ?? "other";
    const isSubscription = object.object === "subscription";

    return {
      id: event.id,
      type,
      providerType: event.type,
      createdAt: new Date(event.created * 1000),
      customerId: typeof object.customer === "string" ? object.customer : null,
      checkoutSessionId: object.object === "checkout.session" ? String(object.id) : null,
      subscriptionId: isSubscription
        ? String(object.id)
        : typeof object.subscription === "string"
          ? object.subscription
          : null,
      // Checkout sessions and invoices only reference the subscription; the
      // lifecycle fetches it from Stripe rather than trusting partial data.
      subscription: isSubscription ? toSubscription(object) : null
    };
  }
}
