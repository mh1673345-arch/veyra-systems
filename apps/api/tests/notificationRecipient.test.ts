import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { CSRF_COOKIE, SESSION_COOKIE, hashPassword } from "../src/services/auth/sessions.js";
import {
  InvalidRecipientError,
  emitDomainEvent,
  emitSystemEmailNotification,
  normalizeRecipientEmail
} from "../src/services/notifications/events.js";
import { processPendingNotifications } from "../src/services/notifications/processor.js";
import {
  type DeliveryResult,
  type NotificationProvider,
  type OutboundMessage,
  setEmailProvider
} from "../src/services/notifications/providers.js";

/**
 * Notifications addressed outside the membership.
 *
 * The point of these tests is the invariant, not the feature: a notification
 * has a member or an external address, never both and never neither, and one
 * event can never produce two external sends.
 */

const app = createApp();
const PASSWORD = "recipient-suite-password";
const EXTERNAL = "acceptance@recipient.test";

let businessId: string;
let otherBusinessId: string;
let ownerId: string;
let ownerAuth: { cookie: string; csrf: string };

/** Records every address it was asked to send to. */
class RecordingProvider implements NotificationProvider {
  readonly name = "recording-test-provider";
  readonly supportsIdempotency = true;
  readonly sent: OutboundMessage[] = [];

  async send(message: OutboundMessage): Promise<DeliveryResult> {
    this.sent.push(message);
    return { delivered: true, providerName: this.name };
  }
}

/**
 * Scoped to this suite's businesses on purpose: a claim another suite left
 * behind is not this suite's to wait for, and waiting on it only ever produces
 * a timeout that looks like a bug here.
 */
async function settleNotifications(): Promise<void> {
  await processPendingNotifications();
  const mine = { businessId: { in: [businessId, otherBusinessId] }, claimToken: { not: null } };
  const deadline = Date.now() + 10_000;
  while ((await prisma.notification.count({ where: mine })) > 0) {
    if (Date.now() > deadline) throw new Error("notifications did not settle within 10s");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: "@recipient.test" } } });

  const [business, other] = await Promise.all([
    prisma.business.create({ data: { name: "Recipient Dental", capEmailNotifications: true } }),
    prisma.business.create({ data: { name: "Recipient Other", capEmailNotifications: true } })
  ]);
  businessId = business.id;
  otherBusinessId = other.id;

  const owner = await prisma.user.create({
    data: {
      email: "owner@recipient.test",
      name: "Ona Owner",
      passwordHash: await hashPassword(PASSWORD)
    }
  });
  ownerId = owner.id;
  await prisma.businessMembership.create({
    data: { userId: owner.id, businessId, role: "OWNER" }
  });

  const res = await request(app)
    .post("/api/auth/login")
    .send({ email: "owner@recipient.test", password: PASSWORD });
  const cookies = res.headers["set-cookie"] as unknown as string[];
  ownerAuth = {
    cookie: cookies.find((c) => c.startsWith(SESSION_COOKIE))!.split(";")[0],
    csrf: cookies.find((c) => c.startsWith(CSRF_COOKIE))!.split(";")[0].split("=")[1]
  };
});

afterEach(async () => {
  setEmailProvider(null);
  await prisma.notification.deleteMany({ where: { businessId: { in: [businessId, otherBusinessId] } } });
  await prisma.domainEvent.deleteMany({ where: { businessId: { in: [businessId, otherBusinessId] } } });
});

afterAll(async () => {
  // Child rows first: a leftover escalation or conversation would otherwise
  // hold the business behind a foreign key.
  await prisma.notification.deleteMany({ where: { businessId: { in: [businessId, otherBusinessId] } } });
  await prisma.domainEvent.deleteMany({ where: { businessId: { in: [businessId, otherBusinessId] } } });
  await prisma.escalation.deleteMany({ where: { businessId: { in: [businessId, otherBusinessId] } } });
  await prisma.conversation.deleteMany({ where: { businessId: { in: [businessId, otherBusinessId] } } });
  await prisma.businessMembership.deleteMany({ where: { businessId: { in: [businessId, otherBusinessId] } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: "@recipient.test" } } });
  await prisma.business.deleteMany({ where: { id: { in: [businessId, otherBusinessId] } } });
});

describe("recipient email validation", () => {
  it("normalizes case and surrounding whitespace, and nothing else", () => {
    expect(normalizeRecipientEmail("  Contact.Veyra@Example.COM  ")).toBe("contact.veyra@example.com");
    // Plus-addressing and dots are meaningful to the recipient: left alone.
    expect(normalizeRecipientEmail("a.b+tag@example.com")).toBe("a.b+tag@example.com");
  });

  it("rejects anything that is not an address rather than repairing it", () => {
    for (const bad of ["", "   ", "not-an-email", "two@@example.com", "missing@tld", "a b@example.com"]) {
      expect(() => normalizeRecipientEmail(bad)).toThrow(InvalidRecipientError);
    }
  });

  it("refuses to create a system notification for an invalid address", async () => {
    await expect(
      emitSystemEmailNotification({
        businessId,
        type: "system.email_acceptance",
        recipientEmail: "nope",
        subject: "s",
        body: "b"
      })
    ).rejects.toBeInstanceOf(InvalidRecipientError);

    expect(await prisma.notification.count({ where: { businessId } })).toBe(0);
    // The event must not survive a rejected recipient either.
    expect(await prisma.domainEvent.count({ where: { businessId } })).toBe(0);
  });
});

describe("external recipient delivery", () => {
  it("delivers to the explicit address, with no member attached", async () => {
    const provider = new RecordingProvider();
    setEmailProvider(provider);

    const { notificationId } = await emitSystemEmailNotification({
      businessId,
      type: "system.email_acceptance",
      recipientEmail: EXTERNAL.toUpperCase(),
      subject: "Veyra Reception — Email Acceptance Test",
      body: "This is a development acceptance test."
    });

    await settleNotifications();

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].to).toBe(EXTERNAL);

    const row = await prisma.notification.findUniqueOrThrow({ where: { id: notificationId } });
    expect(row.status).toBe("sent");
    expect(row.userId).toBeNull();
    expect(row.recipientEmail).toBe(EXTERNAL);
    expect(row.channel).toBe("email");
    expect(row.providerName).toBe(provider.name);
  });

  it("keeps member-addressed notifications exactly as they were", async () => {
    const provider = new RecordingProvider();
    setEmailProvider(provider);

    const conversation = await prisma.conversation.create({
      data: { businessId, callerName: "Nora Caller" }
    });
    const escalation = await prisma.escalation.create({
      data: {
        businessId,
        conversationId: conversation.id,
        reason: "caller asked for a person",
        status: "requested"
      }
    });
    await emitDomainEvent({
      businessId,
      type: "escalation.created",
      entityType: "escalation",
      entityId: escalation.id,
      payload: { reason: "caller asked for a person" }
    });

    await settleNotifications();

    const emails = await prisma.notification.findMany({ where: { businessId, channel: "email" } });
    expect(emails).toHaveLength(1);
    expect(emails[0].userId).toBe(ownerId);
    // The new column stays null on the path that existed before it.
    expect(emails[0].recipientEmail).toBeNull();
    expect(provider.sent[0].to).toBe("owner@recipient.test");

    await prisma.escalation.delete({ where: { id: escalation.id } });
    await prisma.conversation.delete({ where: { id: conversation.id } });
  });

  it("never lets a system notification reach a member's console", async () => {
    await emitSystemEmailNotification({
      businessId,
      type: "system.email_acceptance",
      recipientEmail: EXTERNAL,
      subject: "Veyra Reception — Email Acceptance Test",
      body: "This is a development acceptance test."
    });

    const res = await request(app)
      .get(`/api/ops/businesses/${businessId}/notifications`)
      .set({ Cookie: ownerAuth.cookie });

    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(0);
    expect(res.body.unreadCount).toBe(0);
  });

  it("scopes the notification to the business it was raised for", async () => {
    const { notificationId } = await emitSystemEmailNotification({
      businessId: otherBusinessId,
      type: "system.email_acceptance",
      recipientEmail: EXTERNAL,
      subject: "Veyra Reception — Email Acceptance Test",
      body: "This is a development acceptance test."
    });

    const row = await prisma.notification.findUniqueOrThrow({ where: { id: notificationId } });
    expect(row.businessId).toBe(otherBusinessId);
    expect(await prisma.notification.count({ where: { businessId } })).toBe(0);
  });
});

describe("dedupe and idempotency for external recipients", () => {
  it("cannot create two external sends for one event and address", async () => {
    const { eventId } = await emitSystemEmailNotification({
      businessId,
      type: "system.email_acceptance",
      recipientEmail: EXTERNAL,
      subject: "Veyra Reception — Email Acceptance Test",
      body: "This is a development acceptance test."
    });

    // The member constraint cannot catch this: userId is null on both rows,
    // and Postgres treats NULLs as distinct. The recipient index is what does.
    await expect(
      prisma.notification.create({
        data: {
          businessId,
          userId: null,
          recipientEmail: EXTERNAL,
          eventId,
          channel: "email",
          subject: "Veyra Reception — Email Acceptance Test",
          body: "duplicate",
          nextAttemptAt: new Date()
        }
      })
    ).rejects.toThrow();

    expect(await prisma.notification.count({ where: { eventId } })).toBe(1);
  });

  it("refuses a row that names both a member and an address, or neither", async () => {
    const event = await prisma.domainEvent.create({
      data: {
        businessId,
        type: "system.email_acceptance",
        entityType: "system",
        entityId: businessId,
        payload: "{}"
      }
    });

    // Both: ambiguous, so the database rejects it outright.
    await expect(
      prisma.notification.create({
        data: {
          businessId,
          userId: ownerId,
          recipientEmail: EXTERNAL,
          eventId: event.id,
          channel: "email",
          subject: "s",
          body: "b"
        }
      })
    ).rejects.toThrow();

    // Neither: nothing to send to.
    await expect(
      prisma.notification.create({
        data: { businessId, eventId: event.id, channel: "email", subject: "s", body: "b" }
      })
    ).rejects.toThrow();
  });

  it("carries a stable idempotency key across a retry, and sends once", async () => {
    let attempts = 0;
    const keys: string[] = [];
    setEmailProvider({
      name: "flaky-test-provider",
      supportsIdempotency: true,
      async send(message: OutboundMessage): Promise<DeliveryResult> {
        attempts += 1;
        keys.push(message.idempotencyKey ?? "(none)");
        return attempts === 1
          ? { delivered: false, providerName: "flaky-test-provider", reason: "simulated outage" }
          : { delivered: true, providerName: "flaky-test-provider" };
      }
    });

    const { notificationId } = await emitSystemEmailNotification({
      businessId,
      type: "system.email_acceptance",
      recipientEmail: EXTERNAL,
      subject: "Veyra Reception — Email Acceptance Test",
      body: "This is a development acceptance test."
    });

    await settleNotifications();
    const afterFailure = await prisma.notification.findUniqueOrThrow({ where: { id: notificationId } });
    expect(afterFailure.status).toBe("pending");
    expect(afterFailure.attemptCount).toBe(1);
    // Backoff, so it is not retried immediately.
    expect(afterFailure.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    // Make it due and let the worker try again.
    await prisma.notification.update({
      where: { id: notificationId },
      data: { nextAttemptAt: new Date(Date.now() - 1000) }
    });
    await settleNotifications();

    const afterRetry = await prisma.notification.findUniqueOrThrow({ where: { id: notificationId } });
    expect(afterRetry.status).toBe("sent");
    expect(attempts).toBe(2);
    // Same key both times: a vendor that honours it collapses the duplicate.
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toContain(notificationId);
  });

  it("cannot be stripped of its recipient after the fact", async () => {
    const { notificationId } = await emitSystemEmailNotification({
      businessId,
      type: "system.email_acceptance",
      recipientEmail: EXTERNAL,
      subject: "Veyra Reception — Email Acceptance Test",
      body: "This is a development acceptance test."
    });

    // The worker has a guard for a notification with nowhere to send, but the
    // constraint means nothing can reach it: an email row cannot lose its only
    // recipient, even by raw SQL.
    await expect(
      prisma.$executeRaw`UPDATE "Notification" SET "recipientEmail" = NULL WHERE "id" = ${notificationId}`
    ).rejects.toThrow(/Notification_recipient_exclusive/);
  });
});
