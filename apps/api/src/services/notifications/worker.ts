import { randomUUID } from "node:crypto";
import { type Claim, type LeaseConfig, claimDueNotifications, leaseConfig } from "./lease.js";
import { deliverClaims } from "./processor.js";

export { claimDueNotifications, type Claim };

/**
 * Durable notification worker.
 *
 * The database is the queue. Claiming, lease renewal and every outcome write
 * are owned by a per-claim token — see lease.ts for the ownership model and
 * processor.ts for the delivery guarantee. A worker that dies mid-delivery
 * stops renewing, its lease lapses, and the next pass reclaims the row.
 */

export interface WorkerRunResult {
  claimed: number;
  sent: number;
  failed: number;
  retrying: number;
  /** Claims this worker lost before it could record an outcome. */
  lostOwnership: number;
}

/** One pass: claim what is due and deliver it under lease (see deliverClaims). */
export async function runWorkerPass(
  workerId: string,
  limit = 25,
  lease: LeaseConfig = leaseConfig()
): Promise<WorkerRunResult> {
  const claims = await claimDueNotifications(workerId, limit, new Date(), lease);
  const tally = await deliverClaims(claims, { lease });
  const result: WorkerRunResult = {
    claimed: claims.length,
    sent: tally.sent,
    failed: tally.failed,
    retrying: tally.retrying,
    lostOwnership: tally.lostOwnership
  };

  return result;
}

export interface WorkerHandle {
  stop(): void;
}

/**
 * Starts a polling loop. Runs in-process next to the API today; the same
 * function is what a standalone worker process calls, so splitting it out later
 * is a deployment change rather than a rewrite.
 */
export function startNotificationWorker(intervalMs = 5_000): WorkerHandle {
  const workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await runWorkerPass(workerId);
      if (result.claimed > 0) {
        console.log(
          "[veyra:worker] id=%s claimed=%d sent=%d retrying=%d failed=%d lostOwnership=%d",
          workerId,
          result.claimed,
          result.sent,
          result.retrying,
          result.failed,
          result.lostOwnership
        );
      }
    } catch (err) {
      // Swallow: the loop must survive to try again.
      console.error("[veyra:worker] pass failed", err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  // Don't hold the process open purely for the worker.
  timer.unref?.();
  void tick();

  console.log("[veyra:worker] started id=%s intervalMs=%d", workerId, intervalMs);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}
