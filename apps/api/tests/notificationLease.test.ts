import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client.js";
import {
  type LeaseConfig,
  LeaseConfigError,
  claimDueNotifications,
  leaseConfig,
  releaseClaim,
  renewLease,
  startLeaseHeartbeat
} from "../src/services/notifications/lease.js";
import {
  deliverClaims,
  processClaimedNotification,
  processPendingNotifications
} from "../src/services/notifications/processor.js";
import {
  ConsoleEmailProvider,
  type DeliveryResult,
  type NotificationProvider,
  type OutboundMessage,
  notificationIdempotencyKey,
  setEmailProvider
} from "../src/services/notifications/providers.js";

let businessId: string;
let userId: string;

/** A lease long enough that no heartbeat fires during a test. */
const QUIET: LeaseConfig = { leaseMs: 60_000, heartbeatMs: 30_000 };

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: "@lease.test" } } });
  businessId = (
    await prisma.business.create({ data: { name: "Lease Dental", capEmailNotifications: true } })
  ).id;
  userId = (
    await prisma.user.create({ data: { email: "owner@lease.test", name: "Lee", passwordHash: "x" } })
  ).id;
});

beforeEach(async () => {
  // Claims are global, so each test starts from an empty queue.
  await prisma.notification.deleteMany({});
});

afterEach(() => {
  setEmailProvider(null);
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function seedEmail(): Promise<string> {
  const event = await prisma.domainEvent.create({
    data: { businessId, type: "booking_request.created", entityType: "booking", entityId: "lease" }
  });
  const n = await prisma.notification.create({
    data: { businessId, userId, eventId: event.id, channel: "email", subject: "Lease test" }
  });
  return n.id;
}

/** A provider whose first send blocks until released, recording every message. */
class GatedProvider implements NotificationProvider {
  readonly name = "gated";
  readonly messages: OutboundMessage[] = [];
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => (this.release = resolve));
  private blocked = false;
  started!: Promise<void>;
  private markStarted!: () => void;

  constructor(private readonly outcome: "deliver" | "fail" = "deliver") {
    this.started = new Promise((resolve) => (this.markStarted = resolve));
  }

  async send(message: OutboundMessage): Promise<DeliveryResult> {
    this.messages.push(message);
    if (!this.blocked) {
      this.blocked = true;
      this.markStarted();
      await this.gate;
    }
    return this.outcome === "deliver"
      ? { delivered: true, providerName: this.name }
      : { delivered: false, providerName: this.name, reason: "gated failure" };
  }

  open(): void {
    this.release();
  }
}

const later = (from: Date, ms: number) => new Date(from.getTime() + ms);

describe("claim ownership", () => {
  it("gives each claim its own token and lease", async () => {
    const id = await seedEmail();
    const t0 = new Date();
    const [claim] = await claimDueNotifications("worker-a", 1, t0, QUIET);

    const row = await prisma.notification.findUniqueOrThrow({ where: { id } });
    expect(row.claimToken).toBe(claim.token);
    expect(claim.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.leaseExpiresAt?.getTime()).toBe(t0.getTime() + QUIET.leaseMs);
    expect(row.claimedBy).toBe("worker-a");
  });

  it("does not let a second worker claim before the lease expires, and does after", async () => {
    await seedEmail();
    const t0 = new Date();
    await claimDueNotifications("worker-a", 1, t0, QUIET);

    expect(await claimDueNotifications("worker-b", 1, later(t0, QUIET.leaseMs - 1), QUIET)).toEqual([]);
    expect(await claimDueNotifications("worker-b", 1, later(t0, QUIET.leaseMs), QUIET)).toEqual([]);
    // Dead worker recovery: no renewal, lease genuinely past.
    expect(await claimDueNotifications("worker-b", 1, later(t0, QUIET.leaseMs + 1), QUIET)).toHaveLength(1);
  });

  it("a renewed lease blocks reclaiming until the renewed expiry has passed", async () => {
    await seedEmail();
    const t0 = new Date();
    const [a] = await claimDueNotifications("worker-a", 1, t0, QUIET);

    // Heartbeat just before expiry.
    expect(await renewLease(a, later(t0, QUIET.leaseMs - 10), QUIET)).toBe(true);

    expect(await claimDueNotifications("worker-b", 1, later(t0, QUIET.leaseMs + 1), QUIET)).toEqual([]);
    expect(
      await claimDueNotifications("worker-b", 1, later(t0, 2 * QUIET.leaseMs - 10 + 1), QUIET)
    ).toHaveLength(1);
  });

  it("a stale owner can neither renew nor release a row another worker now owns", async () => {
    const id = await seedEmail();
    const t0 = new Date();
    const [a] = await claimDueNotifications("worker-a", 1, t0, QUIET);
    const [b] = await claimDueNotifications("worker-b", 1, later(t0, QUIET.leaseMs + 1), QUIET);

    expect(await renewLease(a, later(t0, QUIET.leaseMs + 2), QUIET)).toBe(false);
    expect(await releaseClaim(a)).toBe(false);

    const row = await prisma.notification.findUniqueOrThrow({ where: { id } });
    expect(row.claimToken).toBe(b.token);
    expect(row.claimedBy).toBe("worker-b");
  });

  it("the fire-and-forget processor skips a row another worker owns", async () => {
    const id = await seedEmail();
    const provider = new GatedProvider();
    setEmailProvider(provider);
    await claimDueNotifications("worker-a", 1, new Date(), QUIET);

    // Before this phase this delivered the row regardless of the claim.
    const result = await processPendingNotifications();
    expect(result.attempted).toBe(0);
    expect(provider.messages).toHaveLength(0);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id } })).status).toBe("pending");
  });
});

describe("regression: delivery outliving its lease (the original bug)", () => {
  it("a worker whose lease was taken over sends nothing if it has not started yet", async () => {
    const id = await seedEmail();
    const provider = new GatedProvider();
    setEmailProvider(provider);
    const t0 = new Date();
    const [a] = await claimDueNotifications("worker-a", 1, t0, QUIET);
    await claimDueNotifications("worker-b", 1, later(t0, QUIET.leaseMs + 1), QUIET);

    expect(await processClaimedNotification(a, { lease: QUIET })).toBe("lost_ownership");
    expect(provider.messages).toHaveLength(0);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id } })).attemptCount).toBe(0);
  });

  it("refreshes a nearly expired lease before sending, so a claim that waited in a batch is not stolen mid-send", async () => {
    const id = await seedEmail();
    const provider = new GatedProvider();
    setEmailProvider(provider);

    // Claimed long enough ago (e.g. queued behind slow deliveries in the same
    // batch) that its lease has only 1 second left.
    const now = new Date();
    const [a] = await claimDueNotifications("worker-a", 1, later(now, 1_000 - QUIET.leaseMs), QUIET);
    const aDelivery = processClaimedNotification(a, { lease: QUIET });
    await provider.started;

    // 2 seconds on, the original lease is gone — but the send started under a fresh one.
    expect(await claimDueNotifications("worker-b", 1, later(now, 2_000), QUIET)).toEqual([]);

    provider.open();
    expect(await aDelivery).toBe("sent");
    expect(provider.messages).toHaveLength(1);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id } })).attemptCount).toBe(1);
  });

  it("stale worker A's finalization is rejected once worker B has reclaimed and delivered", async () => {
    const id = await seedEmail();
    const provider = new GatedProvider();
    setEmailProvider(provider);

    const t0 = new Date();
    const [a] = await claimDueNotifications("worker-a", 1, t0, QUIET);
    // A is mid-send and (with a quiet heartbeat) does not renew in this window.
    const aDelivery = processClaimedNotification(a, { lease: QUIET });
    await provider.started;

    // Well past A's lease from B's point of view: A looks dead, B reclaims.
    const bClaims = await claimDueNotifications("worker-b", 1, later(t0, 10 * QUIET.leaseMs), QUIET);
    expect(bClaims).toHaveLength(1);
    const bOutcome = await processClaimedNotification(bClaims[0], { lease: QUIET });
    expect(bOutcome).toBe("sent");

    // A's provider call finally returns.
    provider.open();
    expect(await aDelivery).toBe("lost_ownership");

    const row = await prisma.notification.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("sent");
    // Recorded once, by B — A's late write did not bump or overwrite it.
    expect(row.attemptCount).toBe(1);
    expect(row.providerName).toBe("gated");
    expect(row.claimToken).toBeNull();
    // Both sends carried the same idempotency key, so a vendor that supports
    // keys could collapse the second one.
    expect(provider.messages.map((m) => m.idempotencyKey)).toEqual([
      notificationIdempotencyKey(id),
      notificationIdempotencyKey(id)
    ]);
  });

  it("a stale worker's failure write is rejected too", async () => {
    const id = await seedEmail();
    const provider = new GatedProvider("fail");
    setEmailProvider(provider);

    const t0 = new Date();
    const [a] = await claimDueNotifications("worker-a", 1, t0, QUIET);
    const aDelivery = processClaimedNotification(a, { lease: QUIET });
    await provider.started;

    const [b] = await claimDueNotifications("worker-b", 1, later(t0, 10 * QUIET.leaseMs), QUIET);
    provider.open();
    expect(await aDelivery).toBe("lost_ownership");

    // A did not schedule a retry or record an attempt; B still owns the row.
    const row = await prisma.notification.findUniqueOrThrow({ where: { id } });
    expect(row.attemptCount).toBe(0);
    expect(row.nextAttemptAt).toBeNull();
    expect(row.claimToken).toBe(b.token);
  });

  it(
    "a long delivery keeps its lease alive: a second worker claims nothing midway and the send happens once",
    { timeout: 20_000 },
    async () => {
      const id = await seedEmail();
      const lease: LeaseConfig = { leaseMs: 800, heartbeatMs: 200 };
      let calls = 0;
      let startedAt = 0;
      const deliveryMs = 3 * lease.leaseMs;
      setEmailProvider({
        name: "slow",
        async send() {
          calls += 1;
          startedAt = Date.now();
          await new Promise((resolve) => setTimeout(resolve, deliveryMs));
          return { delivered: true, providerName: "slow" };
        }
      });

      const [a] = await claimDueNotifications("worker-a", 1, new Date(), lease);
      const aDelivery = processClaimedNotification(a, { lease });

      // Probe repeatedly well past the original lease, using the real clock.
      const bClaimed: number[] = [];
      while (startedAt === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      while (Date.now() - startedAt < deliveryMs - lease.heartbeatMs) {
        await new Promise((resolve) => setTimeout(resolve, lease.heartbeatMs));
        bClaimed.push((await claimDueNotifications("worker-b", 1, new Date(), lease)).length);
      }

      expect(await aDelivery).toBe("sent");
      // Several probes landed after the original lease would have expired.
      expect(bClaimed.length).toBeGreaterThanOrEqual(5);
      expect(bClaimed.every((n) => n === 0)).toBe(true);
      expect(calls).toBe(1);

      const row = await prisma.notification.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("sent");
      expect(row.attemptCount).toBe(1);
      expect(row.claimToken).toBeNull();
      expect(row.leaseExpiresAt).toBeNull();
    }
  );
});

describe("batch delivery", () => {
  it(
    "keeps claims waiting behind a slow delivery alive, so a polling worker cannot take them",
    { timeout: 20_000 },
    async () => {
      const lease: LeaseConfig = { leaseMs: 600, heartbeatMs: 150 };
      const first = await seedEmail();
      const second = await seedEmail();
      const sends: string[] = [];
      setEmailProvider({
        name: "slow-first",
        async send(message) {
          sends.push(message.idempotencyKey!);
          // Only the first delivery is slow: 4x the lease.
          if (sends.length === 1) await new Promise((resolve) => setTimeout(resolve, lease.leaseMs * 4));
          return { delivered: true, providerName: "slow-first" };
        }
      });

      const claims = await claimDueNotifications("worker-a", 2, new Date(), lease);
      expect(claims).toHaveLength(2);
      const batch = deliverClaims(claims, { lease });

      // A competing worker polls throughout the slow first delivery.
      let competitorClaims = 0;
      let finished = false;
      void batch.then(() => (finished = true));
      while (!finished) {
        competitorClaims += (await claimDueNotifications("worker-b", 5, new Date(), lease)).length;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      expect(await batch).toMatchObject({ sent: 2, lostOwnership: 0 });
      expect(competitorClaims).toBe(0);
      expect(sends).toEqual([notificationIdempotencyKey(first), notificationIdempotencyKey(second)]);
    }
  );
});

describe("lease heartbeat", () => {
  const FAST: LeaseConfig = { leaseMs: 400, heartbeatMs: 100 };
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("renews while running and stops writing once stopped", async () => {
    const id = await seedEmail();
    const [claim] = await claimDueNotifications("worker-a", 1, new Date(), FAST);
    const heartbeat = startLeaseHeartbeat(claim, FAST);

    await pause(FAST.heartbeatMs * 3.5);
    await heartbeat.stop();
    expect(heartbeat.renewals).toBeGreaterThanOrEqual(2);
    expect(heartbeat.lost).toBe(false);

    const frozen = (await prisma.notification.findUniqueOrThrow({ where: { id } })).leaseExpiresAt;
    await pause(FAST.heartbeatMs * 3);
    const after = (await prisma.notification.findUniqueOrThrow({ where: { id } })).leaseExpiresAt;
    expect(after?.getTime()).toBe(frozen?.getTime());
  });

  it("detects lost ownership, stops, and signals the delivery", async () => {
    await seedEmail();
    const t0 = new Date();
    const [a] = await claimDueNotifications("worker-a", 1, t0, FAST);
    let signalled = false;
    const heartbeat = startLeaseHeartbeat(a, FAST, () => (signalled = true));

    // Another worker takes the row (as if A's lease had lapsed).
    await claimDueNotifications("worker-b", 1, later(t0, 60_000), FAST);
    await pause(FAST.heartbeatMs * 2.5);

    expect(heartbeat.lost).toBe(true);
    expect(signalled).toBe(true);
    const renewals = heartbeat.renewals;
    await pause(FAST.heartbeatMs * 2);
    expect(heartbeat.renewals).toBe(renewals);
    await heartbeat.stop();
  });

  it("aborts the provider's signal when the lease is lost mid-delivery", { timeout: 20_000 }, async () => {
    const id = await seedEmail();
    let aborted = false;
    setEmailProvider({
      name: "abortable",
      send(message) {
        return new Promise<DeliveryResult>((resolve) => {
          message.signal?.addEventListener("abort", () => {
            aborted = true;
            resolve({ delivered: false, providerName: "abortable", reason: "aborted" });
          });
        });
      }
    });

    const t0 = new Date();
    const [a] = await claimDueNotifications("worker-a", 1, t0, FAST);
    const aDelivery = processClaimedNotification(a, { lease: FAST });
    await pause(FAST.heartbeatMs / 2);
    await claimDueNotifications("worker-b", 1, later(t0, 60_000), FAST);

    expect(await aDelivery).toBe("lost_ownership");
    expect(aborted).toBe(true);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id } })).attemptCount).toBe(0);
  });

  it("releases the lease on success, on a scheduled retry and on permanent failure", async () => {
    const quietDue = async () => (await claimDueNotifications("w", 1, new Date(), QUIET))[0];

    setEmailProvider({ name: "ok", send: async () => ({ delivered: true, providerName: "ok" }) });
    const sentId = await seedEmail();
    expect(await processClaimedNotification(await quietDue(), { lease: QUIET })).toBe("sent");

    setEmailProvider({ name: "no", send: async () => ({ delivered: false, providerName: "no", reason: "x" }) });
    const retryId = await seedEmail();
    expect(await processClaimedNotification(await quietDue(), { lease: QUIET })).toBe("retrying");

    const failId = await seedEmail();
    await prisma.notification.update({ where: { id: failId }, data: { attemptCount: 4 } });
    expect(await processClaimedNotification(await quietDue(), { lease: QUIET })).toBe("failed");

    const rows = await prisma.notification.findMany({ where: { id: { in: [sentId, retryId, failId] } } });
    expect(rows.map((r) => r.status).sort()).toEqual(["failed", "pending", "sent"]);
    for (const row of rows) {
      expect(row.claimToken).toBeNull();
      expect(row.leaseExpiresAt).toBeNull();
      expect(row.claimedBy).toBeNull();
      expect(row.claimedAt).toBeNull();
    }
  });
});

describe("provider idempotency hook", () => {
  it("passes the same key on every attempt, whichever worker makes it", async () => {
    const id = await seedEmail();
    const keys: (string | undefined)[] = [];
    let attempt = 0;
    setEmailProvider({
      name: "recording",
      async send(message) {
        keys.push(message.idempotencyKey);
        attempt += 1;
        return attempt === 1
          ? { delivered: false, providerName: "recording", reason: "first attempt fails" }
          : { delivered: true, providerName: "recording" };
      }
    });

    const [a] = await claimDueNotifications("worker-a", 1, new Date(), QUIET);
    expect(await processClaimedNotification(a, { lease: QUIET })).toBe("retrying");
    await prisma.notification.update({ where: { id }, data: { nextAttemptAt: new Date(Date.now() - 1) } });
    const [b] = await claimDueNotifications("worker-b", 1, new Date(), QUIET);
    expect(await processClaimedNotification(b, { lease: QUIET })).toBe("sent");

    expect(keys).toEqual([notificationIdempotencyKey(id), notificationIdempotencyKey(id)]);
    // Derived from identity only: no recipient address or content in the key.
    expect(keys[0]).not.toContain("@");
  });

  it("the development provider collapses a repeat of an accepted key", async () => {
    const provider = new ConsoleEmailProvider();
    const message = { to: "a@lease.test", subject: "s", body: "b", idempotencyKey: "veyra-notification:x" };

    const first = await provider.send(message);
    const second = await provider.send(message);

    expect(first.delivered && second.delivered).toBe(true);
    expect(provider.messages()).toHaveLength(1);
    expect(second.delivered && second.detail).toContain("duplicate suppressed");
    // Messages without a key are never collapsed.
    await provider.send({ to: "a@lease.test", subject: "s", body: "b" });
    await provider.send({ to: "a@lease.test", subject: "s", body: "b" });
    expect(provider.messages()).toHaveLength(3);
  });
});

describe("lease configuration", () => {
  it("defaults to a 2 minute lease renewed every 30 seconds", () => {
    expect(leaseConfig({})).toEqual({ leaseMs: 120_000, heartbeatMs: 30_000 });
  });

  it("is configurable, and derives the heartbeat from the lease", () => {
    expect(leaseConfig({ VEYRA_NOTIFICATION_LEASE_MS: "2000" })).toEqual({ leaseMs: 2000, heartbeatMs: 500 });
    expect(
      leaseConfig({ VEYRA_NOTIFICATION_LEASE_MS: "2000", VEYRA_NOTIFICATION_HEARTBEAT_MS: "1000" })
    ).toEqual({ leaseMs: 2000, heartbeatMs: 1000 });
  });

  it("rejects a heartbeat too slow to keep the lease alive, and junk values", () => {
    expect(() =>
      leaseConfig({ VEYRA_NOTIFICATION_LEASE_MS: "2000", VEYRA_NOTIFICATION_HEARTBEAT_MS: "1500" })
    ).toThrow(LeaseConfigError);
    expect(() => leaseConfig({ VEYRA_NOTIFICATION_LEASE_MS: "soon" })).toThrow(LeaseConfigError);
    expect(() => leaseConfig({ VEYRA_NOTIFICATION_HEARTBEAT_MS: "-5" })).toThrow(LeaseConfigError);
  });
});
