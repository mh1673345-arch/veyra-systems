import express, { Router, type Response } from "express";
import type { BillingChangeResult, BillingRedirect } from "@veyra/shared";
import { currentEnvironment } from "../config/database.js";
import { HttpError } from "../middleware/errorHandler.js";
import { requireAuth, requireBusinessPermission } from "../middleware/auth.js";
import { requireCsrfToken } from "../middleware/csrf.js";
import {
  portalUrl,
  requestCancel,
  requestPlanChange,
  requestResume,
  startCheckout
} from "../services/billing/billingService.js";
import { processBillingWebhook } from "../services/billing/lifecycle.js";
import { configuredPrices } from "../services/billing/prices.js";
import { billingProvider, billingProviderByName, fakeBillingProvider } from "../services/billing/registry.js";
import { prisma } from "../db/client.js";
import { WebhookVerificationError } from "../services/billing/types.js";

/* ------------------------------------------------------------------ *
 * Webhooks — mounted before express.json(): the signature is over the
 * exact raw bytes, so the body must not be parsed first.
 * ------------------------------------------------------------------ */

export const billingWebhookRouter = Router();

billingWebhookRouter.post(
  "/billing/webhooks/:provider",
  express.raw({ type: "*/*", limit: "512kb" }),
  async (req, res) => {
    const provider = billingProviderByName(req.params.provider);
    if (!provider) {
      res.status(404).json({ error: "Unknown billing provider" });
      return;
    }
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    try {
      const result = await processBillingWebhook(provider, rawBody, req.headers);
      // 2xx only after the transaction has committed (or the event was
      // already processed): the provider stops retrying only then.
      res.status(200).json({ received: true, outcome: result.outcome });
    } catch (err) {
      if (err instanceof WebhookVerificationError || err instanceof SyntaxError) {
        // Never processed, never recorded. Logged without the payload.
        console.warn("[veyra:billing] rejected unverified %s webhook: %s", provider.name, err.message);
        res.status(400).json({ error: "Webhook could not be verified" });
        return;
      }
      console.error("[veyra:billing] %s webhook processing failed; the provider will retry", provider.name, err);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  }
);

/* ------------------------------------------------------------------ *
 * Owner billing actions. The client names a plan; the server picks the
 * price. Each returns a redirect or "pending" — never a changed plan.
 * ------------------------------------------------------------------ */

export const billingRouter = Router();

const manage = [requireAuth, requireCsrfToken, requireBusinessPermission("billing:manage")] as const;

function pending(res: Response, message: string) {
  const body: BillingChangeResult = { state: "pending", message };
  res.status(202).json(body);
  if (billingProvider()?.name === "fake") scheduleFakeDelivery();
}

billingRouter.post("/ops/businesses/:businessId/billing/checkout", ...manage, async (req, res, next) => {
  try {
    const body: BillingRedirect = await startCheckout({
      businessId: req.params.businessId,
      userId: req.auth!.user.id,
      email: req.auth!.user.email,
      // Only the plan is read from the request. Any price, amount or plan
      // metadata a client sends is ignored.
      targetPlan: req.body?.targetPlan
    });
    res.status(201).json(body);
  } catch (err) {
    next(err);
  }
});

billingRouter.post("/ops/businesses/:businessId/billing/change-plan", ...manage, async (req, res, next) => {
  try {
    pending(res, await requestPlanChange({ businessId: req.params.businessId, targetPlan: req.body?.targetPlan }));
  } catch (err) {
    next(err);
  }
});

billingRouter.post("/ops/businesses/:businessId/billing/cancel", ...manage, async (req, res, next) => {
  try {
    pending(res, await requestCancel(req.params.businessId));
  } catch (err) {
    next(err);
  }
});

billingRouter.post("/ops/businesses/:businessId/billing/resume", ...manage, async (req, res, next) => {
  try {
    pending(res, await requestResume(req.params.businessId));
  } catch (err) {
    next(err);
  }
});

billingRouter.post("/ops/businesses/:businessId/billing/portal", ...manage, async (req, res, next) => {
  try {
    const body: BillingRedirect = await portalUrl(req.params.businessId);
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ *
 * DEVELOPMENT BILLING PROVIDER pages — stand-ins for a provider's hosted
 * checkout and portal. Never mounted in production. They change only the
 * fake provider's state; Veyra changes when the resulting signed events
 * arrive at the webhook above, over HTTP, like a real provider's would.
 * ------------------------------------------------------------------ */

export const fakeBillingRouter = Router();

fakeBillingRouter.use("/billing/fake", (_req, _res, next) => {
  if (currentEnvironment() === "production") {
    next(new HttpError(404, "Not found"));
    return;
  }
  next();
});

function consoleOrigin(): string {
  return (process.env.VEYRA_WEB_ORIGIN ?? "http://localhost:5173").split(",")[0].trim();
}

function selfOrigin(): string {
  return process.env.VEYRA_PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
}

/** Auto-delivery is on in development and off in tests, which deliver explicitly. */
function autoDeliver(): boolean {
  const setting = process.env.VEYRA_FAKE_BILLING_AUTODELIVER;
  if (setting) return setting === "true";
  return currentEnvironment() === "development";
}

/**
 * POSTs every queued fake event to this server's own webhook endpoint, so it
 * goes through raw-body parsing and signature verification like any other.
 */
export async function deliverFakeEvents(): Promise<{ delivered: number; statuses: number[] }> {
  const statuses: number[] = [];
  for (const event of fakeBillingProvider.drainSignedEvents()) {
    const response = await fetch(`${selfOrigin()}/api/billing/webhooks/fake`, {
      method: "POST",
      headers: event.headers,
      body: event.rawBody
    });
    statuses.push(response.status);
  }
  return { delivered: statuses.length, statuses };
}

/** Real providers deliver asynchronously, a moment after the customer acts. */
export function scheduleFakeDelivery(): void {
  if (!autoDeliver()) return;
  setTimeout(() => {
    deliverFakeEvents().catch((err) => console.error("[veyra:billing] fake webhook delivery failed", err));
  }, 1500);
}

function page(res: Response, title: string, body: string) {
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${consoleOrigin()}; frame-ancestors 'none'`
  );
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1b1b1f}
.warn{background:#fff4d6;border:1px solid #e0b43c;padding:.75rem 1rem;border-radius:8px;margin-bottom:1.5rem}
button{font:inherit;padding:.6rem 1.1rem;border-radius:8px;border:1px solid #444;background:#1b1b1f;color:#fff;cursor:pointer;margin-right:.5rem}
button.secondary{background:#fff;color:#1b1b1f}</style></head><body>
<div class="warn"><strong>Development billing — no real payment.</strong> This page stands in for a payment provider's checkout. Nothing is charged.</div>
${body}</body></html>`);
}

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

fakeBillingRouter.get("/billing/fake/checkout/:sessionId", (req, res) => {
  const checkout = fakeBillingProvider.checkoutInfo(req.params.sessionId);
  if (!checkout) {
    page(res.status(404), "Checkout not found", "<p>This checkout session doesn't exist (the development provider forgets sessions when the API restarts).</p>");
    return;
  }
  const price = configuredPrices("fake").find((p) => p.providerPriceId === checkout.priceId);
  const id = escape(checkout.id);
  page(
    res,
    "Development checkout",
    checkout.status !== "open"
      ? `<p>This checkout is already ${escape(checkout.status)}.</p>`
      : `<h1>Subscribe to ${escape(price?.plan ?? "a plan")}</h1>
<p>${escape(price?.displayAmount ?? "")} per ${escape(price?.interval ?? "month")} <em>(example price, not final)</em></p>
<form method="post" action="/api/billing/fake/checkout/${id}/pay" style="display:inline"><button type="submit">Simulate successful payment</button></form>
<form method="post" action="/api/billing/fake/checkout/${id}/cancel" style="display:inline"><button class="secondary" type="submit">Cancel and go back</button></form>`
  );
});

fakeBillingRouter.post("/billing/fake/checkout/:sessionId/pay", (req, res, next) => {
  try {
    const checkout = fakeBillingProvider.checkoutInfo(req.params.sessionId);
    if (!checkout) throw new HttpError(404, "Checkout not found");
    fakeBillingProvider.completeCheckout(checkout.id);
    // The browser goes back now; Veyra hears about it only via the webhook.
    scheduleFakeDelivery();
    res.redirect(303, checkout.successUrl);
  } catch (err) {
    next(err);
  }
});

fakeBillingRouter.post("/billing/fake/checkout/:sessionId/cancel", (req, res, next) => {
  try {
    const checkout = fakeBillingProvider.checkoutInfo(req.params.sessionId);
    if (!checkout) throw new HttpError(404, "Checkout not found");
    fakeBillingProvider.cancelCheckout(checkout.id);
    res.redirect(303, checkout.cancelUrl);
  } catch (err) {
    next(err);
  }
});

fakeBillingRouter.get("/billing/fake/portal/:customerId", (req, res) => {
  const back = typeof req.query.return === "string" && req.query.return.startsWith(consoleOrigin()) ? req.query.return : consoleOrigin();
  page(
    res,
    "Development billing portal",
    `<h1>Billing portal</h1>
<p>A real provider's portal manages payment methods and invoices here. The development provider has none.</p>
<p><a href="${escape(back)}">Return to Veyra</a></p>`
  );
});

/**
 * Development simulation controls — what a provider would do on its own
 * (a failed renewal, a period ending). Each only queues signed events.
 */
fakeBillingRouter.post("/billing/fake/simulate", express.json(), async (req, res, next) => {
  try {
    const { action, businessId } = (req.body ?? {}) as { action?: string; businessId?: string };
    if (typeof businessId !== "string") throw new HttpError(400, "businessId is required");
    const subscription = await prisma.subscription.findUnique({ where: { businessId } });
    const subscriptionId = subscription?.billingProvider === "fake" ? subscription.externalBillingSubscriptionId : null;
    if (!subscriptionId) throw new HttpError(404, "No development-billing subscription for that business");
    if (action === "fail_payment") fakeBillingProvider.failPayment(subscriptionId);
    else if (action === "recover_payment") fakeBillingProvider.recoverPayment(subscriptionId);
    else if (action === "period_end") fakeBillingProvider.advanceToPeriodEnd(subscriptionId);
    else throw new HttpError(400, "action must be fail_payment, recover_payment or period_end");
    res.json({ queued: fakeBillingProvider.pendingEventCount() });
  } catch (err) {
    next(err);
  }
});

fakeBillingRouter.post("/billing/fake/deliver", async (_req, res, next) => {
  try {
    res.json(await deliverFakeEvents());
  } catch (err) {
    next(err);
  }
});
