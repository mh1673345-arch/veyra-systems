import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createHmac } from "node:crypto";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { changePlan } from "../src/services/access/accessService.js";
import { processPendingNotifications } from "../src/services/notifications/processor.js";
import { findByPhone } from "../src/services/contacts/contactService.js";
import {
  MetaWhatsAppWebhookAdapter,
  answerVerificationChallenge,
  metaWebhookConfig,
  missingMetaWebhookConfig
} from "../src/services/messaging/providers/metaWhatsAppWebhook.js";
import { processMessagingWebhook } from '../src/services/messaging/webhooks.js';
import { capturedMessages, resetFakeMessaging } from "../src/services/messaging/providers/fakeMessaging.js";

/**
 * The Meta WhatsApp webhook.
 *
 * No network: every request here is made against Veyra's own app with a
 * signature this file computes. What it proves is that a forged payload
 * changes nothing, that Graph's shapes are translated correctly, that a
 * redelivery is harmless, and that an unmapped sender cannot reach a
 * business it was not addressed to.
 *
 * The outbound provider stays "fake" throughout, so no WhatsApp message can
 * leave during a test run.
 */

const APP_SECRET = "test-meta-app-secret";
const VERIFY_TOKEN = "test-meta-verify-token";
const PHONE_NUMBER_ID = "111222333";
const OTHER_PHONE_NUMBER_ID = "999888777";
const DISPLAY_NUMBER = "15551856920";
const CUSTOMER = "+923134826612";

const app = createApp();
let businessId: string;
let otherBusinessId: string;
let counter = 0;
const nextWamid = () => `wamid.TEST${Date.now()}${(counter += 1)}`;

function sign(body: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(Buffer.from(body, "utf8")).digest("hex")}`;
}

function messagePayload(options: { text: string; wamid: string; phoneNumberId?: string }) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: DISPLAY_NUMBER,
                phone_number_id: options.phoneNumberId ?? PHONE_NUMBER_ID
              },
              contacts: [{ profile: { name: "Test Customer" }, wa_id: CUSTOMER.slice(1) }],
              messages: [
                {
                  from: CUSTOMER.slice(1),
                  id: options.wamid,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: options.text }
                }
              ]
            }
          }
        ]
      }
    ]
  };
}

function statusPayload(options: { wamid: string; status: string; error?: { code: number; title: string } }) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: DISPLAY_NUMBER, phone_number_id: PHONE_NUMBER_ID },
              statuses: [
                {
                  id: options.wamid,
                  status: options.status,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  recipient_id: CUSTOMER.slice(1),
                  ...(options.error ? { errors: [options.error] } : {})
                }
              ]
            }
          }
        ]
      }
    ]
  };
}

const WEBHOOK = "/api/messaging/whatsapp/meta/webhook";

function post(payload: unknown, signature?: string) {
  const body = JSON.stringify(payload);
  return request(app)
    .post(WEBHOOK)
    .set("content-type", "application/json")
    .set("x-hub-signature-256", signature ?? sign(body))
    .send(body);
}

/**
 * The route acknowledges Meta before doing the work, which is right for a
 * webhook and useless for an assertion. Processing is therefore driven
 * directly here — the same verify-then-process the route runs, awaited
 * rather than fired and forgotten, through the real adapter and the real
 * inbound pipeline.
 */
async function deliver(payload: unknown) {
  const body = JSON.stringify(payload);
  return processMessagingWebhook({
    provider: 'meta',
    rawBody: Buffer.from(body, 'utf8'),
    headers: { 'x-hub-signature-256': sign(body) }
  });
}

async function createBusiness(phoneNumberId: string): Promise<string> {
  const business = await prisma.business.create({
    data: { name: `Meta Hook Test ${Math.random().toString(36).slice(2, 8)}`, timezone: "UTC" }
  });
  await changePlan({
    businessId: business.id,
    plan: "PRO",
    status: "active",
    actorType: "system",
    reason: "test fixture"
  });
  await prisma.entitlementGrant.create({
    data: { businessId: business.id, entitlement: "whatsapp", reason: "test fixture" }
  });
  await prisma.messagingSettings.create({
    data: {
      businessId: business.id,
      whatsappEnabled: true,
      // The outbound side stays fake: a test must never reach Meta.
      whatsappProvider: "fake",
      whatsappSender: `+${DISPLAY_NUMBER}`,
      customerMessagingEnabled: true
    }
  });
  await prisma.messagingNumber.create({
    data: {
      businessId: business.id,
      channel: "whatsapp",
      provider: "meta",
      providerNumberId: phoneNumberId,
      phoneE164: `+${DISPLAY_NUMBER}${phoneNumberId === PHONE_NUMBER_ID ? "" : "1"}`
    }
  });
  return business.id;
}

async function cleanup(): Promise<void> {
  const where = { business: { name: { startsWith: "Meta Hook Test" } } };
  await prisma.messagingWebhookEvent.deleteMany({});
  await prisma.notification.deleteMany({ where });
  await prisma.domainEvent.deleteMany({ where });
  await prisma.knowledgeGapSignal.deleteMany({ where });
  await prisma.conversationFeedback.deleteMany({ where });
  await prisma.pilotIssue.deleteMany({ where });
  await prisma.message.deleteMany({
    where: { conversation: { business: { name: { startsWith: "Meta Hook Test" } } } }
  });
  await prisma.appointment.deleteMany({ where });
  await prisma.escalation.deleteMany({ where });
  await prisma.conversation.deleteMany({ where });
  await prisma.customerContact.deleteMany({ where });
  await prisma.messagingNumber.deleteMany({ where });
  await prisma.messagingConsent.deleteMany({ where });
  await prisma.messagingSettings.deleteMany({ where });
  await prisma.entitlementGrant.deleteMany({ where });
  await prisma.subscriptionEvent.deleteMany({ where });
  await prisma.subscription.deleteMany({ where });
  await prisma.business.deleteMany({ where: { name: { startsWith: "Meta Hook Test" } } });
}

beforeEach(async () => {
  process.env.META_APP_SECRET = APP_SECRET;
  process.env.META_WHATSAPP_VERIFY_TOKEN = VERIFY_TOKEN;
  resetFakeMessaging();
  await cleanup();
  businessId = await createBusiness(PHONE_NUMBER_ID);
  otherBusinessId = await createBusiness(OTHER_PHONE_NUMBER_ID);
});

afterAll(cleanup);

describe("subscription handshake", () => {
  it("returns the challenge when the token matches", async () => {
    const res = await request(app)
      .get(WEBHOOK)
      .query({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "12345" });

    expect(res.status).toBe(200);
    // Meta wants the bare challenge: not JSON, not quoted, nothing appended.
    expect(res.text).toBe("12345");
    expect(res.headers["content-type"]).toContain("text/plain");
  });

  // Regression: a refused handshake used to say only "the verify token did
  // not match", which is unactionable. The usual causes are a dashboard
  // value that differs from .env, or a process started before .env was last
  // edited — dotenv reads the file once at boot and tsx watch only watches
  // TypeScript. Lengths and presence distinguish them, and neither token may
  // appear.
  it("explains a refusal with lengths, and leaks neither token", () => {
    const config = metaWebhookConfig()!;

    const wrongLength = answerVerificationChallenge(
      { 'hub.mode': 'subscribe', 'hub.verify_token': 'short', 'hub.challenge': '1' },
      config
    );
    expect(wrongLength.ok).toBe(false);
    if (wrongLength.ok) throw new Error('expected a refusal');
    expect(wrongLength.reason).toMatch(/different length/i);
    expect(wrongLength.diagnostic).toContain('received length=5');
    expect(wrongLength.diagnostic).toContain(`configured length=${VERIFY_TOKEN.length}`);
    expect(wrongLength.diagnostic).toContain('lengths match=false');
    expect(wrongLength.diagnostic).not.toContain(VERIFY_TOKEN);
    expect(wrongLength.diagnostic).not.toContain('short');

    // Same length, different value: the likeliest real mistake.
    const sameLength = answerVerificationChallenge(
      {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'x'.repeat(VERIFY_TOKEN.length),
        'hub.challenge': '1'
      },
      config
    );
    if (sameLength.ok) throw new Error('expected a refusal');
    expect(sameLength.reason).toMatch(/right length but does not match/i);
    expect(sameLength.diagnostic).toContain('lengths match=true');
    expect(sameLength.diagnostic).not.toContain(VERIFY_TOKEN);

    const noToken = answerVerificationChallenge(
      { 'hub.mode': 'subscribe', 'hub.challenge': '1' },
      config
    );
    if (noToken.ok) throw new Error('expected a refusal');
    expect(noToken.diagnostic).toContain('token received=no');
  });

  it("refuses a wrong token, a wrong mode and a missing challenge", async () => {
    const config = metaWebhookConfig()!;
    expect(
      answerVerificationChallenge(
        { "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "1" },
        config
      ).ok
    ).toBe(false);
    expect(
      answerVerificationChallenge(
        { "hub.mode": "unsubscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "1" },
        config
      ).ok
    ).toBe(false);
    expect(
      answerVerificationChallenge({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN }, config).ok
    ).toBe(false);

    const res = await request(app)
      .get(WEBHOOK)
      .query({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "12345" });
    expect(res.status).toBe(403);
    expect(res.text).not.toContain(VERIFY_TOKEN);
  });

  it("refuses the handshake outright when the server has no secrets", async () => {
    delete process.env.META_APP_SECRET;
    delete process.env.META_WHATSAPP_VERIFY_TOKEN;
    expect(missingMetaWebhookConfig()).toEqual(["META_APP_SECRET", "META_WHATSAPP_VERIFY_TOKEN"]);

    const res = await request(app)
      .get(WEBHOOK)
      .query({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "1" });
    expect(res.status).toBe(503);
  });
});

describe("signature verification", () => {
  it("refuses a forged signature and changes nothing", async () => {
    const res = await post(messagePayload({ text: "Hello Veyra", wamid: nextWamid() }), "sha256=deadbeef");

    expect(res.status).toBe(403);
    expect(await prisma.conversation.count({ where: { businessId } })).toBe(0);
    expect(await prisma.customerContact.count({ where: { businessId } })).toBe(0);
    expect(await prisma.notification.count({ where: { businessId } })).toBe(0);
    expect(await prisma.messagingWebhookEvent.count()).toBe(0);
  });

  it("refuses an unsigned request", async () => {
    const body = JSON.stringify(messagePayload({ text: "Hello", wamid: nextWamid() }));
    const res = await request(app).post(WEBHOOK).set("content-type", "application/json").send(body);
    expect(res.status).toBe(403);
  });

  it("refuses a body altered after signing", async () => {
    const signed = JSON.stringify(messagePayload({ text: "Hello Veyra", wamid: nextWamid() }));
    const tampered = signed.replace("Hello Veyra", "Transfer everything");

    const res = await request(app)
      .post(WEBHOOK)
      .set("content-type", "application/json")
      .set("x-hub-signature-256", sign(signed))
      .send(tampered);

    expect(res.status).toBe(403);
    expect(await prisma.conversation.count({ where: { businessId } })).toBe(0);
  });

  it("verifies over the exact bytes, including non-ASCII", async () => {
    const adapter = new MetaWhatsAppWebhookAdapter({ appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN });
    const body = JSON.stringify(messagePayload({ text: "Héllo — Veyra 🙂", wamid: nextWamid() }));
    const rawBody = Buffer.from(body, "utf8");

    const events = await adapter.verifyAndParse({
      rawBody,
      headers: { "x-hub-signature-256": sign(body) }
    });
    expect(events).not.toBeNull();
    expect(events![0]).toMatchObject({ text: "Héllo — Veyra 🙂" });
  });
});

describe("inbound message", () => {
  it("routes, links a contact, records the turn and queues a reply", async () => {
    await deliver(messagePayload({ text: "Hello Veyra", wamid: nextWamid() }));

    const conversation = await prisma.conversation.findFirstOrThrow({ where: { businessId } });
    expect(conversation.channel).toBe("whatsapp");
    expect(conversation.customerRef).toBe(CUSTOMER);

    const contact = await findByPhone(businessId, CUSTOMER);
    expect(contact).not.toBeNull();
    // The provider delivered it, which is channel control — not identity.
    expect(contact!.phoneState).toBe("channel_confirmed");
    expect(contact!.source).toBe("whatsapp");
    expect(contact!.phoneVerifiedAt).toBeNull();

    const messages = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "asc" }
    });
    expect(messages[0]).toMatchObject({ sender: "caller", text: "Hello Veyra" });
    expect(messages[1].sender).toBe("receptionist");

    const reply = await prisma.notification.findFirstOrThrow({
      where: { businessId, channel: "whatsapp" }
    });
    expect(reply.recipientPhone).toBe(CUSTOMER);
  });

  it("replies free-form, because the inbound message opened the session", async () => {
    await deliver(messagePayload({ text: "Hello Veyra", wamid: nextWamid() }));
    await processPendingNotifications();

    const sent = capturedMessages().filter((m) => m.channel === "whatsapp");
    expect(sent).toHaveLength(1);
    // A template would mean the window was treated as closed.
    expect(sent[0].templateName).toBeUndefined();
    expect(sent[0].to).toBe(CUSTOMER);
  });

  it("processes a redelivered message exactly once", async () => {
    const wamid = nextWamid();
    const payload = messagePayload({ text: "Hello Veyra", wamid });

    const first = await deliver(payload);
    const second = await deliver(payload);

    expect(first[0].outcome).toBe("processed");
    expect(second[0].outcome).toBe("duplicate");
    expect(await prisma.conversation.count({ where: { businessId } })).toBe(1);
    expect(
      await prisma.message.count({ where: { conversation: { businessId }, sender: "caller" } })
    ).toBe(1);
    expect(await prisma.notification.count({ where: { businessId, channel: "whatsapp" } })).toBe(1);
  });

  it("ignores a message type Reception cannot read, rather than inventing text", async () => {
    const payload = messagePayload({ text: "ignored", wamid: nextWamid() }) as unknown as {
      entry: { changes: { value: { messages: { type: string; text?: unknown; image?: unknown }[] } }[] }[];
    };
    payload.entry[0].changes[0].value.messages[0].type = "image";
    delete payload.entry[0].changes[0].value.messages[0].text;
    payload.entry[0].changes[0].value.messages[0].image = { id: "media-1" };

    const results = await deliver(payload);
    // Nothing to normalise means no event at all, rather than an empty turn.
    expect(results).toHaveLength(0);
    expect(await prisma.conversation.count({ where: { businessId } })).toBe(0);
  });
});

describe("tenant safety", () => {
  it("will not resolve a business from a phone number id it does not know", async () => {
    const results = await deliver(messagePayload({ text: "Hello", wamid: nextWamid(), phoneNumberId: "000000" }));
    expect(results[0].outcome).toBe("ignored");

    // No fallback to a first or demo business.
    expect(await prisma.conversation.count({ where: { businessId } })).toBe(0);
    expect(await prisma.conversation.count({ where: { businessId: otherBusinessId } })).toBe(0);
    expect(
      await prisma.customerContact.count({ where: { businessId: { in: [businessId, otherBusinessId] } } })
    ).toBe(0);
  });

  it("delivers to the business the id belongs to, and no other", async () => {
    await deliver(messagePayload({ text: "Hello", wamid: nextWamid(), phoneNumberId: OTHER_PHONE_NUMBER_ID }));

    expect(await prisma.conversation.count({ where: { businessId: otherBusinessId } })).toBe(1);
    expect(await prisma.conversation.count({ where: { businessId } })).toBe(0);
  });
});

describe("delivery receipts", () => {
  async function sendAndGetWamid(): Promise<{ notificationId: string; wamid: string }> {
    await deliver(messagePayload({ text: "Hello Veyra", wamid: nextWamid() }));
    await processPendingNotifications();
    const row = await prisma.notification.findFirstOrThrow({
      where: { businessId, channel: "whatsapp" }
    });
    // The fake provider issued the id; the receipt path only cares that it
    // matches the provider that sent it.
    await prisma.notification.update({ where: { id: row.id }, data: { providerName: "meta" } });
    return { notificationId: row.id, wamid: row.providerMessageId! };
  }

  it("moves accepted → sent → delivered, and never backwards", async () => {
    const { notificationId, wamid } = await sendAndGetWamid();
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: notificationId } })).deliveryStatus).toBe(
      "accepted"
    );

    await deliver(statusPayload({ wamid, status: "sent" }));
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: notificationId } })).deliveryStatus).toBe(
      "sent"
    );

    await deliver(statusPayload({ wamid, status: "delivered" }));
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: notificationId } })).deliveryStatus).toBe(
      "delivered"
    );

    // A late "sent" must not undo a delivery.
    await deliver(statusPayload({ wamid, status: "sent" }));
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: notificationId } })).deliveryStatus).toBe(
      "delivered"
    );
  });

  it("treats read as delivered, because there is no read state to claim", async () => {
    const { notificationId, wamid } = await sendAndGetWamid();
    await deliver(statusPayload({ wamid, status: "read" }));

    const row = await prisma.notification.findUniqueOrThrow({ where: { id: notificationId } });
    expect(row.deliveryStatus).toBe("delivered");
  });

  it("records a failure with Meta's own words", async () => {
    const { notificationId, wamid } = await sendAndGetWamid();
    await deliver(
      statusPayload({
        wamid,
        status: "failed",
        error: { code: 131026, title: "Message undeliverable" }
      })
    );

    const row = await prisma.notification.findUniqueOrThrow({ where: { id: notificationId } });
    expect(row.deliveryStatus).toBe("failed");
    expect(row.deliveryDetail).toContain("Message undeliverable");
    // Veyra's own send still succeeded; the two states stay distinct.
    expect(row.status).toBe("sent");
  });

  it("applies a redelivered status exactly once, and separates distinct statuses", async () => {
    const { wamid } = await sendAndGetWamid();
    const payload = statusPayload({ wamid, status: "delivered" });

    await deliver(payload);
    const afterFirst = await prisma.messagingWebhookEvent.count({ where: { type: "delivery_receipt" } });

    await deliver(payload);
    const afterSecond = await prisma.messagingWebhookEvent.count({ where: { type: "delivery_receipt" } });
    expect(afterSecond).toBe(afterFirst);

    // A different status for the same message is a different event.
    await deliver(statusPayload({ wamid, status: "read" }));
    expect(await prisma.messagingWebhookEvent.count({ where: { type: "delivery_receipt" } })).toBe(
      afterFirst + 1
    );
  });
});
