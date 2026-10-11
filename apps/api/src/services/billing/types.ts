/**
 * The billing boundary.
 *
 * Everything Veyra needs from a payment provider goes through BillingProvider,
 * and everything that comes back is translated into the provider-neutral shapes
 * below. No vendor SDK object, status string or payload shape crosses into the
 * rest of the app: AccessService still decides access from Veyra's own
 * Subscription, and billing only ever changes that Subscription through
 * services/billing/lifecycle.ts.
 */

export type BillingProviderName = "fake" | "stripe";

/** A provider subscription status, normalised. Mapped to Veyra's statuses in lifecycle.ts. */
export type ProviderSubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "unpaid"
  | "canceled"
  | "incomplete"
  | "incomplete_expired";

export interface ProviderSubscription {
  externalSubscriptionId: string;
  externalCustomerId: string;
  /** The provider price the subscription is on right now. */
  priceId: string;
  status: ProviderSubscriptionStatus;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  trialEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** A price change the provider has scheduled, and when it takes effect. */
  scheduledPriceId: string | null;
  scheduledChangeAt: Date | null;
}

export type BillingEventType =
  | "checkout.completed"
  | "subscription.updated"
  | "subscription.deleted"
  | "payment.failed"
  | "other";

/** A verified webhook event, normalised. Never contains the raw payload. */
export interface BillingEvent {
  /** The provider's own event id: the deduplication key. */
  id: string;
  type: BillingEventType;
  /** When the provider created the event: the ordering key. */
  createdAt: Date;
  customerId: string | null;
  checkoutSessionId: string | null;
  /** The provider subscription this event concerns, when known. */
  subscriptionId: string | null;
  /** The subscription as of this event, when the event is about one. */
  subscription: ProviderSubscription | null;
  /** The provider's original type string, kept only for logging. */
  providerType: string;
}

export class BillingProviderError extends Error {
  constructor(
    readonly kind: "unavailable" | "rejected" | "unsupported" | "not_found",
    message: string
  ) {
    super(message);
    this.name = "BillingProviderError";
  }
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

export interface BillingProvider {
  readonly name: BillingProviderName;
  /** Creates the provider's customer record for a business. */
  createCustomer(params: { businessId: string; email: string | null; name: string }): Promise<{ externalCustomerId: string }>;
  /** A provider-hosted checkout page for one price. Veyra never handles card data. */
  createCheckoutSession(params: {
    externalCustomerId: string;
    priceId: string;
    businessId: string;
    successUrl: string;
    cancelUrl: string;
    trialDays?: number | null;
  }): Promise<{ externalSessionId: string; url: string }>;
  /** A provider-hosted page for payment methods, invoices and billing details. */
  createCustomerPortalSession(params: { externalCustomerId: string; returnUrl: string }): Promise<{ url: string }>;
  getSubscription(externalSubscriptionId: string): Promise<ProviderSubscription>;
  /**
   * Moves a subscription to another price. "now" is used for upgrades,
   * "period_end" for downgrades so a customer keeps what they paid for.
   */
  changeSubscriptionPrice(params: {
    externalSubscriptionId: string;
    priceId: string;
    when: "now" | "period_end";
  }): Promise<ProviderSubscription>;
  cancelSubscription(params: { externalSubscriptionId: string; atPeriodEnd: boolean }): Promise<ProviderSubscription>;
  resumeSubscription(externalSubscriptionId: string): Promise<ProviderSubscription>;
  /** Verifies the signature over the raw body and returns the normalised event, or throws. */
  verifyWebhook(params: { rawBody: Buffer; headers: Record<string, string | string[] | undefined> }): BillingEvent;
}
