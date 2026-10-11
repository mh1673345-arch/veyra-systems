import { randomUUID } from "node:crypto";
import { prisma } from "../../db/client.js";
import {
  CLEARED_CLAIM,
  type Claim,
  type LeaseConfig,
  MAX_ATTEMPTS,
  claimDueNotifications,
  leaseConfig,
  releaseClaim,
  renewLease,
  startBatchHeartbeat,
  startLeaseHeartbeat
} from "./lease.js";
import { InAppProvider, createEmailProvider, notificationIdempotencyKey } from "./providers.js";
import { messagingNotificationProvider } from "../messaging/notificationAdapter.js";

export { MAX_ATTEMPTS };

/**
 * Delivery processing.
 *
 * Every path that delivers — the durable worker, the fire-and-forget pass right
 * after an event is emitted, and `npm run notifications:process` — goes through
 * a claim lease (see lease.ts), so two of them can never own the same
 * notification at once, and a worker that has lost its lease cannot record an
 * outcome.
 *
 * Delivery guarantee, stated precisely: at most one active internal owner per
 * notification. External delivery is at-least-once in one narrow case — the
 * provider accepts the message and the process dies before the database records
 * it; the lease then lapses and another worker retries. That retry carries the
 * same idempotency key, so a vendor that supports keys can collapse it. This is
 * not, and does not claim to be, exactly-once external delivery.
 */

/** Backoff in minutes per attempt number (1-indexed). */
const BACKOFF_MINUTES = [1, 5, 15, 60];

function nextAttemptDelayMs(attemptCount: number): number {
  const minutes = BACKOFF_MINUTES[Math.min(attemptCount - 1, BACKOFF_MINUTES.length - 1)];
  return minutes * 60 * 1000;
}

export interface ProcessResult {
  attempted: number;
  sent: number;
  failed: number;
  retrying: number;
  lostOwnership: number;
}

/**
 * "lost_ownership": this worker no longer holds the claim, so it recorded
 * nothing. It is never counted as sent, retrying or failed.
 */
export type DeliveryOutcome = "sent" | "failed" | "retrying" | "lost_ownership";

export interface DeliveryOptions {
  lease?: LeaseConfig;
}

/** Delivers one claimed notification, holding its lease for the duration. */
export async function processClaimedNotification(
  claim: Claim,
  options: DeliveryOptions = {}
): Promise<DeliveryOutcome> {
  const lease = options.lease ?? leaseConfig();

  // Re-assert ownership and refresh the lease *before* sending. A claim can sit
  // in a batch while earlier deliveries run; if its lease lapsed and another
  // worker took it, this matches nothing and we send nothing.
  if (!(await renewLease(claim, new Date(), lease))) {
    return lostOwnership(claim, "before delivery");
  }

  const notification = await prisma.notification.findFirst({
    where: { id: claim.id, claimToken: claim.token, status: "pending" },
    include: { user: { select: { email: true, name: true } } }
  });
  if (!notification) return lostOwnership(claim, "before delivery");

  const provider =
    notification.channel === "email"
      ? createEmailProvider()
      : notification.channel === "sms" || notification.channel === "whatsapp"
        ? messagingNotificationProvider(notification.channel, notification.businessId)
        : new InAppProvider();
  const attemptCount = notification.attemptCount + 1;

  // An explicit external destination wins; otherwise the member's own
  // address. The database CHECK guarantees exactly one of the three is set,
  // so this is a precedence rule on paper only — it can never silently pick
  // between two populated fields. In-app notifications have no destination
  // and do not need one.
  const destination =
    notification.recipientPhone ?? notification.recipientEmail ?? notification.user?.email ?? "";
  /** Channels that cannot do anything without somewhere to send. */
  const needsDestination = notification.channel !== "in_app";

  const abort = new AbortController();
  const heartbeat = startLeaseHeartbeat(claim, lease, () => abort.abort());

  let delivery;
  try {
    // Defence in depth: the CHECK constraint means a row on a channel that
    // needs a destination always has exactly one, so this should be
    // unreachable. If that ever stops being true, failing here keeps an empty
    // recipient away from the vendor instead of sending it and letting the
    // vendor decide what it means.
    delivery =
      needsDestination && destination === ""
        ? {
            delivered: false as const,
            providerName: provider.name,
            reason: "This notification has no recipient address."
          }
        : await provider.send({
            to: destination,
            subject: notification.subject,
            body: notification.body,
            idempotencyKey: notificationIdempotencyKey(notification.id),
            signal: abort.signal
          });
  } catch (err) {
    // A provider that throws is treated exactly like one that reports failure.
    delivery = {
      delivered: false as const,
      providerName: provider.name,
      reason: err instanceof Error ? err.message : "Provider threw an unknown error"
    };
  } finally {
    // Stop renewing before finalizing, whatever happened.
    await heartbeat.stop();
  }

  const now = new Date();
  // Every outcome write is conditional on still owning the claim.
  const owned = { id: notification.id, claimToken: claim.token, status: "pending" };

  if (delivery.delivered) {
    const result = await prisma.notification.updateMany({
      where: owned,
      data: {
        status: "sent",
        sentAt: now,
        attemptCount,
        lastAttemptAt: now,
        nextAttemptAt: null,
        providerName: delivery.providerName,
        // Records *how* it was delivered, so a console capture is never
        // mistaken for a real email.
        failureReason: delivery.detail ?? null,
        // Messaging channels only: what the provider has said so far. For a
        // message this is "accepted", not "delivered" — a receipt may
        // upgrade it later, and nothing claims delivery before one arrives.
        providerMessageId: delivery.providerMessageId ?? null,
        deliveryStatus: delivery.deliveryStatus ?? null,
        deliveryUpdatedAt: delivery.deliveryStatus ? now : null,
        ...CLEARED_CLAIM
      }
    });
    if (result.count === 0) return lostOwnership(claim, "after a successful send");
    await markEventSettled(notification.eventId);
    return "sent";
  }

  // A permanent failure is not worth four more attempts: an invalid number,
  // a rejected template or an opted-out recipient will refuse just as firmly
  // in an hour, and retrying them only delays the operator finding out.
  // Adapters that cannot tell leave `retryable` undefined, which keeps the
  // original behaviour of retrying.
  const permanent = delivery.retryable === false;
  const exhausted = permanent || attemptCount >= MAX_ATTEMPTS;
  const result = await prisma.notification.updateMany({
    where: owned,
    data: {
      status: exhausted ? "failed" : "pending",
      attemptCount,
      lastAttemptAt: now,
      nextAttemptAt: exhausted ? null : new Date(now.getTime() + nextAttemptDelayMs(attemptCount)),
      failedAt: exhausted ? now : null,
      providerName: delivery.providerName,
      failureReason: delivery.reason,
      deliveryStatus: delivery.deliveryStatus ?? null,
      deliveryUpdatedAt: delivery.deliveryStatus ? now : null,
      // Released either way; a retry is a fresh claim once it is due.
      ...CLEARED_CLAIM
    }
  });
  if (result.count === 0) return lostOwnership(claim, "after a failed attempt");

  await markEventSettled(notification.eventId);
  return exhausted ? "failed" : "retrying";
}

function lostOwnership(claim: Claim, stage: string): DeliveryOutcome {
  console.warn(
    "[veyra:worker] ownership lost %s id=%s worker=%s — outcome not recorded by this worker",
    stage,
    claim.id,
    claim.workerId
  );
  return "lost_ownership";
}

async function markEventSettled(eventId: string): Promise<void> {
  const pending = await prisma.notification.count({ where: { eventId, status: "pending" } });
  if (pending === 0) {
    await prisma.domainEvent.updateMany({
      where: { id: eventId, processedAt: null },
      data: { processedAt: new Date() }
    });
  }
}

export interface DeliveryTally {
  sent: number;
  failed: number;
  retrying: number;
  lostOwnership: number;
  /** Deliveries that threw unexpectedly; their claims were released. */
  errored: number;
}

/**
 * Delivers a batch of claims one at a time. Claims still waiting their turn
 * are kept alive by a batch heartbeat; the one being delivered has its own.
 */
export async function deliverClaims(
  claims: Claim[],
  options: DeliveryOptions & { onOutcome?: (claim: Claim, outcome: DeliveryOutcome | "errored") => void } = {}
): Promise<DeliveryTally> {
  const lease = options.lease ?? leaseConfig();
  const tally: DeliveryTally = { sent: 0, failed: 0, retrying: 0, lostOwnership: 0, errored: 0 };
  const waiting = [...claims];
  const batchHeartbeat = startBatchHeartbeat(() => waiting, lease);

  try {
    while (waiting.length > 0) {
      const claim = waiting.shift()!;
      let outcome: DeliveryOutcome | "errored";
      try {
        outcome = await processClaimedNotification(claim, { lease });
      } catch (err) {
        // A delivery crash must never take the worker (or the API) down. The
        // release is owner-only, so it cannot free a row someone else now holds.
        console.error("Notification %s failed to process", claim.id, err);
        await releaseClaim(claim).catch(() => undefined);
        outcome = "errored";
      }
      if (outcome === "sent") tally.sent += 1;
      else if (outcome === "failed") tally.failed += 1;
      else if (outcome === "retrying") tally.retrying += 1;
      else if (outcome === "lost_ownership") tally.lostOwnership += 1;
      else tally.errored += 1;
      options.onOutcome?.(claim, outcome);
    }
  } finally {
    await batchHeartbeat.stop();
  }
  return tally;
}

/**
 * One claimed pass over due notifications. Used by the fire-and-forget trigger
 * and the manual script; it competes with the durable worker through the same
 * leases rather than bypassing them.
 */
export async function processPendingNotifications(limit = 50): Promise<ProcessResult> {
  const workerId = `inline-${process.pid}-${randomUUID().slice(0, 8)}`;
  const lease = leaseConfig();
  const claims = await claimDueNotifications(workerId, limit, new Date(), lease);
  const tally = await deliverClaims(claims, { lease });

  const result: ProcessResult = {
    attempted: claims.length,
    sent: tally.sent,
    failed: tally.failed,
    retrying: tally.retrying,
    lostOwnership: tally.lostOwnership
  };

  // An event is "processed" once none of its notifications are still pending
  // (including events that fanned out to no one).
  await markSettledEvents();

  return result;
}

async function markSettledEvents(): Promise<void> {
  const unsettled = await prisma.domainEvent.findMany({
    where: { processedAt: null },
    select: { id: true }
  });

  for (const event of unsettled) {
    const pending = await prisma.notification.count({
      where: { eventId: event.id, status: "pending" }
    });
    if (pending === 0) {
      await prisma.domainEvent.updateMany({
        where: { id: event.id, processedAt: null },
        data: { processedAt: new Date() }
      });
    }
  }
}

/**
 * Fire-and-forget trigger used right after an event is emitted. Never awaited
 * by a request handler, and never allowed to reject.
 */
export function scheduleProcessing(): void {
  void processPendingNotifications().catch((err) =>
    console.error("Notification processing failed", err)
  );
}
