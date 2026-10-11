import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client.js";
import { changePlan, hasEntitlement } from "../src/services/access/accessService.js";
import { messagingPreflight, queueCustomerMessage } from "../src/services/messaging/outbound.js";
import { canSendToCustomer, recordConsent } from "../src/services/messaging/consent.js";
import { processPendingNotifications } from "../src/services/notifications/processor.js";
import { MAX_ATTEMPTS } from "../src/services/notifications/lease.js";
import { messagingOverview } from "../src/services/messaging/console.js";
import { messagingProviderFor, MessagingProviderError } from "../src/services/messaging/registry.js";
import {
  FAKE_INVALID_NUMBER,
  FAKE_OPTED_OUT_NUMBER,
  FAKE_TRANSIENT_FAILURE_NUMBER,
  capturedMessages,
  resetFakeMessaging
} from "../src/services/messaging/providers/fakeMessaging.js";

/**
 * Outbound messaging, end to end through the real notification worker with
 * the development provider behind it.
 *
 * Nothing here proves a message reached a handset — the provider is a
 * capture. What it does prove is everything Veyra is responsible for: that a
 * plan gate cannot be configured around, that an opt-out stops a send, that a
 * permanent failure is not retried four more times, and that one event cannot
 * become two messages.
 */

const CUSTOMER = "+14155552671";
const SENDER = "+14155550000";

let businessId: string;
let otherBusinessId: string;

async function createMessagingBusiness(options: { grant?: ("sms" | "whatsapp")[] } = {}): Promise<string> {
  const business = await prisma.business.create({
    data: { name: `Messaging Test ${Math.random().toString(36).slice(2, 8)}`, timezone: "UTC" }
  });
  await changePlan({
    businessId: business.id,
    plan: "PRO",
    status: "active",
    actorType: "system",
    reason: "test fixture"
  });

  // SMS and WhatsApp belong to no plan, so a test has to grant them the same
  // way a rollout would — deliberately, per business.
  for (const entitlement of options.grant ?? ["sms", "whatsapp"]) {
    await prisma.entitlementGrant.create({
      data: { businessId: business.id, entitlement, reason: "test fixture" }
    });
  }

  await prisma.messagingSettings.create({
    data: {
      businessId: business.id,
      smsEnabled: true,
      whatsappEnabled: true,
      smsProvider: "fake",
      whatsappProvider: "fake",
      smsSender: SENDER,
      whatsappSender: SENDER,
      customerMessagingEnabled: true,
      operatorMessagingEnabled: true
    }
  });
  return business.id;
}

async function settle(): Promise<void> {
  await processPendingNotifications();
  const deadline = Date.now() + 10_000;
  const mine = { businessId: { in: [businessId, otherBusinessId] }, claimToken: { not: null } };
  while ((await prisma.notification.count({ where: mine })) > 0) {
    if (Date.now() > deadline) throw new Error("notifications did not settle within 10s");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function sendOne(params: {
  businessId?: string;
  channel: "sms" | "whatsapp";
  to: string;
  body?: string;
  subject?: string;
}): Promise<string> {
  const { notificationId } = await queueCustomerMessage({
    businessId: params.businessId ?? businessId,
    channel: params.channel,
    type: "messaging.customer_notified",
    toPhone: params.to,
    subject: params.subject ?? "booking_confirmation",
    body: params.body ?? "Your appointment is confirmed for Monday at 3pm."
  });
  await settle();
  return notificationId;
}

beforeEach(async () => {
  resetFakeMessaging();
  businessId = await createMessagingBusiness();
  otherBusinessId = await createMessagingBusiness();
});

afterEach(async () => {
  for (const id of [businessId, otherBusinessId]) {
    await prisma.notification.deleteMany({ where: { businessId: id } });
    await prisma.domainEvent.deleteMany({ where: { businessId: id } });
  }
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { business: { name: { startsWith: "Messaging Test" } } } });
  await prisma.domainEvent.deleteMany({ where: { business: { name: { startsWith: "Messaging Test" } } } });
  await prisma.messagingConsent.deleteMany({ where: { business: { name: { startsWith: "Messaging Test" } } } });
  await prisma.messagingSettings.deleteMany({ where: { business: { name: { startsWith: "Messaging Test" } } } });
  await prisma.entitlementGrant.deleteMany({ where: { business: { name: { startsWith: "Messaging Test" } } } });
  await prisma.subscriptionEvent.deleteMany({ where: { business: { name: { startsWith: "Messaging Test" } } } });
  await prisma.subscription.deleteMany({ where: { business: { name: { startsWith: "Messaging Test" } } } });
  await prisma.business.deleteMany({ where: { name: { startsWith: "Messaging Test" } } });
});

describe("entitlements and configuration", () => {
  it("treats SMS and WhatsApp as belonging to no plan", async () => {
    const plain = await prisma.business.create({
      data: { name: `Messaging Test plain ${Math.random().toString(36).slice(2, 7)}`, timezone: "UTC" }
    });
    for (const plan of ["STARTER", "PRO", "MAX"] as const) {
      await changePlan({ businessId: plain.id, plan, status: "active", actorType: "system", reason: "test" });
      expect(await hasEntitlement(plain.id, "sms")).toBe(false);
      expect(await hasEntitlement(plain.id, "whatsapp")).toBe(false);
    }
  });

  it("grants a channel only through an explicit rollout grant", async () => {
    const id = await createMessagingBusiness({ grant: ["sms"] });
    expect(await hasEntitlement(id, "sms")).toBe(true);
    expect(await hasEntitlement(id, "whatsapp")).toBe(false);
  });

  it("ignores a grant that is revoked, expired, or names a paid feature", async () => {
    const id = await createMessagingBusiness({ grant: [] });

    await prisma.entitlementGrant.create({
      data: { businessId: id, entitlement: "sms", reason: "t", revokedAt: new Date() }
    });
    expect(await hasEntitlement(id, "sms")).toBe(false);

    await prisma.entitlementGrant.update({
      where: { businessId_entitlement: { businessId: id, entitlement: "sms" } },
      data: { revokedAt: null, expiresAt: new Date(Date.now() - 1000) }
    });
    expect(await hasEntitlement(id, "sms")).toBe(false);

    // A hand-written row naming a plan feature must grant nothing: the
    // rollout list is the whole permitted surface.
    await prisma.entitlementGrant.create({
      data: { businessId: id, entitlement: "voice_reception", reason: "should not work" }
    });
    expect(await hasEntitlement(id, "voice_reception")).toBe(false);
  });

  it("refuses to send when the channel is not entitled, however it is configured", async () => {
    const id = await createMessagingBusiness({ grant: [] });
    const preflight = await messagingPreflight({
      businessId: id,
      channel: "sms",
      toPhone: CUSTOMER,
      transactional: true
    });
    expect(preflight.allowed).toBe(false);
    expect(preflight.code).toBe("not_entitled");
  });

  it("refuses when the channel or customer messaging is switched off", async () => {
    await prisma.messagingSettings.update({ where: { businessId }, data: { smsEnabled: false } });
    expect((await messagingPreflight({ businessId, channel: "sms", toPhone: CUSTOMER, transactional: true })).code).toBe(
      "channel_disabled"
    );

    await prisma.messagingSettings.update({
      where: { businessId },
      data: { smsEnabled: true, customerMessagingEnabled: false }
    });
    expect((await messagingPreflight({ businessId, channel: "sms", toPhone: CUSTOMER, transactional: true })).code).toBe(
      "customer_messaging_disabled"
    );
  });

  it("refuses an ambiguous number instead of guessing a country", async () => {
    const preflight = await messagingPreflight({
      businessId,
      channel: "sms",
      toPhone: "03001234567",
      transactional: true
    });
    expect(preflight.allowed).toBe(false);
    expect(preflight.code).toBe("invalid_number");
  });
});

describe("SMS delivery through the worker", () => {
  it("sends a booking confirmation and records acceptance, not delivery", async () => {
    const id = await sendOne({ channel: "sms", to: CUSTOMER });

    const row = await prisma.notification.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("sent");
    expect(row.channel).toBe("sms");
    expect(row.recipientPhone).toBe(CUSTOMER);
    expect(row.userId).toBeNull();
    expect(row.providerMessageId).toMatch(/^fake_sms_/);
    // The provider took it. Nothing claims a handset received it.
    expect(row.deliveryStatus).toBe("accepted");
    expect(row.deliveryStatus).not.toBe("delivered");

    const sent = capturedMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(CUSTOMER);
    expect(sent[0].from).toBe(SENDER);
  });

  it("carries reschedule and cancellation confirmations the same way", async () => {
    await sendOne({ channel: "sms", to: CUSTOMER, body: "Your appointment moved to Tuesday at 4pm." });
    await sendOne({ channel: "sms", to: CUSTOMER, body: "Your appointment on Tuesday is cancelled." });

    const sent = capturedMessages();
    expect(sent).toHaveLength(2);
    expect(sent[0].body).toContain("Tuesday at 4pm");
    expect(sent[1].body).toContain("cancelled");
  });

  it("strips markdown before the message reaches the provider", async () => {
    await sendOne({ channel: "sms", to: CUSTOMER, body: "**Whitening** is $250." });
    expect(capturedMessages()[0].body).toBe("Whitening is $250.");
  });
});

describe("failure classification and retry", () => {
  it("fails a permanent error immediately rather than spending the retry schedule", async () => {
    const id = await sendOne({ channel: "sms", to: FAKE_INVALID_NUMBER });

    const row = await prisma.notification.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("failed");
    expect(row.attemptCount).toBe(1);
    expect(row.attemptCount).toBeLessThan(MAX_ATTEMPTS);
    expect(row.nextAttemptAt).toBeNull();
    expect(row.failureReason).toMatch(/not a valid mobile number/i);
    expect(capturedMessages()).toHaveLength(0);
  });

  it("retries a transient error with backoff", async () => {
    const id = await sendOne({ channel: "sms", to: FAKE_TRANSIENT_FAILURE_NUMBER });

    const row = await prisma.notification.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("pending");
    expect(row.attemptCount).toBe(1);
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(row.failureReason).toMatch(/rate limiting/i);
  });

  it("stops at a provider-reported opt-out without sending", async () => {
    const id = await sendOne({ channel: "sms", to: FAKE_OPTED_OUT_NUMBER });

    const row = await prisma.notification.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("failed");
    expect(row.nextAttemptAt).toBeNull();
    expect(capturedMessages()).toHaveLength(0);
  });
});

describe("consent", () => {
  it("does not treat a number in the database as consent", async () => {
    expect(
      (await canSendToCustomer({ businessId, channel: "sms", phone: CUSTOMER, transactional: false })).allowed
    ).toBe(false);
    // A transactional reply is still allowed while consent is unknown.
    expect(
      (await canSendToCustomer({ businessId, channel: "sms", phone: CUSTOMER, transactional: true })).allowed
    ).toBe(true);
  });

  it("stops every message on a channel once the customer opts out", async () => {
    await recordConsent({ businessId, channel: "sms", phone: CUSTOMER, state: "revoked", source: "stop_keyword" });

    const preflight = await messagingPreflight({ businessId, channel: "sms", toPhone: CUSTOMER, transactional: true });
    expect(preflight.allowed).toBe(false);
    expect(preflight.code).toBe("opted_out");

    // And the worker re-checks: a message queued before the opt-out must not
    // go out after it.
    await recordConsent({ businessId, channel: "sms", phone: CUSTOMER, state: "granted", source: "operator" });
    const { notificationId } = await queueCustomerMessage({
      businessId,
      channel: "sms",
      type: "messaging.customer_notified",
      toPhone: CUSTOMER,
      subject: "booking_confirmation",
      body: "Confirmed."
    });
    await recordConsent({ businessId, channel: "sms", phone: CUSTOMER, state: "revoked", source: "stop_keyword" });
    await settle();

    const row = await prisma.notification.findUniqueOrThrow({ where: { id: notificationId } });
    expect(row.status).toBe("failed");
    expect(row.failureReason).toMatch(/opted out/i);
    expect(capturedMessages()).toHaveLength(0);
  });

  it("keeps SMS and WhatsApp consent separate", async () => {
    await recordConsent({ businessId, channel: "sms", phone: CUSTOMER, state: "revoked", source: "stop_keyword" });

    expect((await canSendToCustomer({ businessId, channel: "sms", phone: CUSTOMER, transactional: true })).allowed).toBe(
      false
    );
    // Opting out of texts is not opting out of WhatsApp.
    expect(
      (await canSendToCustomer({ businessId, channel: "whatsapp", phone: CUSTOMER, transactional: true })).allowed
    ).toBe(true);
  });

  it("scopes consent to one business", async () => {
    await recordConsent({ businessId, channel: "sms", phone: CUSTOMER, state: "revoked", source: "stop_keyword" });
    expect(
      (await canSendToCustomer({ businessId: otherBusinessId, channel: "sms", phone: CUSTOMER, transactional: true }))
        .allowed
    ).toBe(true);
  });
});

describe("idempotency and tenancy", () => {
  it("cannot turn one event into two messages to the same number", async () => {
    const { eventId } = await queueCustomerMessage({
      businessId,
      channel: "sms",
      type: "messaging.customer_notified",
      toPhone: CUSTOMER,
      subject: "booking_confirmation",
      body: "Confirmed."
    });

    await expect(
      prisma.notification.create({
        data: {
          businessId,
          recipientPhone: CUSTOMER,
          eventId,
          channel: "sms",
          subject: "booking_confirmation",
          body: "Confirmed again.",
          nextAttemptAt: new Date()
        }
      })
    ).rejects.toThrow();

    expect(await prisma.notification.count({ where: { eventId } })).toBe(1);
  });

  it("refuses a phone-channel row with no number, and a phone on a non-phone channel", async () => {
    const event = await prisma.domainEvent.create({
      data: { businessId, type: "messaging.reply", entityType: "system", entityId: businessId, payload: "{}" }
    });

    await expect(
      prisma.notification.create({
        data: { businessId, eventId: event.id, channel: "sms", subject: "s", body: "b", userId: null }
      })
    ).rejects.toThrow();

    await expect(
      prisma.notification.create({
        data: {
          businessId,
          eventId: event.id,
          channel: "email",
          recipientPhone: CUSTOMER,
          subject: "s",
          body: "b"
        }
      })
    ).rejects.toThrow();
  });

  it("keeps one business's messages out of another's", async () => {
    await sendOne({ channel: "sms", to: CUSTOMER });
    expect(await prisma.notification.count({ where: { businessId, channel: "sms" } })).toBe(1);
    expect(await prisma.notification.count({ where: { businessId: otherBusinessId, channel: "sms" } })).toBe(0);
  });
});

describe("provider registry and console status", () => {
  it("refuses an unknown provider rather than falling back to the fake", () => {
    expect(() => messagingProviderFor("sms", "twilio")).toThrow(MessagingProviderError);
    expect(() => messagingProviderFor("sms", null)).toThrow(/No SMS provider is configured/);
  });

  it("never reports a development provider as healthy", async () => {
    const overview = await messagingOverview(businessId, true);
    expect(overview.sms.simulated).toBe(true);
    expect(overview.sms.health).toBe("configured");
    expect(overview.sms.health).not.toBe("healthy");
    expect(overview.sms.detail).toMatch(/nothing is delivered to a real handset/i);
  });

  it("masks the sender number and reports usage only once there is any", async () => {
    const before = await messagingOverview(businessId, true);
    expect(before.sms.sender).toBe("+14••••00");
    expect(before.sms.sender).not.toContain("5550000");
    expect(before.usage.smsMessages).toBeNull();

    await sendOne({ channel: "sms", to: CUSTOMER });
    const after = await messagingOverview(businessId, true);
    expect(after.usage.smsMessages).toBe(1);
  });

  it("says a channel is not configured when the plan does not include it", async () => {
    const id = await createMessagingBusiness({ grant: [] });
    const overview = await messagingOverview(id, true);
    expect(overview.sms.entitled).toBe(false);
    expect(overview.sms.health).toBe("not_configured");
    expect(overview.sms.detail).toMatch(/not included in this plan/i);
  });
});
