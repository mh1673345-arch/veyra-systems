import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { changePlan } from "../src/services/access/accessService.js";
import { CSRF_COOKIE, SESSION_COOKIE, hashPassword } from "../src/services/auth/sessions.js";
import {
  AmbiguousContactError,
  InvalidContactError,
  findByEmail,
  findByPhone,
  normalizeEmail,
  resolveOrCreateContact,
  updateContact
} from "../src/services/contacts/contactService.js";
import {
  confirmationPrompt,
  recordConfirmedVoiceContact,
  suggestedContactFromCallerId
} from "../src/services/contacts/voiceContact.js";
import { resolveConfirmationDestinations } from "../src/services/contacts/destinations.js";
import { sendBookingConfirmation } from "../src/services/contacts/confirmations.js";
import { recordConsent } from "../src/services/messaging/consent.js";
import { processMessagingWebhook } from "../src/services/messaging/webhooks.js";
import {
  FAKE_SIGNATURE_HEADER,
  FAKE_TIMESTAMP_HEADER,
  resetFakeMessaging,
  signFakeMessagingWebhook
} from "../src/services/messaging/providers/fakeMessaging.js";

/**
 * Customer contact identity.
 *
 * Most of these tests assert a refusal. Being clever about identity is how
 * one customer's booking details reach another person, so the valuable
 * behaviour here is the guessing that does not happen: no merging on a name,
 * no country invented for a bare number, no caller ID treated as proof, and
 * no contact shared between two businesses.
 */

const app = createApp();
const PASSWORD = "contact-suite-password";
const SECRET = "test-messaging-webhook-secret";
const PHONE = "+14155552671";
const EMAIL = "sam@customer.test";
const BUSINESS_NUMBER = "+14155550100";
const OTHER_NUMBER = "+14155550200";

let businessId: string;
let otherBusinessId: string;
let conversationId: string;
let ownerAuth: { cookie: string; csrf: string };
let viewerAuth: { cookie: string; csrf: string };

let counter = 0;
const nextEventId = () => `evt_contact_${Date.now()}_${(counter += 1)}`;

async function createBusiness(number: string): Promise<string> {
  const business = await prisma.business.create({
    data: { name: `Contact Test ${Math.random().toString(36).slice(2, 8)}`, timezone: "UTC" }
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

async function signIn(email: string): Promise<{ cookie: string; csrf: string }> {
  const res = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  const cookies = res.headers["set-cookie"] as unknown as string[];
  return {
    cookie: cookies.find((c) => c.startsWith(SESSION_COOKIE))!.split(";")[0],
    csrf: cookies.find((c) => c.startsWith(CSRF_COOKIE))!.split(";")[0].split("=")[1]
  };
}

function postWebhook(body: unknown) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const timestamp = String(Date.now());
  return processMessagingWebhook({
    provider: "fake",
    rawBody,
    headers: {
      [FAKE_SIGNATURE_HEADER]: signFakeMessagingWebhook(SECRET, timestamp, rawBody.toString("utf8")),
      [FAKE_TIMESTAMP_HEADER]: timestamp
    }
  });
}

async function cleanup(): Promise<void> {
  const where = { business: { name: { startsWith: "Contact Test" } } };
  await prisma.messagingWebhookEvent.deleteMany({});
  await prisma.notification.deleteMany({ where });
  await prisma.domainEvent.deleteMany({ where });
  await prisma.knowledgeGapSignal.deleteMany({ where });
  await prisma.conversationFeedback.deleteMany({ where });
  await prisma.pilotIssue.deleteMany({ where });
  await prisma.message.deleteMany({
    where: { conversation: { business: { name: { startsWith: "Contact Test" } } } }
  });
  await prisma.callTurn.deleteMany({
    where: { callSession: { business: { name: { startsWith: "Contact Test" } } } }
  });
  await prisma.callSession.deleteMany({ where });
  await prisma.appointment.deleteMany({ where });
  await prisma.escalation.deleteMany({ where });
  await prisma.conversation.deleteMany({ where });
  await prisma.customerContact.deleteMany({ where });
  await prisma.messagingNumber.deleteMany({ where });
  await prisma.messagingConsent.deleteMany({ where });
  await prisma.messagingSettings.deleteMany({ where });
  await prisma.entitlementGrant.deleteMany({ where });
  // ConfigAuditEvent holds a plain businessId with no relation, so it is
  // cleaned by id rather than by the relation filter the others use.
  const ids = (
    await prisma.business.findMany({
      where: { name: { startsWith: "Contact Test" } },
      select: { id: true }
    })
  ).map((row) => row.id);
  await prisma.configAuditEvent.deleteMany({ where: { businessId: { in: ids } } });
  await prisma.subscriptionEvent.deleteMany({ where });
  await prisma.subscription.deleteMany({ where });
  await prisma.businessMembership.deleteMany({ where });
  await prisma.business.deleteMany({ where: { name: { startsWith: "Contact Test" } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: "@contact.test" } } });
}

beforeEach(async () => {
  process.env.VEYRA_FAKE_MESSAGING_WEBHOOK_SECRET = SECRET;
  resetFakeMessaging();
  await cleanup();

  businessId = await createBusiness(BUSINESS_NUMBER);
  otherBusinessId = await createBusiness(OTHER_NUMBER);

  const passwordHash = await hashPassword(PASSWORD);
  const [owner, viewer] = await Promise.all([
    prisma.user.create({ data: { email: "owner@contact.test", name: "Ona Owner", passwordHash } }),
    prisma.user.create({ data: { email: "viewer@contact.test", name: "Vic Viewer", passwordHash } })
  ]);
  await prisma.businessMembership.createMany({
    data: [
      { userId: owner.id, businessId, role: "OWNER" },
      { userId: viewer.id, businessId, role: "VIEWER" }
    ]
  });
  ownerAuth = await signIn("owner@contact.test");
  viewerAuth = await signIn("viewer@contact.test");

  const conversation = await prisma.conversation.create({
    data: { businessId, channel: "web", callerName: "Sam Customer" }
  });
  conversationId = conversation.id;
});

afterAll(cleanup);

describe("normalization and validation", () => {
  it("stores email lowercased and trimmed, and refuses anything else", () => {
    expect(normalizeEmail("  Sam@Customer.TEST ")).toBe("sam@customer.test");
    for (const bad of ["", "sam", "sam@", "@customer.test", "sam@customer", "a b@c.test"]) {
      expect(() => normalizeEmail(bad)).toThrow(InvalidContactError);
    }
  });

  it("refuses a bare local number instead of inventing a country", async () => {
    await expect(
      resolveOrCreateContact({ businessId, phone: "03001234567", source: "web" })
    ).rejects.toBeInstanceOf(InvalidContactError);
    expect(await prisma.customerContact.count({ where: { businessId } })).toBe(0);
  });

  it("refuses a contact with no way to reach anyone", async () => {
    await expect(
      resolveOrCreateContact({ businessId, name: "Sam", source: "web" })
    ).rejects.toThrow(/phone number or an email/i);
  });
});

describe("resolution is exact, per business, and never a guess", () => {
  it("matches an existing contact by exact phone, and by exact email", async () => {
    const first = await resolveOrCreateContact({ businessId, phone: PHONE, email: EMAIL, source: "web" });
    expect(first.outcome).toBe("created");

    const byPhone = await resolveOrCreateContact({ businessId, phone: PHONE, source: "web" });
    expect(byPhone.outcome).toBe("matched_phone");
    expect(byPhone.contact.id).toBe(first.contact.id);

    const byEmail = await resolveOrCreateContact({ businessId, email: EMAIL.toUpperCase(), source: "web" });
    expect(byEmail.outcome).toBe("matched_email");
    expect(byEmail.contact.id).toBe(first.contact.id);

    expect(await prisma.customerContact.count({ where: { businessId } })).toBe(1);
  });

  it("never matches on a name alone", async () => {
    await resolveOrCreateContact({ businessId, name: "Sam Customer", phone: PHONE, source: "web" });
    const second = await resolveOrCreateContact({
      businessId,
      name: "Sam Customer",
      email: "different@customer.test",
      source: "web"
    });
    expect(second.outcome).toBe("created");
    expect(await prisma.customerContact.count({ where: { businessId } })).toBe(2);
  });

  it("refuses to merge when the phone and email point at different people", async () => {
    const a = await resolveOrCreateContact({ businessId, phone: PHONE, source: "web" });
    const b = await resolveOrCreateContact({ businessId, email: EMAIL, source: "web" });
    expect(a.contact.id).not.toBe(b.contact.id);

    await expect(
      resolveOrCreateContact({ businessId, phone: PHONE, email: EMAIL, source: "web" })
    ).rejects.toBeInstanceOf(AmbiguousContactError);

    // Nothing was changed by the refusal.
    expect(await prisma.customerContact.count({ where: { businessId } })).toBe(2);
    expect((await findByPhone(businessId, PHONE))!.email).toBeNull();
    expect((await findByEmail(businessId, EMAIL))!.phoneE164).toBeNull();
  });

  it("keeps the same number in two businesses completely separate", async () => {
    const mine = await resolveOrCreateContact({ businessId, phone: PHONE, name: "Sam", source: "web" });
    const theirs = await resolveOrCreateContact({
      businessId: otherBusinessId,
      phone: PHONE,
      name: "Someone else",
      source: "web"
    });

    expect(mine.contact.id).not.toBe(theirs.contact.id);
    expect(theirs.outcome).toBe("created");
    // A lookup in one business never sees the other's record.
    expect((await findByPhone(businessId, PHONE))!.id).toBe(mine.contact.id);
    expect((await findByPhone(otherBusinessId, PHONE))!.id).toBe(theirs.contact.id);
  });

  it("adds what is missing but never silently replaces what is there", async () => {
    const created = await resolveOrCreateContact({ businessId, phone: PHONE, source: "web" });
    expect(created.contact.email).toBeNull();

    const enriched = await resolveOrCreateContact({
      businessId,
      phone: PHONE,
      email: EMAIL,
      name: "Sam Customer",
      source: "web"
    });
    expect(enriched.contact.id).toBe(created.contact.id);
    expect(enriched.contact.email).toBe(EMAIL);
    expect(enriched.contact.displayName).toBe("Sam Customer");
  });
});

describe("verification states are never overclaimed", () => {
  it("records a typed number as provided and a messaged one as channel_confirmed", async () => {
    const typed = await resolveOrCreateContact({ businessId, phone: PHONE, source: "web" });
    expect(typed.contact.phoneState).toBe("provided");

    await postWebhook({
      eventId: nextEventId(),
      channel: "whatsapp",
      type: "inbound_message",
      from: PHONE,
      to: BUSINESS_NUMBER,
      text: "Hello"
    });

    const after = await findByPhone(businessId, PHONE);
    expect(after!.phoneState).toBe("channel_confirmed");
    // Still not "verified": controlling a channel is not proving identity.
    expect(after!.phoneState).not.toBe("verified");
    expect(after!.phoneVerifiedAt).toBeNull();
  });

  it("never weakens a state that is already stronger", async () => {
    await resolveOrCreateContact({
      businessId,
      phone: PHONE,
      source: "whatsapp",
      phoneState: "channel_confirmed"
    });
    const typedAgain = await resolveOrCreateContact({ businessId, phone: PHONE, source: "web" });
    expect(typedAgain.contact.phoneState).toBe("channel_confirmed");
  });

  it("drops a corrected number back to provided, because retyping proves nothing", async () => {
    const created = await resolveOrCreateContact({
      businessId,
      phone: PHONE,
      source: "whatsapp",
      phoneState: "channel_confirmed"
    });
    const updated = await updateContact({
      businessId,
      contactId: created.contact.id,
      phone: "+14155559999"
    });
    expect(updated.phoneState).toBe("provided");
  });
});

describe("voice: caller ID is a hint, never proof", () => {
  async function createCall(callerNumber: string | null) {
    return prisma.callSession.create({
      data: {
        businessId,
        conversationId,
        provider: "fake",
        externalCallId: `call_${Math.random().toString(36).slice(2, 9)}`,
        direction: "inbound",
        status: "active",
        callerNumber,
        startedAt: new Date()
      }
    });
  }

  it("creates no contact from caller ID alone", async () => {
    await createCall(PHONE);
    expect(await prisma.customerContact.count({ where: { businessId } })).toBe(0);
  });

  it("suggests a known contact from caller ID without revealing or linking it", async () => {
    const known = await resolveOrCreateContact({
      businessId,
      phone: PHONE,
      name: "Sam Customer",
      email: EMAIL,
      source: "web"
    });
    const suggestion = await suggestedContactFromCallerId({ businessId, callerNumber: PHONE });

    expect(suggestion?.contactId).toBe(known.contact.id);
    // A suggestion carries no name, no email and no history.
    expect(Object.keys(suggestion!)).toEqual(["contactId", "maskedPhone"]);
    expect(suggestion!.maskedPhone).not.toContain("5552671");

    const call = await createCall(PHONE);
    expect((await prisma.callSession.findUniqueOrThrow({ where: { id: call.id } })).customerContactId).toBeNull();
  });

  it("asks about the number the caller is on, or for one if there is none", () => {
    expect(confirmationPrompt(PHONE)).toMatch(/number you're calling from/i);
    expect(confirmationPrompt(PHONE)).toContain("71");
    expect(confirmationPrompt(null)).toMatch(/what number/i);
  });

  it("links the contact once the caller confirms the number they are calling from", async () => {
    const call = await createCall(PHONE);
    const result = await recordConfirmedVoiceContact({
      businessId,
      callSessionId: call.id,
      conversationId,
      confirmedCallerNumber: PHONE,
      name: "Sam Customer"
    });

    expect(result.basis).toBe("confirmed_caller_id");
    expect(result.contact.phoneState).toBe("channel_confirmed");
    expect((await prisma.callSession.findUniqueOrThrow({ where: { id: call.id } })).customerContactId).toBe(
      result.contact.id
    );
    expect(
      (await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).customerContactId
    ).toBe(result.contact.id);
  });

  it("records a different number the caller gives as only provided", async () => {
    const call = await createCall(PHONE);
    const result = await recordConfirmedVoiceContact({
      businessId,
      callSessionId: call.id,
      spokenNumber: "+14155558888"
    });

    expect(result.basis).toBe("spoken_by_caller");
    expect(result.contact.phoneState).toBe("provided");
    expect(result.contact.phoneE164).toBe("+14155558888");
  });

  it("refuses to record a contact with neither a confirmation nor a spoken number", async () => {
    const call = await createCall(PHONE);
    await expect(
      recordConfirmedVoiceContact({ businessId, callSessionId: call.id })
    ).rejects.toThrow(/Caller ID alone is not enough/i);
  });
});

describe("web booking collects contact details", () => {
  async function book(contact?: Record<string, string>) {
    return request(app)
      .post(`/api/conversations/${conversationId}/appointments`)
      .set("x-api-key", process.env.VEYRA_API_KEY as string)
      .send({ requestedTime: "Tuesday at 3pm", serviceName: "Cleaning", ...(contact ? { contact } : {}) });
  }

  it("creates and links a contact from a phone number", async () => {
    const res = await book({ name: "Sam Customer", phone: PHONE });
    expect(res.status).toBe(201);

    const contact = await findByPhone(businessId, PHONE);
    expect(contact).not.toBeNull();
    expect(contact!.phoneState).toBe("provided");

    const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(appointment.customerContactId).toBe(contact!.id);
    expect(
      (await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).customerContactId
    ).toBe(contact!.id);
  });

  it("accepts an email without a phone", async () => {
    const res = await book({ email: EMAIL });
    expect(res.status).toBe(201);
    const contact = await findByEmail(businessId, EMAIL);
    expect(contact!.phoneE164).toBeNull();
  });

  it("rejects an unusable phone without saving the booking", async () => {
    const before = await prisma.appointment.count({ where: { businessId } });
    const res = await book({ phone: "03001234567" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/country code/i);
    expect(await prisma.appointment.count({ where: { businessId } })).toBe(before);
  });

  it("rejects an invalid email without saving the booking", async () => {
    const res = await book({ email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(await prisma.appointment.count({ where: { businessId } })).toBe(0);
  });

  it("still takes a booking from someone who gives no contact details", async () => {
    const res = await book();
    expect(res.status).toBe(201);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: res.body.id } })).customerContactId).toBeNull();
  });
});

describe("confirmation destinations", () => {
  it("offers nothing when there is no contact, and sends nothing", async () => {
    const resolution = await resolveConfirmationDestinations({ businessId, conversationId });
    expect(resolution.available).toEqual([]);

    const appointment = await prisma.appointment.create({
      data: { businessId, conversationId, requestedTime: "Tuesday 3pm", status: "submitted" }
    });
    const outcome = await sendBookingConfirmation({
      businessId,
      conversationId,
      appointmentId: appointment.id,
      subject: "booking_confirmation",
      body: "Confirmed."
    });

    expect(outcome.sent).toBe(false);
    expect(!outcome.sent && outcome.reason).toMatch(/no contact details/i);
    // Nothing queued that would have failed later.
    expect(await prisma.notification.count({ where: { businessId } })).toBe(0);
  });

  it("prefers the channel the customer actually used", async () => {
    await postWebhook({
      eventId: nextEventId(),
      channel: "whatsapp",
      type: "inbound_message",
      from: PHONE,
      to: BUSINESS_NUMBER,
      text: "Can I book a cleaning?"
    });
    const conversation = await prisma.conversation.findFirstOrThrow({
      where: { businessId, channel: "whatsapp" }
    });

    const resolution = await resolveConfirmationDestinations({
      businessId,
      conversationId: conversation.id
    });
    expect(resolution.available[0].channel).toBe("whatsapp");
    expect(resolution.available[0].reason).toMatch(/contacted this business on this channel/i);
    // Masked, even here.
    expect(resolution.available[0].to).not.toContain("5552671");
  });

  it("reports an opted-out channel as blocked rather than dropping it silently", async () => {
    await resolveOrCreateContact({ businessId, phone: PHONE, source: "web" });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { customerContactId: (await findByPhone(businessId, PHONE))!.id }
    });
    await recordConsent({ businessId, channel: "sms", phone: PHONE, state: "revoked", source: "stop_keyword" });

    const resolution = await resolveConfirmationDestinations({ businessId, conversationId });
    expect(resolution.available.some((d) => d.channel === "sms")).toBe(false);
    expect(resolution.blocked.some((b) => b.channel === "sms" && /opted out/i.test(b.reason))).toBe(true);
  });

  it("keeps WhatsApp permission independent of SMS", async () => {
    const contact = await resolveOrCreateContact({ businessId, phone: PHONE, source: "web" });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { customerContactId: contact.contact.id }
    });
    await recordConsent({ businessId, channel: "sms", phone: PHONE, state: "revoked", source: "stop_keyword" });

    const resolution = await resolveConfirmationDestinations({ businessId, conversationId });
    // SMS is blocked; WhatsApp is blocked for its own reason (no session),
    // never because of the SMS opt-out.
    const whatsapp = resolution.blocked.find((b) => b.channel === "whatsapp");
    expect(whatsapp?.reason ?? "").not.toMatch(/opted out/i);
  });

  it("sends the confirmation on the resolved channel", async () => {
    const contact = await resolveOrCreateContact({ businessId, phone: PHONE, source: "web" });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { customerContactId: contact.contact.id }
    });
    const appointment = await prisma.appointment.create({
      data: {
        businessId,
        conversationId,
        requestedTime: "Tuesday 3pm",
        status: "submitted",
        customerContactId: contact.contact.id
      }
    });

    const outcome = await sendBookingConfirmation({
      businessId,
      conversationId,
      appointmentId: appointment.id,
      subject: "booking_confirmation",
      body: "Your appointment is confirmed."
    });

    expect(outcome.sent).toBe(true);
    expect(outcome.sent && outcome.channel).toBe("sms");
    const notification = await prisma.notification.findUniqueOrThrow({
      where: { id: outcome.sent ? outcome.notificationId : "" }
    });
    expect(notification.recipientPhone).toBe(PHONE);
    expect(notification.linkEntityId).toBe(appointment.id);
  });
});

describe("Console access and editing", () => {
  it("lets an operator role correct a contact, and audits it", async () => {
    const contact = await resolveOrCreateContact({ businessId, phone: PHONE, source: "web" });

    const res = await request(app)
      .patch(`/api/ops/businesses/${businessId}/contacts/${contact.contact.id}`)
      .set({ Cookie: ownerAuth.cookie, "x-csrf-token": ownerAuth.csrf })
      .send({ name: "Samantha Customer", email: EMAIL });

    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe("Samantha Customer");
    // Masked in the response, always.
    expect(res.body.phone).not.toContain("5552671");

    const audit = await prisma.configAuditEvent.findFirst({
      where: { businessId, entityType: "customer_contact" }
    });
    expect(audit).not.toBeNull();
    expect(audit!.changedFields.sort()).toEqual(["email", "name"]);
  });

  it("refuses a viewer any change", async () => {
    const contact = await resolveOrCreateContact({ businessId, phone: PHONE, source: "web" });

    const res = await request(app)
      .patch(`/api/ops/businesses/${businessId}/contacts/${contact.contact.id}`)
      .set({ Cookie: viewerAuth.cookie, "x-csrf-token": viewerAuth.csrf })
      .send({ name: "Should not work" });

    expect(res.status).toBe(403);
    expect((await prisma.customerContact.findUniqueOrThrow({ where: { id: contact.contact.id } })).displayName).toBeNull();
  });

  it("lets a viewer read a contact", async () => {
    const contact = await resolveOrCreateContact({ businessId, phone: PHONE, source: "web" });
    const res = await request(app)
      .get(`/api/ops/businesses/${businessId}/contacts/${contact.contact.id}`)
      .set({ Cookie: viewerAuth.cookie });
    expect(res.status).toBe(200);
    expect(res.body.smsConsent).toBe("unknown");
  });

  it("will not reach another business's contact, even with its id", async () => {
    const theirs = await resolveOrCreateContact({
      businessId: otherBusinessId,
      phone: PHONE,
      source: "web"
    });

    const read = await request(app)
      .get(`/api/ops/businesses/${businessId}/contacts/${theirs.contact.id}`)
      .set({ Cookie: ownerAuth.cookie });
    expect(read.status).toBe(404);

    const write = await request(app)
      .patch(`/api/ops/businesses/${businessId}/contacts/${theirs.contact.id}`)
      .set({ Cookie: ownerAuth.cookie, "x-csrf-token": ownerAuth.csrf })
      .send({ name: "Cross-tenant edit" });
    expect(write.status).toBe(400);
    expect(
      (await prisma.customerContact.findUniqueOrThrow({ where: { id: theirs.contact.id } })).displayName
    ).toBeNull();
  });
});

/**
 * The scenario from the ticket, run end to end: one customer, several
 * channels, two businesses.
 */
describe("acceptance: one customer across channels", () => {
  it("keeps one contact per business through web, voice and WhatsApp", async () => {
    // 1-3. A web booking with a phone number creates and links a contact.
    const booking = await request(app)
      .post(`/api/conversations/${conversationId}/appointments`)
      .set("x-api-key", process.env.VEYRA_API_KEY as string)
      .send({ requestedTime: "Tuesday 3pm", contact: { name: "Sam Customer", phone: PHONE } });
    expect(booking.status).toBe(201);

    const contact = await findByPhone(businessId, PHONE);
    expect(contact).not.toBeNull();
    expect(
      (await prisma.appointment.findUniqueOrThrow({ where: { id: booking.body.id } })).customerContactId
    ).toBe(contact!.id);

    // 4. An SMS destination resolves for it.
    const destinations = await resolveConfirmationDestinations({ businessId, conversationId });
    expect(destinations.available.some((d) => d.channel === "sms")).toBe(true);

    // 5. WhatsApp permission is its own question and is not implied.
    expect(
      await prisma.messagingConsent.findFirst({ where: { businessId, channel: "whatsapp", phoneE164: PHONE } })
    ).toBeNull();

    // 6-8. A call from the same number, confirmed by the caller, links the
    // same contact rather than making a second one.
    const call = await prisma.callSession.create({
      data: {
        businessId,
        conversationId,
        provider: "fake",
        externalCallId: `call_${Date.now()}`,
        direction: "inbound",
        status: "active",
        callerNumber: PHONE,
        startedAt: new Date()
      }
    });
    const voice = await recordConfirmedVoiceContact({
      businessId,
      callSessionId: call.id,
      conversationId,
      confirmedCallerNumber: PHONE
    });
    expect(voice.contact.id).toBe(contact!.id);
    // The call upgraded what is known about the number.
    expect(voice.contact.phoneState).toBe("channel_confirmed");

    // 9-11. Inbound WhatsApp from the same number resolves the same contact.
    await postWebhook({
      eventId: nextEventId(),
      channel: "whatsapp",
      type: "inbound_message",
      from: PHONE,
      to: BUSINESS_NUMBER,
      text: "Hello"
    });
    expect(await prisma.customerContact.count({ where: { businessId } })).toBe(1);

    // 12-13. The same number at another business is a separate record.
    await postWebhook({
      eventId: nextEventId(),
      channel: "whatsapp",
      type: "inbound_message",
      from: PHONE,
      to: OTHER_NUMBER,
      text: "Hello"
    });
    const theirs = await findByPhone(otherBusinessId, PHONE);
    expect(theirs).not.toBeNull();
    expect(theirs!.id).not.toBe(contact!.id);
    expect(await prisma.customerContact.count({ where: { businessId } })).toBe(1);
    expect(await prisma.customerContact.count({ where: { businessId: otherBusinessId } })).toBe(1);
  });
});
