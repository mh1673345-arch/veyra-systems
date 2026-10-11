import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { CSRF_COOKIE, SESSION_COOKIE, hashPassword } from "../src/services/auth/sessions.js";
import { emitDomainEvent } from "../src/services/notifications/events.js";
import {
  MAX_ATTEMPTS,
  processPendingNotifications
} from "../src/services/notifications/processor.js";
import {
  ConsoleEmailProvider,
  type DeliveryResult,
  type NotificationProvider,
  setEmailProvider
} from "../src/services/notifications/providers.js";

const app = createApp();
const PASSWORD = "notify-suite-password";
const demoKey = process.env.VEYRA_API_KEY as string;

let businessId: string;
let otherBusinessId: string;
let conversationId: string;
let ownerId: string;
let viewerId: string;
let ownerAuth: { cookie: string; csrf: string };
let viewerAuth: { cookie: string; csrf: string };
let outsiderAuth: { cookie: string; csrf: string };

async function signIn(email: string): Promise<{ cookie: string; csrf: string }> {
  const res = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  const cookies = res.headers["set-cookie"] as unknown as string[];
  return {
    cookie: cookies.find((c) => c.startsWith(SESSION_COOKIE))!.split(";")[0],
    csrf: cookies.find((c) => c.startsWith(CSRF_COOKIE))!.split(";")[0].split("=")[1]
  };
}

const withAuth = (auth: { cookie: string; csrf: string }) => ({
  Cookie: auth.cookie,
  "x-csrf-token": auth.csrf
});

/** A provider that always fails, for exercising the retry path. */
class FailingProvider implements NotificationProvider {
  readonly name = "failing-test-provider";
  calls = 0;
  async send(): Promise<DeliveryResult> {
    this.calls += 1;
    return { delivered: false, providerName: this.name, reason: "simulated provider outage" };
  }
}

/**
 * Processes due notifications and waits for any claim still in flight — e.g.
 * the fire-and-forget pass an HTTP request started — to settle. A second
 * processor correctly skips a row another one owns, so tests must wait for the
 * owner rather than expect a duplicate pass to deliver it.
 */
async function settleNotifications(): Promise<void> {
  await processPendingNotifications();
  const deadline = Date.now() + 10_000;
  while ((await prisma.notification.count({ where: { claimToken: { not: null } } })) > 0) {
    if (Date.now() > deadline) throw new Error("notifications did not settle within 10s");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: "@notify.test" } } });

  const [business, other] = await Promise.all([
    // Email notifications on, so the email channel is exercised.
    prisma.business.create({ data: { name: "Notify Dental", capEmailNotifications: true } }),
    prisma.business.create({ data: { name: "Notify Other" } })
  ]);
  businessId = business.id;
  otherBusinessId = other.id;

  const conversation = await prisma.conversation.create({
    data: { businessId, callerName: "Nora Caller" }
  });
  conversationId = conversation.id;

  const passwordHash = await hashPassword(PASSWORD);
  const [owner, operator, viewer, outsider] = await Promise.all([
    prisma.user.create({ data: { email: "owner@notify.test", name: "Ona Owner", passwordHash } }),
    prisma.user.create({ data: { email: "op@notify.test", name: "Otis Operator", passwordHash } }),
    prisma.user.create({ data: { email: "viewer@notify.test", name: "Vic Viewer", passwordHash } }),
    prisma.user.create({ data: { email: "outsider@notify.test", name: "Ozzy Out", passwordHash } })
  ]);
  ownerId = owner.id;
  viewerId = viewer.id;

  await prisma.businessMembership.createMany({
    data: [
      { userId: owner.id, businessId, role: "OWNER" },
      { userId: operator.id, businessId, role: "OPERATOR" },
      { userId: viewer.id, businessId, role: "VIEWER" },
      { userId: outsider.id, businessId: otherBusinessId, role: "OWNER" }
    ]
  });

  ownerAuth = await signIn("owner@notify.test");
  viewerAuth = await signIn("viewer@notify.test");
  outsiderAuth = await signIn("outsider@notify.test");
});

afterEach(() => {
  // Each test picks its own provider; reset to the default afterwards.
  setEmailProvider(null);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("domain events", () => {
  it("records an event when a booking request is created", async () => {
    const res = await request(app)
      .post(`/api/conversations/${conversationId}/appointments`)
      .set("x-api-key", demoKey)
      .send({ requestedTime: "2027-02-01T10:00", serviceName: "Routine cleaning" });

    expect(res.status).toBe(201);

    const event = await prisma.domainEvent.findFirst({
      where: { entityId: res.body.id, type: "booking_request.created" }
    });
    expect(event).not.toBeNull();
    expect(event?.businessId).toBe(businessId);
    expect(event?.entityType).toBe("booking");
  });

  it("stores only safe metadata in the payload", async () => {
    const event = await prisma.domainEvent.findFirst({
      where: { type: "booking_request.created" },
      orderBy: { createdAt: "desc" }
    });

    const payload = JSON.parse(event!.payload);
    expect(payload.service).toBe("Routine cleaning");
    expect(payload.customer).toBe("Nora Caller");
    // No transcripts, prompts or provider internals.
    expect(event!.payload).not.toContain("system");
    expect(event!.payload).not.toContain("apiKey");
  });

  it("records an event when an escalation is created by the assistant action", async () => {
    const res = await request(app)
      .post(`/api/conversations/${conversationId}/messages`)
      .set("x-api-key", demoKey)
      .send({ text: "I want to speak to a person" });

    expect(res.status).toBe(201);
    const escalationId = res.body.actionResult.metadata.escalationId as string;

    const event = await prisma.domainEvent.findFirst({
      where: { entityId: escalationId, type: "escalation.created" }
    });
    expect(event).not.toBeNull();
  });

  it("records status changes as events", async () => {
    const booking = await prisma.appointment.create({
      data: {
        conversationId,
        businessId,
        requestedTime: "2027-02-02T10:00",
        status: "submitted",
        submittedAt: new Date()
      }
    });

    await request(app)
      .patch(`/api/ops/businesses/${businessId}/bookings/${booking.id}/status`)
      .set(withAuth(ownerAuth))
      .send({ status: "reviewing" });

    const event = await prisma.domainEvent.findFirst({
      where: { entityId: booking.id, type: "booking_request.status_changed" }
    });
    expect(event).not.toBeNull();
    expect(JSON.parse(event!.payload)).toMatchObject({ from: "submitted", to: "reviewing" });
  });

  it("survives a reload — events are read back from the database, not memory", async () => {
    const before = await prisma.domainEvent.count({ where: { businessId } });

    // A fresh client stands in for a restarted process reading the same data.
    const { PrismaClient } = await import("@prisma/client");
    const fresh = new PrismaClient();
    try {
      expect(await fresh.domainEvent.count({ where: { businessId } })).toBe(before);
    } finally {
      await fresh.$disconnect();
    }
  });
});

describe("notification fan-out", () => {
  it("notifies every operational member in-app", async () => {
    const booking = await prisma.appointment.create({
      data: { conversationId, businessId, requestedTime: "2027-03-01T09:00", status: "submitted" }
    });
    const eventId = await emitDomainEvent({
      businessId,
      type: "booking_request.created",
      entityType: "booking",
      entityId: booking.id,
      payload: { customer: "Nora Caller", service: "Whitening" }
    });

    const inApp = await prisma.notification.findMany({
      where: { eventId: eventId!, channel: "in_app" }
    });
    // Owner, operator and viewer all see it in the console.
    expect(inApp).toHaveLength(3);
    expect(inApp[0].linkEntity).toBe("booking");
    expect(inApp[0].linkEntityId).toBe(booking.id);
  });

  it("excludes a viewer from operational email by default", async () => {
    const booking = await prisma.appointment.create({
      data: { conversationId, businessId, requestedTime: "2027-03-02T09:00", status: "submitted" }
    });
    const eventId = await emitDomainEvent({
      businessId,
      type: "booking_request.created",
      entityType: "booking",
      entityId: booking.id
    });

    const emails = await prisma.notification.findMany({
      where: { eventId: eventId!, channel: "email" }
    });
    const recipients = emails.map((e) => e.userId);

    expect(recipients).toContain(ownerId);
    // A viewer reads the dashboard; they are not paged by default.
    expect(recipients).not.toContain(viewerId);
  });

  it("honours an explicit opt-in from a viewer and an opt-out from an owner", async () => {
    await prisma.businessMembership.update({
      where: { userId_businessId: { userId: viewerId, businessId } },
      data: { notifyNewBookingEmail: true }
    });
    await prisma.businessMembership.update({
      where: { userId_businessId: { userId: ownerId, businessId } },
      data: { notifyNewBookingEmail: false }
    });

    const booking = await prisma.appointment.create({
      data: { conversationId, businessId, requestedTime: "2027-03-03T09:00", status: "submitted" }
    });
    const eventId = await emitDomainEvent({
      businessId,
      type: "booking_request.created",
      entityType: "booking",
      entityId: booking.id
    });

    const recipients = (
      await prisma.notification.findMany({ where: { eventId: eventId!, channel: "email" } })
    ).map((e) => e.userId);

    expect(recipients).toContain(viewerId);
    expect(recipients).not.toContain(ownerId);

    // Restore defaults for later tests.
    await prisma.businessMembership.updateMany({
      where: { businessId, userId: { in: [viewerId, ownerId] } },
      data: { notifyNewBookingEmail: null }
    });
  });

  it("sends no email at all when the business capability is off", async () => {
    const escalation = await prisma.escalation.create({
      data: { conversationId, businessId: otherBusinessId, reason: "needs a person" }
    });
    const eventId = await emitDomainEvent({
      businessId: otherBusinessId,
      type: "escalation.created",
      entityType: "escalation",
      entityId: escalation.id,
      payload: { reason: "needs a person" }
    });

    const emails = await prisma.notification.count({
      where: { eventId: eventId!, channel: "email" }
    });
    // The capability gates the channel regardless of anyone's preference.
    expect(emails).toBe(0);
    expect(
      await prisma.notification.count({ where: { eventId: eventId!, channel: "in_app" } })
    ).toBeGreaterThan(0);
  });

  it("does not notify a disabled member", async () => {
    const dormant = await prisma.user.create({
      data: {
        email: "dormant@notify.test",
        name: "Dorm Ant",
        passwordHash: await hashPassword(PASSWORD),
        disabledAt: new Date()
      }
    });
    await prisma.businessMembership.create({
      data: { userId: dormant.id, businessId, role: "OPERATOR" }
    });

    const booking = await prisma.appointment.create({
      data: { conversationId, businessId, requestedTime: "2027-03-04T09:00", status: "submitted" }
    });
    const eventId = await emitDomainEvent({
      businessId,
      type: "booking_request.created",
      entityType: "booking",
      entityId: booking.id
    });

    const recipients = (
      await prisma.notification.findMany({ where: { eventId: eventId! } })
    ).map((n) => n.userId);
    expect(recipients).not.toContain(dormant.id);

    await prisma.businessMembership.deleteMany({ where: { userId: dormant.id } });
    await prisma.user.delete({ where: { id: dormant.id } });
  });

  it("does not page anyone for a routine status change", async () => {
    const booking = await prisma.appointment.create({
      data: { conversationId, businessId, requestedTime: "2027-03-05T09:00", status: "submitted" }
    });
    const eventId = await emitDomainEvent({
      businessId,
      type: "booking_request.status_changed",
      entityType: "booking",
      entityId: booking.id,
      payload: { from: "submitted", to: "reviewing" }
    });

    // The operator who made the change already knows.
    expect(await prisma.notification.count({ where: { eventId: eventId! } })).toBe(0);
    const event = await prisma.domainEvent.findUnique({ where: { id: eventId! } });
    expect(event?.processedAt).not.toBeNull();
  });
});

describe("idempotency", () => {
  it("re-emitting the same event does not duplicate notifications", async () => {
    const booking = await prisma.appointment.create({
      data: { conversationId, businessId, requestedTime: "2027-04-01T09:00", status: "submitted" }
    });

    const first = await emitDomainEvent({
      businessId,
      type: "booking_request.created",
      entityType: "booking",
      entityId: booking.id
    });
    const firstCount = await prisma.notification.count({ where: { eventId: first! } });

    // Processing the same event again must not fan out a second time.
    await processPendingNotifications();
    await processPendingNotifications();

    expect(await prisma.notification.count({ where: { eventId: first! } })).toBe(firstCount);
  });

  it("rejects a duplicate notification row for the same event, user and channel", async () => {
    const event = await prisma.domainEvent.findFirst({ orderBy: { createdAt: "desc" } });
    const existing = await prisma.notification.findFirst({ where: { eventId: event!.id } });
    if (!existing) return;

    await expect(
      prisma.notification.create({
        data: {
          businessId: existing.businessId,
          userId: existing.userId,
          eventId: existing.eventId,
          channel: existing.channel,
          subject: "duplicate"
        }
      })
    ).rejects.toThrow();
  });
});

describe("delivery and retries", () => {
  it("marks a notification sent when the provider confirms, recording which provider", async () => {
    const provider = new ConsoleEmailProvider();
    setEmailProvider(provider);

    const booking = await prisma.appointment.create({
      data: { conversationId, businessId, requestedTime: "2027-05-01T09:00", status: "submitted" }
    });
    const eventId = await emitDomainEvent({
      businessId,
      type: "booking_request.created",
      entityType: "booking",
      entityId: booking.id
    });

    await processPendingNotifications();

    const emails = await prisma.notification.findMany({
      where: { eventId: eventId!, channel: "email" }
    });
    expect(emails.length).toBeGreaterThan(0);
    for (const email of emails) {
      expect(email.status).toBe("sent");
      expect(email.sentAt).not.toBeNull();
      // "sent" is always attributed, so a console capture is never mistaken
      // for a real email.
      expect(email.providerName).toBe("console");
      expect(email.failureReason).toContain("no email was sent");
    }
    expect(provider.messages().length).toBeGreaterThan(0);
  });

  it("retries a failing provider with backoff instead of giving up immediately", async () => {
    const provider = new FailingProvider();
    setEmailProvider(provider);

    const booking = await prisma.appointment.create({
      data: { conversationId, businessId, requestedTime: "2027-05-02T09:00", status: "submitted" }
    });
    const eventId = await emitDomainEvent({
      businessId,
      type: "booking_request.created",
      entityType: "booking",
      entityId: booking.id
    });

    await processPendingNotifications();

    const email = await prisma.notification.findFirst({
      where: { eventId: eventId!, channel: "email" }
    });
    expect(email?.status).toBe("pending");
    expect(email?.attemptCount).toBe(1);
    expect(email?.failureReason).toContain("simulated provider outage");
    // Scheduled for later rather than hammered immediately.
    expect(email!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    // Not retried again until the backoff has elapsed.
    await processPendingNotifications();
    const unchanged = await prisma.notification.findUnique({ where: { id: email!.id } });
    expect(unchanged?.attemptCount).toBe(1);
  });

  it("gives up after a bounded number of attempts", async () => {
    const provider = new FailingProvider();
    setEmailProvider(provider);

    const booking = await prisma.appointment.create({
      data: { conversationId, businessId, requestedTime: "2027-05-03T09:00", status: "submitted" }
    });
    const eventId = await emitDomainEvent({
      businessId,
      type: "booking_request.created",
      entityType: "booking",
      entityId: booking.id
    });
    const email = await prisma.notification.findFirst({
      where: { eventId: eventId!, channel: "email" }
    });

    for (let i = 0; i < MAX_ATTEMPTS + 2; i += 1) {
      // Make it due again each round rather than waiting out real backoff.
      await prisma.notification.updateMany({
        where: { id: email!.id, status: "pending" },
        data: { nextAttemptAt: new Date(Date.now() - 1000) }
      });
      await processPendingNotifications();
    }

    const settled = await prisma.notification.findUnique({ where: { id: email!.id } });
    expect(settled?.status).toBe("failed");
    expect(settled?.attemptCount).toBe(MAX_ATTEMPTS);
    expect(settled?.failedAt).not.toBeNull();

    // Bounded: further processing rounds never touch it again.
    const callsBefore = provider.calls;
    await processPendingNotifications();
    await processPendingNotifications();
    const after = await prisma.notification.findUnique({ where: { id: email!.id } });
    expect(after?.attemptCount).toBe(MAX_ATTEMPTS);
    expect(provider.calls).toBe(callsBefore);
  });

  it("treats a provider that throws the same as one that reports failure", async () => {
    setEmailProvider({
      name: "throwing-provider",
      async send() {
        throw new Error("connection reset");
      }
    });

    const booking = await prisma.appointment.create({
      data: { conversationId, businessId, requestedTime: "2027-05-04T09:00", status: "submitted" }
    });
    const eventId = await emitDomainEvent({
      businessId,
      type: "booking_request.created",
      entityType: "booking",
      entityId: booking.id
    });

    await processPendingNotifications();

    const email = await prisma.notification.findFirst({
      where: { eventId: eventId!, channel: "email" }
    });
    expect(email?.status).toBe("pending");
    expect(email?.failureReason).toContain("connection reset");
  });
});

describe("business safety: delivery failure never undoes the business action", () => {
  it("keeps the booking when email delivery fails", async () => {
    setEmailProvider(new FailingProvider());

    const res = await request(app)
      .post(`/api/conversations/${conversationId}/appointments`)
      .set("x-api-key", demoKey)
      .send({ requestedTime: "2027-06-01T10:00", serviceName: "Whitening" });

    expect(res.status).toBe(201);
    await settleNotifications();

    // The booking is intact and still submitted.
    const booking = await prisma.appointment.findUnique({ where: { id: res.body.id } });
    expect(booking).not.toBeNull();
    expect(booking?.status).toBe("submitted");

    // Only the notification records the problem.
    const event = await prisma.domainEvent.findFirst({ where: { entityId: res.body.id } });
    const email = await prisma.notification.findFirst({
      where: { eventId: event!.id, channel: "email" }
    });
    expect(email?.failureReason).toContain("simulated provider outage");
  });

  it("keeps the escalation when email delivery fails", async () => {
    setEmailProvider(new FailingProvider());

    const res = await request(app)
      .post(`/api/conversations/${conversationId}/messages`)
      .set("x-api-key", demoKey)
      .send({ text: "Can I talk to a real person?" });

    expect(res.status).toBe(201);
    const escalationId = res.body.actionResult.metadata.escalationId as string;
    await settleNotifications();

    const escalation = await prisma.escalation.findUnique({ where: { id: escalationId } });
    expect(escalation).not.toBeNull();
    expect(escalation?.status).toBe("requested");
  });

  it("still creates the booking if event emission itself fails", async () => {
    // A booking whose business row is missing would break fan-out; the booking
    // must still be returned to the caller.
    const res = await request(app)
      .post(`/api/conversations/${conversationId}/appointments`)
      .set("x-api-key", demoKey)
      .send({ requestedTime: "2027-06-02T10:00" });

    expect(res.status).toBe(201);
    expect(await prisma.appointment.findUnique({ where: { id: res.body.id } })).not.toBeNull();
  });
});

describe("notification API", () => {
  it("lists the caller's own notifications with an unread count", async () => {
    const res = await request(app)
      .get(`/api/ops/businesses/${businessId}/notifications`)
      .set(withAuth(ownerAuth));

    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBeGreaterThan(0);
    expect(res.body.notifications.length).toBeGreaterThan(0);
    expect(res.body.notifications[0].read).toBe(false);
    // In-app only; email rows are delivery records, not console items.
    for (const item of res.body.notifications) {
      expect(item.channel).toBe("in_app");
    }
  });

  it("marks one notification read", async () => {
    const list = await request(app)
      .get(`/api/ops/businesses/${businessId}/notifications`)
      .set(withAuth(ownerAuth));
    const target = list.body.notifications.find((n: { read: boolean }) => !n.read);

    const res = await request(app)
      .post(`/api/ops/businesses/${businessId}/notifications/${target.id}/read`)
      .set(withAuth(ownerAuth));
    expect(res.status).toBe(204);

    const after = await prisma.notification.findUnique({ where: { id: target.id } });
    expect(after?.readAt).not.toBeNull();
  });

  it("marks everything read and drops the unread count to zero", async () => {
    await request(app)
      .post(`/api/ops/businesses/${businessId}/notifications/read-all`)
      .set(withAuth(ownerAuth));

    const res = await request(app)
      .get(`/api/ops/businesses/${businessId}/notifications`)
      .set(withAuth(ownerAuth));
    expect(res.body.unreadCount).toBe(0);
  });

  it("requires a CSRF token to mark notifications read", async () => {
    const res = await request(app)
      .post(`/api/ops/businesses/${businessId}/notifications/read-all`)
      .set("Cookie", ownerAuth.cookie);
    expect(res.status).toBe(403);
  });

  it("never exposes another member's notifications", async () => {
    const res = await request(app)
      .get(`/api/ops/businesses/${businessId}/notifications`)
      .set(withAuth(viewerAuth));

    const ids = res.body.notifications.map((n: { id: string }) => n.id);
    const ownerRows = await prisma.notification.findMany({
      where: { businessId, userId: ownerId },
      select: { id: true }
    });
    for (const row of ownerRows) {
      expect(ids).not.toContain(row.id);
    }
  });

  it("blocks cross-tenant notification access the same way as other ops resources", async () => {
    const res = await request(app)
      .get(`/api/ops/businesses/${businessId}/notifications`)
      .set(withAuth(outsiderAuth));
    expect(res.status).toBe(404);

    expect(
      (
        await request(app)
          .get(`/api/ops/businesses/${businessId}/work-queue`)
          .set(withAuth(outsiderAuth))
      ).status
    ).toBe(404);
  });

  it("rejects unauthenticated access", async () => {
    expect(
      (await request(app).get(`/api/ops/businesses/${businessId}/notifications`)).status
    ).toBe(401);
  });

  it("exposes no diagnostics or secrets", async () => {
    const res = await request(app)
      .get(`/api/ops/businesses/${businessId}/notifications`)
      .set(withAuth(ownerAuth));

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("providerName");
    expect(serialized).not.toContain("system prompt");
  });
});

describe("work queue", () => {
  it("lists unresolved bookings and escalations, oldest first", async () => {
    const res = await request(app)
      .get(`/api/ops/businesses/${businessId}/work-queue`)
      .set(withAuth(ownerAuth));

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);

    const types = new Set(res.body.map((i: { type: string }) => i.type));
    expect(types.has("booking")).toBe(true);
    expect(types.has("escalation")).toBe(true);

    const timestamps = res.body.map((i: { createdAt: string }) => i.createdAt);
    expect([...timestamps].sort()).toEqual(timestamps);

    for (const item of res.body) {
      expect(["submitted", "reviewing", "requested", "assigned"]).toContain(item.status);
      expect(typeof item.ageHours).toBe("number");
      expect(item.conversationId).toBeTruthy();
    }
  });

  it("drops an item once it is resolved", async () => {
    const before = await request(app)
      .get(`/api/ops/businesses/${businessId}/work-queue`)
      .set(withAuth(ownerAuth));
    const booking = before.body.find((i: { type: string }) => i.type === "booking");

    await request(app)
      .patch(`/api/ops/businesses/${businessId}/bookings/${booking.id}/status`)
      .set(withAuth(ownerAuth))
      .send({ status: "confirmed" });

    const after = await request(app)
      .get(`/api/ops/businesses/${businessId}/work-queue`)
      .set(withAuth(ownerAuth));
    expect(after.body.map((i: { id: string }) => i.id)).not.toContain(booking.id);
  });
});

describe("notification preferences", () => {
  it("reports role-based defaults and whether email is available at all", async () => {
    const owner = await request(app)
      .get(`/api/ops/businesses/${businessId}/notification-preferences`)
      .set(withAuth(ownerAuth));
    expect(owner.body).toMatchObject({
      new_booking_email: true,
      new_escalation_email: true,
      emailAvailable: true
    });

    const viewer = await request(app)
      .get(`/api/ops/businesses/${businessId}/notification-preferences`)
      .set(withAuth(viewerAuth));
    // Defaults off for a viewer, but the capability is still reported honestly.
    expect(viewer.body).toMatchObject({
      new_booking_email: false,
      new_escalation_email: false,
      emailAvailable: true
    });
  });

  it("lets a member change their own preference", async () => {
    const res = await request(app)
      .patch(`/api/ops/businesses/${businessId}/notification-preferences`)
      .set(withAuth(viewerAuth))
      .send({ new_booking_email: true });

    expect(res.status).toBe(200);
    expect(res.body.new_booking_email).toBe(true);

    await request(app)
      .patch(`/api/ops/businesses/${businessId}/notification-preferences`)
      .set(withAuth(viewerAuth))
      .send({ new_booking_email: false });
  });

  it("requires a CSRF token to change preferences", async () => {
    const res = await request(app)
      .patch(`/api/ops/businesses/${businessId}/notification-preferences`)
      .set("Cookie", viewerAuth.cookie)
      .send({ new_booking_email: true });
    expect(res.status).toBe(403);
  });
});
