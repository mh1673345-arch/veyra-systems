import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { emitDomainEvent } from "../src/services/notifications/events.js";
import { type Claim, claimDueNotifications, runWorkerPass } from "../src/services/notifications/worker.js";
import { MAX_ATTEMPTS, processClaimedNotification } from "../src/services/notifications/processor.js";
import {
  ConsoleEmailProvider,
  type DeliveryResult,
  type NotificationProvider,
  setEmailProvider
} from "../src/services/notifications/providers.js";

const app = createApp();
let businessId: string;
let conversationId: string;

/** Counts how many times delivery was actually attempted. */
class CountingProvider implements NotificationProvider {
  readonly name = "counting-provider";
  calls = 0;
  constructor(private readonly succeed = true) {}
  async send(): Promise<DeliveryResult> {
    this.calls += 1;
    // A little latency, so two workers genuinely overlap.
    await new Promise((resolve) => setTimeout(resolve, 15));
    return this.succeed
      ? { delivered: true, providerName: this.name }
      : { delivered: false, providerName: this.name, reason: "counting provider failure" };
  }
}

beforeAll(async () => {
  // Self-cleaning so the file can run without the pretest database reset.
  await prisma.user.deleteMany({ where: { email: { endsWith: "@worker.test" } } });

  const business = await prisma.business.create({
    data: { name: "Worker Dental", capEmailNotifications: true }
  });
  businessId = business.id;
  const conversation = await prisma.conversation.create({
    data: { businessId, callerName: "Wanda Worker" }
  });
  conversationId = conversation.id;

  const user = await prisma.user.create({
    data: { email: "worker@worker.test", name: "Wally", passwordHash: "x" }
  });
  await prisma.businessMembership.create({
    data: { userId: user.id, businessId, role: "OWNER" }
  });
});

afterEach(() => {
  setEmailProvider(null);
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function runWorkerPassFor(claims: Claim[]): Promise<void> {
  for (const claim of claims) await processClaimedNotification(claim);
}

const ids = (claims: Claim[]) => claims.map((c) => c.id);

async function seedPendingEvent(label: string): Promise<string> {
  const booking = await prisma.appointment.create({
    data: { conversationId, businessId, requestedTime: label, status: "submitted" }
  });
  const eventId = await emitDomainEvent({
    businessId,
    type: "booking_request.created",
    entityType: "booking",
    entityId: booking.id,
    payload: { customer: "Wanda Worker", service: "Cleaning" }
  });
  return eventId!;
}

describe("worker claiming", () => {
  it("claims due work and marks it owned", async () => {
    await prisma.notification.deleteMany({ where: { businessId } });
    await seedPendingEvent("2027-07-01T09:00");

    const claimed = await claimDueNotifications("worker-a", 10);
    expect(claimed.length).toBeGreaterThan(0);

    const rows = await prisma.notification.findMany({ where: { id: { in: ids(claimed) } } });
    for (const row of rows) {
      const claim = claimed.find((c) => c.id === row.id)!;
      expect(row.claimedBy).toBe("worker-a");
      expect(row.claimedAt).not.toBeNull();
      // Ownership is the per-claim token, not the worker name.
      expect(row.claimToken).toBe(claim.token);
      expect(row.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    }
    // Every claim gets its own token.
    expect(new Set(claimed.map((c) => c.token)).size).toBe(claimed.length);
  });

  it("does not hand the same notification to a second worker", async () => {
    await prisma.notification.deleteMany({ where: { businessId } });
    await seedPendingEvent("2027-07-02T09:00");

    const first = await claimDueNotifications("worker-a", 10);
    const second = await claimDueNotifications("worker-b", 10);

    expect(first.length).toBeGreaterThan(0);
    // Everything was already claimed, so the second worker gets nothing.
    expect(second).toEqual([]);
    expect(ids(first).filter((id) => ids(second).includes(id))).toEqual([]);
  });

  it("only one of two concurrent workers delivers each notification", async () => {
    await prisma.notification.deleteMany({ where: { businessId } });
    const provider = new CountingProvider();
    setEmailProvider(provider);

    await seedPendingEvent("2027-07-03T09:00");
    const total = await prisma.notification.count({ where: { businessId, status: "pending" } });
    expect(total).toBeGreaterThan(0);

    // Two workers race over the same queue.
    const [a, b] = await Promise.all([
      runWorkerPass("worker-a", 50),
      runWorkerPass("worker-b", 50)
    ]);

    // Between them they handle each row exactly once.
    expect(a.claimed + b.claimed).toBe(total);

    const rows = await prisma.notification.findMany({ where: { businessId } });
    for (const row of rows) {
      expect(row.status).toBe("sent");
      // The decisive check: one delivery attempt per notification, not two.
      expect(row.attemptCount).toBe(1);
    }
  });

  it("four concurrent workers over a larger queue deliver each notification exactly once", async () => {
    await prisma.notification.deleteMany({ where: { businessId } });
    setEmailProvider(new CountingProvider());

    for (let i = 0; i < 12; i += 1) {
      await seedPendingEvent(`2027-07-11T${String(8 + i).padStart(2, "0")}:00`);
    }
    const total = await prisma.notification.count({ where: { businessId, status: "pending" } });
    expect(total).toBeGreaterThanOrEqual(24);

    // Small batches so the workers keep going back to the queue and collide.
    const drain = async (id: string) => {
      const claimed: string[] = [];
      for (;;) {
        const batch = await claimDueNotifications(id, 3);
        if (batch.length === 0) return claimed;
        claimed.push(...ids(batch));
        await runWorkerPassFor(batch);
      }
    };
    const results = await Promise.all(["w1", "w2", "w3", "w4"].map(drain));
    const all = results.flat();

    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(total);

    const rows = await prisma.notification.findMany({ where: { businessId } });
    for (const row of rows) {
      expect(row.status).toBe("sent");
      expect(row.attemptCount).toBe(1);
    }
  });

  it("does not exceed one delivery per notification across repeated passes", async () => {
    await prisma.notification.deleteMany({ where: { businessId } });
    const provider = new CountingProvider();
    setEmailProvider(provider);

    await seedPendingEvent("2027-07-04T09:00");
    const expected = await prisma.notification.count({
      where: { businessId, status: "pending" }
    });
    expect(expected).toBeGreaterThan(0);

    await runWorkerPass("worker-a", 50);
    await runWorkerPass("worker-a", 50);
    await runWorkerPass("worker-b", 50);

    // Re-running the worker is idempotent. Asserted on the rows rather than a
    // provider call counter: other suites share this database and their own
    // background processing would inflate a global counter.
    const rows = await prisma.notification.findMany({ where: { businessId } });
    expect(rows).toHaveLength(expected);
    for (const row of rows) {
      expect(row.status).toBe("sent");
      expect(row.attemptCount).toBe(1);
    }
    expect(provider.calls).toBeGreaterThan(0);
  });

  it("releases the claim after a failed attempt so a retry is possible", async () => {
    await prisma.notification.deleteMany({ where: { businessId } });
    setEmailProvider(new CountingProvider(false));

    await seedPendingEvent("2027-07-05T09:00");
    await runWorkerPass("worker-a", 50);

    const email = await prisma.notification.findFirst({
      where: { businessId, channel: "email" }
    });
    expect(email?.status).toBe("pending");
    expect(email?.attemptCount).toBe(1);
    // Not left owned by a worker that has moved on.
    expect(email?.claimedAt).toBeNull();
    expect(email?.claimedBy).toBeNull();
    expect(email?.claimToken).toBeNull();
    expect(email?.leaseExpiresAt).toBeNull();
  });

  it("reclaims work stranded by a worker that died mid-delivery", async () => {
    await prisma.notification.deleteMany({ where: { businessId } });
    await seedPendingEvent("2027-07-06T09:00");

    const row = await prisma.notification.findFirst({ where: { businessId } });
    // Simulate a crashed worker: claimed long ago, lease lapsed, never finished.
    await prisma.notification.update({
      where: { id: row!.id },
      data: {
        claimedAt: new Date(Date.now() - 10 * 60 * 1000),
        claimedBy: "dead-worker",
        claimToken: "dead-token",
        leaseExpiresAt: new Date(Date.now() - 8 * 60 * 1000)
      }
    });

    const claimed = await claimDueNotifications("worker-b", 10);
    expect(ids(claimed)).toContain(row!.id);
    const after = await prisma.notification.findUniqueOrThrow({ where: { id: row!.id } });
    expect(after.claimToken).not.toBe("dead-token");
  });

  it("respects nextAttemptAt and does not claim work that is not due", async () => {
    await prisma.notification.deleteMany({ where: { businessId } });
    await seedPendingEvent("2027-07-07T09:00");

    await prisma.notification.updateMany({
      where: { businessId },
      data: { nextAttemptAt: new Date(Date.now() + 60 * 60 * 1000), attemptCount: 1 }
    });

    expect(await claimDueNotifications("worker-a", 10)).toEqual([]);
  });

  it("does not claim work that has exhausted its retries", async () => {
    await prisma.notification.deleteMany({ where: { businessId } });
    await seedPendingEvent("2027-07-08T09:00");

    await prisma.notification.updateMany({
      where: { businessId },
      data: { attemptCount: MAX_ATTEMPTS, nextAttemptAt: new Date(Date.now() - 1000) }
    });

    expect(await claimDueNotifications("worker-a", 10)).toEqual([]);
  });

  it("survives a provider that throws without losing the notification", async () => {
    await prisma.notification.deleteMany({ where: { businessId } });
    setEmailProvider({
      name: "exploding",
      async send() {
        throw new Error("boom");
      }
    });

    await seedPendingEvent("2027-07-09T09:00");
    // The pass completes rather than propagating the error.
    const result = await runWorkerPass("worker-a", 50);
    expect(result.claimed).toBeGreaterThan(0);

    const email = await prisma.notification.findFirst({
      where: { businessId, channel: "email" }
    });
    // Still there, still retryable.
    expect(email?.status).toBe("pending");
    expect(email?.failureReason).toContain("boom");
  });

  it("picks up work left pending across a restart", async () => {
    await prisma.notification.deleteMany({ where: { businessId } });
    setEmailProvider(new ConsoleEmailProvider());

    await seedPendingEvent("2027-07-10T09:00");
    const pendingBefore = await prisma.notification.count({
      where: { businessId, status: "pending" }
    });
    expect(pendingBefore).toBeGreaterThan(0);

    // A "restarted" worker is just a new id reading the same table.
    const result = await runWorkerPass(`restarted-${Date.now()}`, 50);
    expect(result.claimed).toBe(pendingBefore);
    expect(await prisma.notification.count({ where: { businessId, status: "pending" } })).toBe(0);
  });
});

describe("health and readiness", () => {
  it("reports liveness without touching the database", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("reports readiness including database reachability", async () => {
    const res = await request(app).get("/api/ready");

    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(res.body.checks.database).toBe("ok");
    expect(res.body.environment).toBe("test");
  });

  it("does not make readiness depend on the AI provider", async () => {
    const res = await request(app).get("/api/ready");

    // The deterministic responder keeps Reception working, so a provider that
    // is unavailable must not take the instance out of rotation.
    expect(res.body.ready).toBe(true);
    expect(res.body.checks.responder).toBe("rule-based");
    // Degradation is still visible internally.
    expect(res.body).toHaveProperty("providerDegraded");
  });

  it("exposes no secrets in readiness output", async () => {
    const res = await request(app).get("/api/ready");
    const serialized = JSON.stringify(res.body);

    expect(serialized).not.toContain("sk-ant");
    expect(serialized).not.toContain("DATABASE_URL");
    expect(serialized).not.toContain("password");
  });
});
