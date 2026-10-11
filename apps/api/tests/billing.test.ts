import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createHmac } from "node:crypto";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { CSRF_COOKIE, hashPassword } from "../src/services/auth/sessions.js";
import { accessFor, changePlan } from "../src/services/access/accessService.js";
import { calendarStatus, checkAvailability } from "../src/services/calendar/service.js";
import { confirmHeldBooking, holdSlot } from "../src/services/calendar/bookings.js";
import { fakeBillingProvider, billingProviderByName, configuredProviderName } from "../src/services/billing/registry.js";
import { FAKE_SIGNATURE_HEADER, fakeWebhookSecret, signEvent } from "../src/services/billing/providers/fakeBilling.js";
import { verifyStripeSignature } from "../src/services/billing/providers/stripeBilling.js";
import { configuredPrices, planForPriceId } from "../src/services/billing/prices.js";
import { WebhookVerificationError } from "../src/services/billing/types.js";
import { at, createCalendarBusiness, fakeCalendarProvider, resetFakeCalendar } from "./helpers/calendarFixtures.js";

/**
 * Billing, end to end through real HTTP, the real webhook route (raw body +
 * signature verification), the real lifecycle and the real AccessService.
 *
 * The payment provider is the DEVELOPMENT provider: no money moves and nothing
 * here is evidence that a real provider works. What it proves is Veyra's side:
 * that only a verified webhook changes a plan, exactly once, in order.
 */

const app = createApp();
const PASSWORD = "harbour-quay-lantern-7391";

interface Session {
  cookie: string;
  csrf: string;
}
const authed = (r: request.Test, session: Session) => r.set({ Cookie: session.cookie, "x-csrf-token": session.csrf });

let passwordHash: string;
let counter = 0;

async function signIn(email: string): Promise<Session> {
  const res = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  const cookies = res.headers["set-cookie"] as unknown as string[];
  return {
    cookie: cookies.map((cookie) => cookie.split(";")[0]).join("; "),
    csrf: cookies.find((cookie) => cookie.startsWith(CSRF_COOKIE))!.split(";")[0].split("=")[1]
  };
}

async function member(businessId: string, role: string): Promise<Session> {
  counter += 1;
  const user = await prisma.user.create({
    data: { email: `${role.toLowerCase()}-${counter}-${Date.now()}@billing.test`, name: role, passwordHash }
  });
  await prisma.businessMembership.create({ data: { userId: user.id, businessId, role } });
  return signIn(user.email);
}

async function business(plan: "STARTER" | "PRO" | "MAX" = "STARTER") {
  const fixture = await createCalendarBusiness({ plan, namePrefix: "Billing" });
  const owner = await member(fixture.businessId, "OWNER");
  return { ...fixture, owner };
}

const base = (businessId: string) => `/api/ops/businesses/${businessId}`;

async function overview(businessId: string, session: Session) {
  const res = await authed(request(app).get(`${base(businessId)}/subscription`), session);
  expect(res.status).toBe(200);
  return res.body;
}

async function postWebhook(rawBody: string, headers: Record<string, string>) {
  return request(app).post("/api/billing/webhooks/fake").set(headers).send(rawBody);
}

/** Delivers every queued provider event through the real webhook route. */
async function deliverAll() {
  const results = [];
  for (const event of fakeBillingProvider.drainSignedEvents()) {
    const res = await postWebhook(event.rawBody, event.headers);
    results.push({ eventId: event.eventId, status: res.status, outcome: res.body.outcome as string });
  }
  return results;
}

async function startCheckout(businessId: string, session: Session, targetPlan: string) {
  const res = await authed(request(app).post(`${base(businessId)}/billing/checkout`), session).send({ targetPlan });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const sessionId = /checkout\/([^/?]+)$/.exec(res.body.url)![1];
  return { url: res.body.url as string, sessionId };
}

/** A business on a paid plan, bought through checkout + webhook. */
async function paidBusiness(plan: "PRO" | "MAX") {
  const fixture = await business("STARTER");
  const { sessionId } = await startCheckout(fixture.businessId, fixture.owner, plan);
  fakeBillingProvider.completeCheckout(sessionId);
  await deliverAll();
  const subscription = await prisma.subscription.findUniqueOrThrow({ where: { businessId: fixture.businessId } });
  expect(subscription.plan).toBe(plan);
  return { ...fixture, externalSubscriptionId: subscription.externalBillingSubscriptionId! };
}

const TOUCHED_ENV = [
  "VEYRA_BILLING_PROVIDER",
  "VEYRA_BILLING_STARTER_PRICE_ID",
  "VEYRA_BILLING_STARTER_AMOUNT",
  "NODE_ENV"
] as const;
const savedEnv = Object.fromEntries(TOUCHED_ENV.map((key) => [key, process.env[key]]));

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
}, 60_000);

beforeEach(() => {
  process.env.VEYRA_BILLING_PROVIDER = "fake";
  delete process.env.VEYRA_BILLING_STARTER_PRICE_ID;
  delete process.env.VEYRA_BILLING_STARTER_AMOUNT;
  fakeBillingProvider.reset();
  resetFakeCalendar();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of TOUCHED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */

describe("checkout", () => {
  it("starts a provider checkout for the plan asked for, and changes nothing yet", async () => {
    const { businessId, owner } = await business();
    const { url, sessionId } = await startCheckout(businessId, owner, "PRO");

    expect(url).toContain("/api/billing/fake/checkout/");
    expect(fakeBillingProvider.checkoutInfo(sessionId)!.priceId).toBe("fake_price_pro");
    const checkout = await prisma.billingCheckout.findFirstOrThrow({ where: { businessId } });
    expect(checkout).toMatchObject({ targetPlan: "PRO", status: "open", provider: "fake" });
    expect(await prisma.billingCustomer.count({ where: { businessId } })).toBe(1);

    // Starting checkout is not paying.
    expect((await accessFor(businessId)).plan).toBe("STARTER");
    const body = await overview(businessId, owner);
    expect(body.billing.pendingCheckout.targetPlan).toBe("PRO");
  });

  it("returning from checkout does not activate anything — only the webhook does", async () => {
    const { businessId, owner } = await business();
    const { sessionId } = await startCheckout(businessId, owner, "PRO");

    // The customer pays; the provider redirects the browser back.
    const pay = await request(app).post(`/api/billing/fake/checkout/${sessionId}/pay`);
    expect(pay.status).toBe(303);
    expect(pay.headers.location).toContain("billing=success");

    // Still Starter: no webhook has been delivered (tests deliver explicitly).
    expect((await accessFor(businessId)).plan).toBe("STARTER");
    expect((await calendarStatus(businessId)).live).toBe(false);

    const results = await deliverAll();
    expect(results.map((r) => r.status)).toEqual([200]);
    expect((await accessFor(businessId)).plan).toBe("PRO");
  });

  it("uses the server's price for the plan, whatever price the client sends", async () => {
    const { businessId, owner } = await business();
    const res = await authed(request(app).post(`${base(businessId)}/billing/checkout`), owner).send({
      targetPlan: "PRO",
      priceId: "fake_price_max",
      amount: 1,
      plan: "MAX"
    });
    expect(res.status).toBe(201);
    const sessionId = /checkout\/([^/?]+)$/.exec(res.body.url)![1];
    expect(fakeBillingProvider.checkoutInfo(sessionId)!.priceId).toBe("fake_price_pro");
  });

  it("rejects an unknown plan, an unpriced plan and the current plan", async () => {
    const { businessId, owner } = await business();
    const post = (body: object) => authed(request(app).post(`${base(businessId)}/billing/checkout`), owner).send(body);

    expect((await post({ targetPlan: "ENTERPRISE" })).status).toBe(400);
    expect((await post({ priceId: "fake_price_max" })).status).toBe(400);
    const starter = await post({ targetPlan: "STARTER" });
    expect(starter.status).toBe(409);
    expect(starter.body.code).toBe("BILLING_NOT_ALLOWED");
  });

  it("reuses one billing customer per business", async () => {
    const { businessId, owner } = await business();
    await startCheckout(businessId, owner, "PRO");
    await startCheckout(businessId, owner, "MAX");
    expect(await prisma.billingCustomer.count({ where: { businessId } })).toBe(1);
    expect(await prisma.billingCheckout.count({ where: { businessId } })).toBe(2);
  });

  it("is only available to the owner", async () => {
    const { businessId } = await business();
    for (const role of ["ADMIN", "OPERATOR", "VIEWER"]) {
      const session = await member(businessId, role);
      const res = await authed(request(app).post(`${base(businessId)}/billing/checkout`), session).send({ targetPlan: "PRO" });
      expect(res.status, role).toBe(403);
    }
    expect(await prisma.billingCheckout.count({ where: { businessId } })).toBe(0);
  });

  it("hides another business's billing entirely", async () => {
    const mine = await business();
    const theirs = await business();
    for (const path of ["checkout", "change-plan", "cancel", "resume", "portal"]) {
      const res = await authed(request(app).post(`${base(theirs.businessId)}/billing/${path}`), mine.owner).send({
        targetPlan: "PRO"
      });
      expect(res.status, path).toBe(404);
    }
  });

  it("requires a session and the CSRF token", async () => {
    const { businessId, owner } = await business();
    const anonymous = await request(app).post(`${base(businessId)}/billing/checkout`).send({ targetPlan: "PRO" });
    expect(anonymous.status).toBe(401);
    const noCsrf = await request(app)
      .post(`${base(businessId)}/billing/checkout`)
      .set("Cookie", owner.cookie)
      .send({ targetPlan: "PRO" });
    expect(noCsrf.status).toBe(403);
  });

  it("says plainly when billing is not configured, instead of faking checkout", async () => {
    delete process.env.VEYRA_BILLING_PROVIDER;
    const { businessId, owner } = await business();
    const res = await authed(request(app).post(`${base(businessId)}/billing/checkout`), owner).send({ targetPlan: "PRO" });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("BILLING_UNAVAILABLE");
    const body = await overview(businessId, owner);
    expect(body.billingAvailable).toBe(false);
    expect(body.billing.prices).toEqual([]);
    expect(body.billing.actions.checkout).toEqual([]);
  });

  it("reports a provider failure without changing anything", async () => {
    const { businessId, owner } = await business();
    await startCheckout(businessId, owner, "PRO"); // creates the customer
    fakeBillingProvider.failNextCall(new (await import("../src/services/billing/types.js")).BillingProviderError("unavailable", "down"));
    const res = await authed(request(app).post(`${base(businessId)}/billing/checkout`), owner).send({ targetPlan: "PRO" });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("BILLING_PROVIDER_ERROR");
    expect(await prisma.billingCheckout.count({ where: { businessId } })).toBe(1);
  });
});

/* ------------------------------------------------------------------ */

describe("webhooks", () => {
  it("applies a verified checkout: plan, audit, checkout record, and a stored calendar goes live", async () => {
    const { businessId, owner } = await business();
    const connectionBefore = await prisma.calendarConnection.findFirstOrThrow({ where: { businessId } });
    const { sessionId } = await startCheckout(businessId, owner, "PRO");
    fakeBillingProvider.completeCheckout(sessionId);

    const [result] = await deliverAll();
    expect(result).toMatchObject({ status: 200, outcome: "processed" });

    const subscription = await prisma.subscription.findUniqueOrThrow({ where: { businessId } });
    expect(subscription).toMatchObject({
      plan: "PRO",
      status: "active",
      billingProvider: "fake",
      billingInterval: "month",
      cancelAtPeriodEnd: false
    });
    expect(subscription.externalBillingSubscriptionId).toMatch(/^sub_fake_/);
    expect(subscription.currentPeriodEnd).not.toBeNull();

    const event = await prisma.subscriptionEvent.findFirstOrThrow({ where: { businessId, externalEventRef: result.eventId } });
    expect(event).toMatchObject({ previousPlan: "STARTER", newPlan: "PRO", actorType: "billing_provider" });
    expect(event.reason).toMatch(/Upgraded to Pro/);
    // A reference to the provider event — never its payload.
    expect(event.reason).not.toMatch(/sub_fake|cus_fake|priceId|\{/);

    expect((await prisma.billingCheckout.findFirstOrThrow({ where: { businessId } })).status).toBe("completed");

    // The connection stored while on Starter is live now, without reconnecting.
    expect((await calendarStatus(businessId)).live).toBe(true);
    const connectionAfter = await prisma.calendarConnection.findFirstOrThrow({ where: { businessId } });
    expect(connectionAfter.id).toBe(connectionBefore.id);
    expect(connectionAfter.accessTokenEnc).toBe(connectionBefore.accessTokenEnc);
  });

  it("changes Veyra exactly once when the same event is delivered five times", async () => {
    const { businessId, owner } = await business();
    const { sessionId } = await startCheckout(businessId, owner, "PRO");
    fakeBillingProvider.completeCheckout(sessionId);
    const [event] = fakeBillingProvider.drainSignedEvents();

    const outcomes = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await postWebhook(event.rawBody, event.headers);
      expect(res.status).toBe(200);
      outcomes.push(res.body.outcome);
    }
    expect(outcomes).toEqual(["processed", "duplicate", "duplicate", "duplicate", "duplicate"]);
    expect(await prisma.subscriptionEvent.count({ where: { externalEventRef: event.eventId } })).toBe(1);
    expect(await prisma.billingWebhookEvent.count({ where: { externalEventId: event.eventId } })).toBe(1);
  });

  it("handles concurrent duplicate deliveries without a double change", async () => {
    const { businessId, owner } = await business();
    const { sessionId } = await startCheckout(businessId, owner, "PRO");
    fakeBillingProvider.completeCheckout(sessionId);
    const [event] = fakeBillingProvider.drainSignedEvents();

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => postWebhook(event.rawBody, event.headers))
    );
    expect(responses.every((res) => res.status === 200)).toBe(true);
    expect(responses.filter((res) => res.body.outcome === "processed")).toHaveLength(1);
    expect(await prisma.subscriptionEvent.count({ where: { externalEventRef: event.eventId } })).toBe(1);
  });

  it("rejects a forged event: a tampered body fails verification and changes nothing", async () => {
    const { businessId, owner } = await business();
    const { sessionId } = await startCheckout(businessId, owner, "PRO");
    fakeBillingProvider.completeCheckout(sessionId);
    const [event] = fakeBillingProvider.drainSignedEvents();

    // Same signature, body edited to buy Max instead.
    const tampered = event.rawBody.replace("fake_price_pro", "fake_price_max");
    const res = await postWebhook(tampered, event.headers);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Webhook could not be verified" });

    expect((await accessFor(businessId)).plan).toBe("STARTER");
    expect(await prisma.billingWebhookEvent.count({ where: { externalEventId: event.eventId } })).toBe(0);

    // The genuine event still applies afterwards.
    expect((await postWebhook(event.rawBody, event.headers)).status).toBe(200);
    expect((await accessFor(businessId)).plan).toBe("PRO");
  });

  it("rejects an event signed with the wrong secret, or with no signature", async () => {
    const { businessId, owner } = await business();
    const { sessionId } = await startCheckout(businessId, owner, "PRO");
    fakeBillingProvider.completeCheckout(sessionId);
    const [wrong] = fakeBillingProvider.drainSignedEvents("whsec_not_the_real_secret");

    expect((await postWebhook(wrong.rawBody, wrong.headers)).status).toBe(400);
    expect((await postWebhook(wrong.rawBody, { "content-type": "application/json" })).status).toBe(400);
    expect(
      (await postWebhook(wrong.rawBody, { "content-type": "application/json", [FAKE_SIGNATURE_HEADER]: "garbage" })).status
    ).toBe(400);
    expect((await accessFor(businessId)).plan).toBe("STARTER");
  });

  it("rejects a replayed event outside the signature tolerance window", async () => {
    const { businessId, owner } = await business();
    const { sessionId } = await startCheckout(businessId, owner, "PRO");
    fakeBillingProvider.completeCheckout(sessionId);
    const [event] = fakeBillingProvider.drainSignedEvents();
    const parsed = JSON.parse(event.rawBody);
    const stale = signEvent(parsed, fakeWebhookSecret(), Math.floor(Date.now() / 1000) - 3600);

    expect((await postWebhook(stale.rawBody, stale.headers)).status).toBe(400);
    expect((await accessFor(businessId)).plan).toBe("STARTER");
  });

  it("answers 404 for an unknown provider", async () => {
    const res = await request(app).post("/api/billing/webhooks/paypal").send("{}");
    expect(res.status).toBe(404);
  });

  it("never lets an older event roll back newer state", async () => {
    const { businessId, externalSubscriptionId } = await paidBusiness("PRO");
    // Two provider events: payment fails, then recovers.
    fakeBillingProvider.failPayment(externalSubscriptionId);
    fakeBillingProvider.recoverPayment(externalSubscriptionId);
    const [failed, recovered] = fakeBillingProvider.drainSignedEvents();

    // Delivered newest first.
    expect((await postWebhook(recovered.rawBody, recovered.headers)).body.outcome).toBe("processed");
    const late = await postWebhook(failed.rawBody, failed.headers);
    expect(late.status).toBe(200);
    expect(late.body.outcome).toBe("ignored");

    expect((await prisma.subscription.findUniqueOrThrow({ where: { businessId } })).status).toBe("active");
    const record = await prisma.billingWebhookEvent.findFirstOrThrow({ where: { externalEventId: failed.eventId } });
    expect(record.outcome).toBe("ignored");
  });

  it("returns 500 when processing fails, commits nothing, and succeeds on the provider's retry", async () => {
    const { businessId, owner } = await business();
    const { sessionId } = await startCheckout(businessId, owner, "PRO");
    fakeBillingProvider.completeCheckout(sessionId);
    const [event] = fakeBillingProvider.drainSignedEvents();

    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("database unavailable"));
    const failed = await postWebhook(event.rawBody, event.headers);
    expect(failed.status).toBe(500);
    expect(await prisma.billingWebhookEvent.count({ where: { externalEventId: event.eventId } })).toBe(0);
    expect((await accessFor(businessId)).plan).toBe("STARTER");
    spy.mockRestore();

    const retried = await postWebhook(event.rawBody, event.headers);
    expect(retried.status).toBe(200);
    expect(retried.body.outcome).toBe("processed");
    expect((await accessFor(businessId)).plan).toBe("PRO");
  });

  it("ignores events for customers Veyra doesn't know", async () => {
    const event = signEvent({
      id: `evt_stranger_${Date.now()}`,
      type: "subscription.updated",
      created: Date.now(),
      data: {
        subscription: {
          externalSubscriptionId: "sub_stranger",
          externalCustomerId: "cus_stranger",
          priceId: "fake_price_max",
          status: "active",
          cancelAtPeriodEnd: false
        }
      }
    });
    const res = await postWebhook(event.rawBody, event.headers);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("ignored");
    expect(await prisma.subscription.count({ where: { externalBillingSubscriptionId: "sub_stranger" } })).toBe(0);
  });

  it("decides the plan from the price only — signed metadata claiming another plan is ignored", async () => {
    const { businessId, owner } = await business();
    await startCheckout(businessId, owner, "PRO");
    const customer = await prisma.billingCustomer.findUniqueOrThrow({ where: { businessId } });
    const event = signEvent({
      id: `evt_meta_${Date.now()}`,
      type: "subscription.updated",
      created: Date.now(),
      data: {
        plan: "MAX",
        metadata: { veyra_plan: "MAX" },
        subscription: {
          externalSubscriptionId: `sub_meta_${Date.now()}`,
          externalCustomerId: customer.externalCustomerId,
          priceId: "fake_price_pro",
          status: "active",
          cancelAtPeriodEnd: false
        }
      }
    });
    expect((await postWebhook(event.rawBody, event.headers)).status).toBe(200);
    expect((await accessFor(businessId)).plan).toBe("PRO");
  });

  it("ignores a price that isn't configured", async () => {
    const { businessId, owner } = await business();
    await startCheckout(businessId, owner, "PRO");
    const customer = await prisma.billingCustomer.findUniqueOrThrow({ where: { businessId } });
    const event = signEvent({
      id: `evt_price_${Date.now()}`,
      type: "subscription.updated",
      created: Date.now(),
      data: {
        subscription: {
          externalSubscriptionId: `sub_price_${Date.now()}`,
          externalCustomerId: customer.externalCustomerId,
          priceId: "price_someone_made_up",
          status: "active",
          cancelAtPeriodEnd: false
        }
      }
    });
    const res = await postWebhook(event.rawBody, event.headers);
    expect(res.body.outcome).toBe("ignored");
    expect((await accessFor(businessId)).plan).toBe("STARTER");
  });

  it("does not activate on an incomplete (unconfirmed) payment", async () => {
    const { businessId, owner } = await business();
    await startCheckout(businessId, owner, "PRO");
    const customer = await prisma.billingCustomer.findUniqueOrThrow({ where: { businessId } });
    const event = signEvent({
      id: `evt_incomplete_${Date.now()}`,
      type: "subscription.updated",
      created: Date.now(),
      data: {
        subscription: {
          externalSubscriptionId: `sub_incomplete_${Date.now()}`,
          externalCustomerId: customer.externalCustomerId,
          priceId: "fake_price_pro",
          status: "incomplete",
          cancelAtPeriodEnd: false
        }
      }
    });
    expect((await postWebhook(event.rawBody, event.headers)).body.outcome).toBe("ignored");
    expect((await accessFor(businessId)).plan).toBe("STARTER");
  });
});

/* ------------------------------------------------------------------ */

describe("plan changes", () => {
  it("upgrades Pro → Max only once the provider confirms", async () => {
    const { businessId, owner } = await paidBusiness("PRO");
    const res = await authed(request(app).post(`${base(businessId)}/billing/change-plan`), owner).send({ targetPlan: "MAX" });
    expect(res.status).toBe(202);
    expect(res.body.state).toBe("pending");
    expect((await accessFor(businessId)).plan).toBe("PRO");

    await deliverAll();
    const access = await accessFor(businessId);
    expect(access.plan).toBe("MAX");
    expect(access.entitlements.has("voice_reception")).toBe(true);
  });

  it("schedules Max → Pro for the end of the period, and applies it then", async () => {
    const { businessId, owner, externalSubscriptionId } = await paidBusiness("MAX");
    const res = await authed(request(app).post(`${base(businessId)}/billing/change-plan`), owner).send({ targetPlan: "PRO" });
    expect(res.status).toBe(202);
    await deliverAll();

    let subscription = await prisma.subscription.findUniqueOrThrow({ where: { businessId } });
    expect(subscription.plan).toBe("MAX");
    expect(subscription.scheduledPlan).toBe("PRO");
    expect(subscription.scheduledChangeAt?.getTime()).toBe(subscription.currentPeriodEnd?.getTime());
    const body = await overview(businessId, owner);
    expect(body.billing.scheduledPlan).toBe("PRO");
    expect(body.billing.actions.resume).toBe(true);
    expect(body.billing.actions.changePlan).toEqual([]);

    fakeBillingProvider.advanceToPeriodEnd(externalSubscriptionId);
    await deliverAll();
    subscription = await prisma.subscription.findUniqueOrThrow({ where: { businessId } });
    expect(subscription.plan).toBe("PRO");
    expect(subscription.scheduledPlan).toBeNull();
    expect((await accessFor(businessId)).entitlements.has("voice_reception")).toBe(false);
  });

  it("Pro → Starter: paid until period end, then Starter with every piece of data kept", async () => {
    const { businessId, owner, externalSubscriptionId, conversationId, serviceId, serviceName } = await paidBusiness("PRO");

    // A confirmed calendar booking made while on Pro.
    const now = at("2026-10-05T09:00");
    const availability = await checkAvailability({ businessId, serviceId, startTime: at("2026-10-06T15:00"), now });
    const held = await holdSlot({
      businessId,
      conversationId,
      serviceId,
      serviceName,
      start: availability.slot!.start,
      end: availability.slot!.end,
      timezone: availability.timezone,
      requestedTimeText: "Tuesday",
      now
    });
    await confirmHeldBooking({ appointmentId: held.appointment.id, now });
    const counts = async () => ({
      services: await prisma.service.count({ where: { businessId } }),
      bookings: await prisma.appointment.count({ where: { businessId } }),
      members: await prisma.businessMembership.count({ where: { businessId } }),
      connections: await prisma.calendarConnection.count({ where: { businessId } }),
      audit: await prisma.subscriptionEvent.count({ where: { businessId } })
    });
    const before = await counts();

    const res = await authed(request(app).post(`${base(businessId)}/billing/change-plan`), owner).send({ targetPlan: "STARTER" });
    expect(res.status).toBe(202);
    await deliverAll();

    let subscription = await prisma.subscription.findUniqueOrThrow({ where: { businessId } });
    expect(subscription.plan).toBe("PRO");
    expect(subscription.cancelAtPeriodEnd).toBe(true);
    expect(subscription.scheduledPlan).toBe("STARTER");
    expect((await calendarStatus(businessId)).live).toBe(true);

    fakeBillingProvider.advanceToPeriodEnd(externalSubscriptionId);
    await deliverAll();
    subscription = await prisma.subscription.findUniqueOrThrow({ where: { businessId } });
    expect(subscription).toMatchObject({ plan: "STARTER", status: "active", cancelAtPeriodEnd: false, scheduledPlan: null });
    expect(subscription.externalBillingSubscriptionId).toBeNull();
    expect((await calendarStatus(businessId)).live).toBe(false);

    const after = await counts();
    expect(after).toMatchObject({ ...before, audit: after.audit });
    expect(after.audit).toBeGreaterThan(before.audit);

    // The booking made on Pro can still be cancelled by staff (lapsed-plan cleanup).
    const cancel = await authed(
      request(app).patch(`${base(businessId)}/bookings/${held.appointment.id}/status`),
      owner
    ).send({ status: "cancelled" });
    expect(cancel.status).toBe(200);
    expect(fakeCalendarProvider.listEvents()[0].status).toBe("cancelled");

    // And Pro can be bought again.
    expect((await overview(businessId, owner)).billing.actions.checkout).toEqual(["PRO", "MAX"]);
  }, 60_000);

  it("cancel at period end, then resume", async () => {
    const { businessId, owner } = await paidBusiness("PRO");
    const cancel = await authed(request(app).post(`${base(businessId)}/billing/cancel`), owner).send({});
    expect(cancel.status).toBe(202);
    // Not applied until the provider confirms.
    expect((await prisma.subscription.findUniqueOrThrow({ where: { businessId } })).cancelAtPeriodEnd).toBe(false);
    await deliverAll();

    let body = await overview(businessId, owner);
    expect(body.billing.cancelAtPeriodEnd).toBe(true);
    expect(body.billing.scheduledChangeAt).toBe(body.currentPeriodEnd);
    expect(body.billing.actions).toMatchObject({ cancel: false, resume: true });
    expect(body.plan.code).toBe("PRO");

    const again = await authed(request(app).post(`${base(businessId)}/billing/cancel`), owner).send({});
    expect(again.status).toBe(409);

    const resume = await authed(request(app).post(`${base(businessId)}/billing/resume`), owner).send({});
    expect(resume.status).toBe(202);
    await deliverAll();
    body = await overview(businessId, owner);
    expect(body.billing.cancelAtPeriodEnd).toBe(false);
    expect(body.billing.scheduledPlan).toBeNull();

    const reasons = (await prisma.subscriptionEvent.findMany({ where: { businessId }, orderBy: { createdAt: "asc" } })).map(
      (event) => event.reason
    );
    expect(reasons.some((reason) => /Cancellation scheduled/.test(reason ?? ""))).toBe(true);
    expect(reasons.some((reason) => /resumed/.test(reason ?? ""))).toBe(true);
  });

  it("only the owner can change, cancel, resume or open the portal", async () => {
    const { businessId } = await paidBusiness("PRO");
    for (const role of ["ADMIN", "OPERATOR", "VIEWER"]) {
      const session = await member(businessId, role);
      for (const path of ["change-plan", "cancel", "resume", "portal"]) {
        const res = await authed(request(app).post(`${base(businessId)}/billing/${path}`), session).send({ targetPlan: "MAX" });
        expect(res.status, `${role} ${path}`).toBe(403);
      }
    }
    expect(fakeBillingProvider.pendingEventCount()).toBe(0);
  });

  it("opens the billing portal for a business with a billing account", async () => {
    const fresh = await business();
    const none = await authed(request(app).post(`${base(fresh.businessId)}/billing/portal`), fresh.owner).send({});
    expect(none.status).toBe(409);

    const { businessId, owner } = await paidBusiness("PRO");
    const res = await authed(request(app).post(`${base(businessId)}/billing/portal`), owner).send({});
    expect(res.status).toBe(200);
    expect(res.body.url).toContain("/api/billing/fake/portal/");
  });
});

/* ------------------------------------------------------------------ */

describe("status", () => {
  it("past_due keeps paid features running and flags the owner", async () => {
    const { businessId, owner, externalSubscriptionId } = await paidBusiness("PRO");
    fakeBillingProvider.failPayment(externalSubscriptionId);
    await deliverAll();

    const access = await accessFor(businessId);
    expect(access.status).toBe("past_due");
    expect(access.billingAttention).toBe(true);
    expect(access.degraded).toBe(false);
    expect((await calendarStatus(businessId)).live).toBe(true);
    expect((await overview(businessId, owner)).billingAttention).toBe(true);

    fakeBillingProvider.recoverPayment(externalSubscriptionId);
    await deliverAll();
    expect((await accessFor(businessId)).status).toBe("active");
  });

  it("when Starter is paid, an ended subscription is cancelled and falls back to core features", async () => {
    process.env.VEYRA_BILLING_STARTER_PRICE_ID = "fake_price_starter";
    process.env.VEYRA_BILLING_STARTER_AMOUNT = "900";
    const { businessId, owner } = await business("STARTER");
    await changePlan({ businessId, plan: "STARTER", status: "expired", actorType: "admin_script" });
    const { sessionId } = await startCheckout(businessId, owner, "PRO");
    fakeBillingProvider.completeCheckout(sessionId);
    await deliverAll();
    const subscription = await prisma.subscription.findUniqueOrThrow({ where: { businessId } });

    await fakeBillingProvider.cancelSubscription({
      externalSubscriptionId: subscription.externalBillingSubscriptionId!,
      atPeriodEnd: false
    });
    await deliverAll();

    const access = await accessFor(businessId);
    expect(access.status).toBe("cancelled");
    expect(access.degraded).toBe(true);
    expect(access.entitlements.has("core_reception")).toBe(true);
    expect(access.entitlements.has("calendar_booking")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("limits after a downgrade", () => {
  it("keeps every member, warns the owner, and blocks adding more", async () => {
    const { businessId, owner, externalSubscriptionId } = await paidBusiness("PRO");
    for (let i = 0; i < 4; i += 1) await member(businessId, "VIEWER"); // 5 members; Starter allows 3

    await authed(request(app).post(`${base(businessId)}/billing/change-plan`), owner).send({ targetPlan: "STARTER" });
    await deliverAll();
    fakeBillingProvider.advanceToPeriodEnd(externalSubscriptionId);
    await deliverAll();

    expect((await accessFor(businessId)).plan).toBe("STARTER");
    expect(await prisma.businessMembership.count({ where: { businessId } })).toBe(5);

    const body = await overview(businessId, owner);
    expect(body.billing.overLimit).toEqual([{ key: "team_members", label: "Team members", used: 5, allowed: 3 }]);

    const extra = await prisma.user.create({
      data: { email: `extra-${Date.now()}@billing.test`, name: "Extra", passwordHash }
    });
    const add = await authed(request(app).post(`${base(businessId)}/members`), owner).send({ email: extra.email, role: "VIEWER" });
    expect(add.status).toBe(403);
    expect(add.body.code).toBe("PLAN_LIMIT_REACHED");
  }, 60_000);
});

/* ------------------------------------------------------------------ */

describe("overview", () => {
  it("shows prices without provider price ids, and labels provisional pricing", async () => {
    const { businessId, owner } = await business();
    const body = await overview(businessId, owner);
    expect(body.billing).toMatchObject({ available: true, provider: "fake", simulated: true, canManage: true });
    expect(body.billing.prices.map((price: { plan: string }) => price.plan)).toEqual(["PRO", "MAX"]);
    expect(body.billing.prices.every((price: { final: boolean }) => price.final === false)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("fake_price_");
    expect(body.billing.actions.checkout).toEqual(["PRO", "MAX"]);
    expect(body.billing.trialDays).toBeNull();
  });

  it("lets an admin see billing but offers no actions", async () => {
    const { businessId } = await paidBusiness("PRO");
    const admin = await member(businessId, "ADMIN");
    const body = await overview(businessId, admin);
    expect(body.billing.canManage).toBe(false);
    expect(body.billing.hasPaidSubscription).toBe(true);
    expect(body.billing.actions).toEqual({ checkout: [], changePlan: [], portal: false, cancel: false, resume: false });
  });
});

/* ------------------------------------------------------------------ */

describe("development provider safety", () => {
  it("is refused in production, for configuration, webhooks and its pages", async () => {
    expect(configuredProviderName({ VEYRA_BILLING_PROVIDER: "fake", NODE_ENV: "production" })).toBeNull();
    expect(billingProviderByName("fake", { NODE_ENV: "production" })).toBeNull();

    process.env.NODE_ENV = "production";
    const webhook = await request(app).post("/api/billing/webhooks/fake").send("{}");
    expect(webhook.status).toBe(404);
    const page = await request(app).get("/api/billing/fake/checkout/cs_anything");
    expect(page.status).toBe(404);
  });

  it("requires both Stripe secrets before Stripe counts as configured", () => {
    expect(configuredProviderName({ VEYRA_BILLING_PROVIDER: "stripe" })).toBeNull();
    expect(configuredProviderName({ VEYRA_BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_x" })).toBeNull();
    expect(
      configuredProviderName({ VEYRA_BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" })
    ).toBe("stripe");
  });
});

describe("price configuration", () => {
  it("reads real prices only from the environment, and never gives a real provider example prices", () => {
    expect(configuredPrices("stripe", {})).toEqual([]);
    const prices = configuredPrices("stripe", {
      VEYRA_BILLING_PRO_PRICE_ID: "price_pro",
      VEYRA_BILLING_PRO_AMOUNT: "5900",
      VEYRA_BILLING_PRO_CURRENCY: "gbp",
      VEYRA_BILLING_MAX_PRICE_ID: "price_max",
      VEYRA_BILLING_MAX_AMOUNT: "not-a-number",
      VEYRA_BILLING_PRICES_FINAL: "true"
    });
    expect(prices).toEqual([
      {
        plan: "PRO",
        providerPriceId: "price_pro",
        currency: "gbp",
        interval: "month",
        amountMinor: 5900,
        displayAmount: "£59.00",
        final: true
      }
    ]);
    expect(planForPriceId("fake_price_max", "fake")).toBe("MAX");
    expect(planForPriceId("fake_price_max", "stripe")).toBeNull();
  });
});

describe("Stripe signature verification (unit — no Stripe account involved)", () => {
  const secret = "whsec_unit_test_secret";
  const body = Buffer.from('{"id":"evt_1","type":"customer.subscription.updated"}');
  const now = Date.now();
  const t = Math.floor(now / 1000);
  const sig = (s: string, ts = t) => createHmac("sha256", s).update(`${ts}.${body.toString()}`).digest("hex");

  it("accepts a valid signature, including alongside a rotated one", () => {
    expect(() => verifyStripeSignature(body, `t=${t},v1=${sig(secret)}`, secret, now)).not.toThrow();
    expect(() => verifyStripeSignature(body, `t=${t},v1=${sig("old")},v1=${sig(secret)}`, secret, now)).not.toThrow();
  });

  it("rejects a wrong secret, a tampered body, a stale timestamp and malformed headers", () => {
    expect(() => verifyStripeSignature(body, `t=${t},v1=${sig("whsec_wrong")}`, secret, now)).toThrow(WebhookVerificationError);
    expect(() => verifyStripeSignature(Buffer.from(body.toString() + " "), `t=${t},v1=${sig(secret)}`, secret, now)).toThrow(
      WebhookVerificationError
    );
    const old = t - 600;
    expect(() => verifyStripeSignature(body, `t=${old},v1=${sig(secret, old)}`, secret, now)).toThrow(/tolerance/);
    expect(() => verifyStripeSignature(body, undefined, secret, now)).toThrow(WebhookVerificationError);
    expect(() => verifyStripeSignature(body, "v1=abc", secret, now)).toThrow(WebhookVerificationError);
  });
});
