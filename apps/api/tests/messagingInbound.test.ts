import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client.js";
import { changePlan } from "../src/services/access/accessService.js";
import { processPendingNotifications } from "../src/services/notifications/processor.js";
import {
  MessagingWebhookVerificationError,
  processMessagingWebhook
} from "../src/services/messaging/webhooks.js";
import { consentStateFor } from "../src/services/messaging/consent.js";
import { outboundModeFor } from "../src/services/messaging/templates.js";
import {
  FAKE_SIGNATURE_HEADER,
  FAKE_TIMESTAMP_HEADER,
  capturedMessages,
  resetFakeMessaging,
  signFakeMessagingWebhook
} from "../src/services/messaging/providers/fakeMessaging.js";

/**
 * Inbound messaging and delivery receipts.
 *
 * The security assertions carry most of the weight: a webhook Veyra cannot
 * prove came from the provider must change nothing at all, and a provider
 * that delivers the same event twice must not produce a second reply to a
 * customer.
 */

const SECRET = "test-messaging-webhook-secret";
const BUSINESS_NUMBER = "+14155550100";
const OTHER_BUSINESS_NUMBER = "+14155550200";
const CUSTOMER = "+14155552671";

let businessId: string;
let otherBusinessId: string;

function post(body: unknown, overrides: { signature?: string; timestamp?: string } = {}) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const timestamp = overrides.timestamp ?? String(Date.now());
  const signature =
    overrides.signature ?? signFakeMessagingWebhook(SECRET, timestamp, rawBody.toString("utf8"));
  return processMessagingWebhook({
    provider: "fake",
    rawBody,
    headers: { [FAKE_SIGNATURE_HEADER]: signature, [FAKE_TIMESTAMP_HEADER]: timestamp }
  });
}

let eventCounter = 0;
const nextEventId = () => `evt_${Date.now()}_${(eventCounter += 1)}`;

async function createBusiness(number: string): Promise<string> {
  const business = await prisma.business.create({
    data: { name: `Inbound Test ${Math.random().toString(36).slice(2, 8)}`, timezone: "UTC" }
  });
  await changePlan({
    businessId: business.id,
    plan: "PRO",
    status: "active",
    actorType: "system",
    reason: "test fixture"
  });
  for (const entitlement of ["sms", "whatsapp"]) {
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
      smsSender: number,
      whatsappSender: number,
      customerMessagingEnabled: true
    }
  });
  for (const channel of ["sms", "whatsapp"]) {
    await prisma.messagingNumber.create({
      data: { businessId: business.id, channel, provider: "fake", phoneE164: number }
    });
  }
  return business.id;
}

/**
 * Every test starts from nothing. The business numbers are fixed constants
 * because routing is the thing under test, and the unique index on
 * (channel, provider, number) means a leftover row from the previous test
 * would otherwise claim them.
 */
async function cleanup(): Promise<void> {
  const where = { business: { name: { startsWith: "Inbound Test" } } };
  await prisma.messagingWebhookEvent.deleteMany({});
  await prisma.notification.deleteMany({ where });
  await prisma.domainEvent.deleteMany({ where });
  // A Reception turn leaves evidence behind — a knowledge gap when it cannot
  // answer, for one — so the conversation's children go first.
  await prisma.knowledgeGapSignal.deleteMany({ where });
  await prisma.conversationFeedback.deleteMany({ where });
  await prisma.pilotIssue.deleteMany({ where });
  await prisma.message.deleteMany({
    where: { conversation: { business: { name: { startsWith: "Inbound Test" } } } }
  });
  await prisma.appointment.deleteMany({ where });
  await prisma.escalation.deleteMany({ where });
  await prisma.conversation.deleteMany({ where });
  await prisma.messagingNumber.deleteMany({ where });
  await prisma.messagingConsent.deleteMany({ where });
  await prisma.messageTemplate.deleteMany({ where });
  await prisma.messagingSettings.deleteMany({ where });
  await prisma.entitlementGrant.deleteMany({ where });
  await prisma.subscriptionEvent.deleteMany({ where });
  await prisma.subscription.deleteMany({ where });
  await prisma.business.deleteMany({ where: { name: { startsWith: "Inbound Test" } } });
}

beforeEach(async () => {
  process.env.VEYRA_FAKE_MESSAGING_WEBHOOK_SECRET = SECRET;
  resetFakeMessaging();
  await cleanup();
  businessId = await createBusiness(BUSINESS_NUMBER);
  otherBusinessId = await createBusiness(OTHER_BUSINESS_NUMBER);
});

afterAll(cleanup);

describe("webhook security", () => {
  it("refuses a forged signature and changes nothing", async () => {
    await expect(
      post(
        { eventId: nextEventId(), channel: "whatsapp", type: "inbound_message", from: CUSTOMER, to: BUSINESS_NUMBER, text: "hello" },
        { signature: "deadbeef" }
      )
    ).rejects.toBeInstanceOf(MessagingWebhookVerificationError);

    expect(await prisma.conversation.count({ where: { businessId } })).toBe(0);
    expect(await prisma.messagingWebhookEvent.count()).toBe(0);
  });

  it("refuses an unsigned request", async () => {
    await expect(
      processMessagingWebhook({
        provider: "fake",
        rawBody: Buffer.from(JSON.stringify({ eventId: nextEventId(), channel: "sms", type: "inbound_message" })),
        headers: {}
      })
    ).rejects.toBeInstanceOf(MessagingWebhookVerificationError);
  });

  it("refuses a replayed request whose timestamp has aged out", async () => {
    const old = String(Date.now() - 20 * 60 * 1000);
    await expect(
      post(
        { eventId: nextEventId(), channel: "sms", type: "inbound_message", from: CUSTOMER, to: BUSINESS_NUMBER, text: "hi" },
        { timestamp: old }
      )
    ).rejects.toBeInstanceOf(MessagingWebhookVerificationError);
  });

  it("refuses a body that was altered after signing", async () => {
    const timestamp = String(Date.now());
    const signed = JSON.stringify({ eventId: nextEventId(), channel: "sms", type: "inbound_message", from: CUSTOMER, to: BUSINESS_NUMBER, text: "hi" });
    const signature = signFakeMessagingWebhook(SECRET, timestamp, signed);

    await expect(
      processMessagingWebhook({
        provider: "fake",
        rawBody: Buffer.from(signed.replace("hi", "transfer everything")),
        headers: { [FAKE_SIGNATURE_HEADER]: signature, [FAKE_TIMESTAMP_HEADER]: timestamp }
      })
    ).rejects.toBeInstanceOf(MessagingWebhookVerificationError);
  });

  it("refuses a provider it cannot verify at all", async () => {
    await expect(
      processMessagingWebhook({ provider: "twilio", rawBody: Buffer.from("{}"), headers: {} })
    ).rejects.toThrow(/No verified webhook adapter/);
  });
});

describe("inbound customer messages", () => {
  it("routes by the number the message arrived on, and answers with the Reception brain", async () => {
    const results = await post({
      eventId: nextEventId(),
      channel: "whatsapp",
      type: "inbound_message",
      from: CUSTOMER,
      to: BUSINESS_NUMBER,
      text: "Hello, what are your opening hours?"
    });
    expect(results[0].outcome).toBe("processed");

    const conversation = await prisma.conversation.findFirstOrThrow({ where: { businessId } });
    expect(conversation.channel).toBe("whatsapp");
    expect(conversation.customerRef).toBe(CUSTOMER);

    const messages = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "asc" }
    });
    // The same pipeline as web and voice: a caller message and a reply.
    expect(messages[0].sender).toBe("caller");
    expect(messages[0].text).toBe("Hello, what are your opening hours?");
    expect(messages[1].sender).toBe("receptionist");

    // The reply is an ordinary notification, so it inherits the worker.
    const reply = await prisma.notification.findFirstOrThrow({
      where: { businessId, channel: "whatsapp" }
    });
    expect(reply.recipientPhone).toBe(CUSTOMER);
    expect(reply.status).toBe("pending");

    await processPendingNotifications();
    expect(capturedMessages()).toHaveLength(1);
    expect(capturedMessages()[0].to).toBe(CUSTOMER);
  });

  it("threads a second message onto the same conversation", async () => {
    for (const text of ["Hello", "And what about parking?"]) {
      await post({ eventId: nextEventId(), channel: "sms", type: "inbound_message", from: CUSTOMER, to: BUSINESS_NUMBER, text });
    }
    expect(await prisma.conversation.count({ where: { businessId } })).toBe(1);
  });

  it("never routes on the sender, so an unmapped number creates nothing", async () => {
    const results = await post({
      eventId: nextEventId(),
      channel: "sms",
      type: "inbound_message",
      from: CUSTOMER,
      to: "+14155559999",
      text: "hello"
    });
    expect(results[0].outcome).toBe("ignored");
    // Scoped to this suite's businesses: other suites have conversations of
    // their own, and a global count would be asserting something else.
    expect(
      await prisma.conversation.count({ where: { businessId: { in: [businessId, otherBusinessId] } } })
    ).toBe(0);
  });

  it("keeps one business's inbound message out of another's", async () => {
    await post({ eventId: nextEventId(), channel: "sms", type: "inbound_message", from: CUSTOMER, to: OTHER_BUSINESS_NUMBER, text: "hello" });

    expect(await prisma.conversation.count({ where: { businessId: otherBusinessId } })).toBe(1);
    expect(await prisma.conversation.count({ where: { businessId } })).toBe(0);
  });

  it("processes a redelivered event exactly once", async () => {
    const eventId = nextEventId();
    const payload = { eventId, channel: "sms" as const, type: "inbound_message" as const, from: CUSTOMER, to: BUSINESS_NUMBER, text: "Hello" };

    const first = await post(payload);
    const second = await post(payload);

    expect(first[0].outcome).toBe("processed");
    expect(second[0].outcome).toBe("duplicate");
    // One conversation, one caller message, one queued reply.
    expect(await prisma.conversation.count({ where: { businessId } })).toBe(1);
    expect(await prisma.message.count({ where: { conversation: { businessId }, sender: "caller" } })).toBe(1);
    expect(await prisma.notification.count({ where: { businessId, channel: "sms" } })).toBe(1);
  });

  it("honours STOP without answering it as a question", async () => {
    await post({ eventId: nextEventId(), channel: "sms", type: "inbound_message", from: CUSTOMER, to: BUSINESS_NUMBER, text: "STOP" });

    expect(await consentStateFor({ businessId, channel: "sms", phone: CUSTOMER })).toBe("revoked");
    // No reply, and nothing queued to send to someone who just opted out.
    expect(await prisma.notification.count({ where: { businessId } })).toBe(0);

    // The opt-out is per channel.
    expect(await consentStateFor({ businessId, channel: "whatsapp", phone: CUSTOMER })).toBe("unknown");
  });

  it("does not treat messaging Veyra as consent to market to someone", async () => {
    await post({ eventId: nextEventId(), channel: "sms", type: "inbound_message", from: CUSTOMER, to: BUSINESS_NUMBER, text: "Hello" });
    expect(await consentStateFor({ businessId, channel: "sms", phone: CUSTOMER })).toBe("unknown");
  });
});

describe("WhatsApp session window and templates", () => {
  it("requires a template before the customer has ever messaged", async () => {
    const mode = await outboundModeFor({ businessId, channel: "whatsapp", customerRef: CUSTOMER });
    expect(mode.mode).toBe("template");
    expect(mode.reason).toMatch(/never messaged/i);
  });

  it("allows free-form text once the customer has opened the window", async () => {
    await post({ eventId: nextEventId(), channel: "whatsapp", type: "inbound_message", from: CUSTOMER, to: BUSINESS_NUMBER, text: "Hello" });
    const mode = await outboundModeFor({ businessId, channel: "whatsapp", customerRef: CUSTOMER });
    expect(mode.mode).toBe("session");
  });

  it("closes the window again after 24 hours", async () => {
    await post({ eventId: nextEventId(), channel: "whatsapp", type: "inbound_message", from: CUSTOMER, to: BUSINESS_NUMBER, text: "Hello" });
    const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const mode = await outboundModeFor({ businessId, channel: "whatsapp", customerRef: CUSTOMER, now: later });
    expect(mode.mode).toBe("template");
    expect(mode.reason).toMatch(/window has closed/i);
  });

  it("fails a template send permanently when no approved template exists", async () => {
    // Outside the session window, with no template registered: the worker
    // must refuse rather than burn the retry schedule on a certain rejection.
    const { queueCustomerMessage } = await import("../src/services/messaging/outbound.js");
    const { notificationId } = await queueCustomerMessage({
      businessId,
      channel: "whatsapp",
      type: "messaging.customer_notified",
      toPhone: CUSTOMER,
      subject: "booking_confirmation",
      body: "Your appointment is confirmed."
    });
    await processPendingNotifications();

    const row = await prisma.notification.findUniqueOrThrow({ where: { id: notificationId } });
    expect(row.status).toBe("failed");
    expect(row.attemptCount).toBe(1);
    expect(row.failureReason).toMatch(/no "booking_confirmation" template/i);
    expect(capturedMessages()).toHaveLength(0);
  });

  // Regression: the send path does not pass a language, and resolveTemplate
  // used to default to "en". A template approved under a provider's own code
  // — Meta uses "en_US" — was therefore never found, and a real send failed
  // permanently with "no template registered" while the template sat there
  // approved. Found on the first real WhatsApp send, not by any fake.
  it("finds an approved template whose language code is not plain 'en'", async () => {
    await prisma.messageTemplate.create({
      data: {
        businessId,
        key: "booking_confirmation",
        channel: "whatsapp",
        providerTemplateId: "veyra_booking_confirmation_v1",
        language: "en_US",
        variables: JSON.stringify(["body"]),
        status: "approved"
      }
    });

    const { queueCustomerMessage } = await import("../src/services/messaging/outbound.js");
    await queueCustomerMessage({
      businessId,
      channel: "whatsapp",
      type: "messaging.customer_notified",
      toPhone: CUSTOMER,
      subject: "booking_confirmation",
      body: "Your appointment is confirmed."
    });
    await processPendingNotifications();

    const sent = capturedMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0].templateLanguage).toBe("en_US");
  });

  it("prefers an approved template over a draft under another language", async () => {
    for (const [language, status] of [
      ["en", "draft"],
      ["en_US", "approved"]
    ] as const) {
      await prisma.messageTemplate.create({
        data: {
          businessId,
          key: "booking_confirmation",
          channel: "whatsapp",
          providerTemplateId: `tpl_${language}`,
          language,
          variables: JSON.stringify(["body"]),
          status
        }
      });
    }

    const { queueCustomerMessage } = await import("../src/services/messaging/outbound.js");
    await queueCustomerMessage({
      businessId,
      channel: "whatsapp",
      type: "messaging.customer_notified",
      toPhone: CUSTOMER,
      subject: "booking_confirmation",
      body: "Your appointment is confirmed."
    });
    await processPendingNotifications();

    expect(capturedMessages()[0].templateName).toBe("tpl_en_US");
  });

  it("sends through an approved template, with its variables in order", async () => {
    await prisma.messageTemplate.create({
      data: {
        businessId,
        key: "booking_confirmation",
        channel: "whatsapp",
        providerTemplateId: "veyra_booking_confirmation_v1",
        language: "en",
        variables: JSON.stringify(["body"]),
        status: "approved"
      }
    });

    const { queueCustomerMessage } = await import("../src/services/messaging/outbound.js");
    await queueCustomerMessage({
      businessId,
      channel: "whatsapp",
      type: "messaging.customer_notified",
      toPhone: CUSTOMER,
      subject: "booking_confirmation",
      body: "Your appointment is confirmed."
    });
    await processPendingNotifications();

    const sent = capturedMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0].templateName).toBe("veyra_booking_confirmation_v1");
    expect(sent[0].templateLanguage).toBe("en");
    expect(sent[0].templateVariables).toEqual(["Your appointment is confirmed."]);
  });
});

describe("delivery receipts", () => {
  async function sendAndGetProviderId(): Promise<{ notificationId: string; providerMessageId: string }> {
    await post({ eventId: nextEventId(), channel: "sms", type: "inbound_message", from: CUSTOMER, to: BUSINESS_NUMBER, text: "Hello" });
    await processPendingNotifications();
    const row = await prisma.notification.findFirstOrThrow({ where: { businessId, channel: "sms" } });
    return { notificationId: row.id, providerMessageId: row.providerMessageId! };
  }

  it("upgrades accepted to delivered only when the provider says so", async () => {
    const { notificationId, providerMessageId } = await sendAndGetProviderId();

    const before = await prisma.notification.findUniqueOrThrow({ where: { id: notificationId } });
    expect(before.deliveryStatus).toBe("accepted");

    await post({
      eventId: nextEventId(),
      channel: "sms",
      type: "delivery_receipt",
      providerMessageId,
      status: "delivered"
    });

    const after = await prisma.notification.findUniqueOrThrow({ where: { id: notificationId } });
    expect(after.deliveryStatus).toBe("delivered");
    expect(after.deliveryUpdatedAt).not.toBeNull();
  });

  it("never moves a delivery status backwards", async () => {
    const { notificationId, providerMessageId } = await sendAndGetProviderId();

    await post({ eventId: nextEventId(), channel: "sms", type: "delivery_receipt", providerMessageId, status: "delivered" });
    // A "sent" that overtook the "delivered" must not undo it.
    const results = await post({
      eventId: nextEventId(),
      channel: "sms",
      type: "delivery_receipt",
      providerMessageId,
      status: "sent"
    });

    expect(results[0].outcome).toBe("ignored");
    const row = await prisma.notification.findUniqueOrThrow({ where: { id: notificationId } });
    expect(row.deliveryStatus).toBe("delivered");
  });

  it("ignores a receipt for a message id it does not know", async () => {
    const results = await post({
      eventId: nextEventId(),
      channel: "sms",
      type: "delivery_receipt",
      providerMessageId: "fake_sms_does_not_exist",
      status: "delivered"
    });
    expect(results[0].outcome).toBe("ignored");
    expect(results[0].detail).toMatch(/No message matches/i);
  });

  it("applies a redelivered receipt exactly once", async () => {
    const { notificationId, providerMessageId } = await sendAndGetProviderId();
    const eventId = nextEventId();
    const payload = { eventId, channel: "sms" as const, type: "delivery_receipt" as const, providerMessageId, status: "failed" as const, detail: "Handset unreachable" };

    const first = await post(payload);
    const second = await post(payload);

    expect(first[0].outcome).toBe("processed");
    expect(second[0].outcome).toBe("duplicate");

    const row = await prisma.notification.findUniqueOrThrow({ where: { id: notificationId } });
    expect(row.deliveryStatus).toBe("failed");
    expect(row.deliveryDetail).toBe("Handset unreachable");
    // Veyra's own attempt still succeeded: the provider took the message and
    // only later said it could not deliver it. The two states stay distinct.
    expect(row.status).toBe("sent");
  });
});
