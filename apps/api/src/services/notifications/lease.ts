import { randomUUID } from "node:crypto";
import { prisma } from "../../db/client.js";

/**
 * Claim leases for notification delivery.
 *
 * Ownership model
 * ---------------
 * A worker claims a row by writing a fresh random `claimToken` and a
 * `leaseExpiresAt` in one conditional UPDATE. From then on, *every* write that
 * worker makes — heartbeat renewal, success, retry scheduling, permanent
 * failure, release — is `WHERE id = ? AND claimToken = ?`. If another worker
 * has since taken the row, the token no longer matches, the write affects zero
 * rows, and the stale worker learns it has lost ownership instead of silently
 * overwriting the new owner's state.
 *
 * `claimedBy` (a worker label) and `claimedAt` are kept for observability only;
 * they are never used to decide ownership.
 *
 * Liveness
 * --------
 * While a delivery runs, a heartbeat pushes `leaseExpiresAt` forward every
 * `heartbeatMs`, well inside `leaseMs`. A row is reclaimable only once its
 * lease has genuinely expired, i.e. its owner stopped renewing (crashed, hung,
 * or lost its database connection for longer than the lease).
 *
 * Concurrency: on PostgreSQL, two workers racing to claim or renew the same
 * row serialise on its row lock, and the second UPDATE re-evaluates its WHERE
 * clause against the committed row — so exactly one of them matches.
 *
 * Clocks: lease times come from the worker's clock. Hosts running workers must
 * keep their clocks synchronised (NTP); skew is tolerated as long as it stays
 * well below `leaseMs - heartbeatMs`.
 */

/** Delivery attempts before a notification is abandoned as failed. */
export const MAX_ATTEMPTS = 5;

export interface LeaseConfig {
  /** How long a claim is honoured without renewal. */
  leaseMs: number;
  /** How often an active delivery renews its lease. Must be <= leaseMs / 2. */
  heartbeatMs: number;
}

const DEFAULT_LEASE_MS = 2 * 60 * 1000;

export class LeaseConfigError extends Error {}

/**
 * Lease timing, from VEYRA_NOTIFICATION_LEASE_MS / VEYRA_NOTIFICATION_HEARTBEAT_MS
 * or the defaults (2 minute lease, renewed every 30 seconds — one small write
 * per active delivery, not per queued row).
 */
export function leaseConfig(env: NodeJS.ProcessEnv = process.env): LeaseConfig {
  const leaseMs = parsePositive(env.VEYRA_NOTIFICATION_LEASE_MS, DEFAULT_LEASE_MS, "VEYRA_NOTIFICATION_LEASE_MS");
  const heartbeatMs = parsePositive(
    env.VEYRA_NOTIFICATION_HEARTBEAT_MS,
    Math.floor(leaseMs / 4),
    "VEYRA_NOTIFICATION_HEARTBEAT_MS"
  );
  return validateLeaseConfig({ leaseMs, heartbeatMs });
}

export function validateLeaseConfig(config: LeaseConfig): LeaseConfig {
  if (config.heartbeatMs * 2 > config.leaseMs) {
    throw new LeaseConfigError(
      `Notification heartbeat (${config.heartbeatMs}ms) must be at most half the lease (${config.leaseMs}ms), ` +
        "so a single delayed renewal cannot let the lease lapse."
    );
  }
  return config;
}

function parsePositive(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new LeaseConfigError(`${name} must be a positive integer number of milliseconds.`);
  }
  return value;
}

/** Proof of ownership for one claimed notification. */
export interface Claim {
  id: string;
  token: string;
  workerId: string;
}

/** Claim fields cleared whenever a delivery settles or is released. */
export const CLEARED_CLAIM = {
  claimedAt: null,
  claimedBy: null,
  claimToken: null,
  leaseExpiresAt: null
} as const;

function dueAndUnleased(now: Date) {
  return {
    status: "pending",
    attemptCount: { lt: MAX_ATTEMPTS },
    OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    AND: [{ OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }] }]
  };
}

/**
 * Atomically claims up to `limit` due notifications whose lease is free or has
 * expired. Returns only the claims this worker actually won, each with its own
 * ownership token.
 */
export async function claimDueNotifications(
  workerId: string,
  limit: number,
  now = new Date(),
  config: LeaseConfig = leaseConfig()
): Promise<Claim[]> {
  const candidates = await prisma.notification.findMany({
    where: dueAndUnleased(now),
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true }
  });

  const claims: Claim[] = [];
  for (const { id } of candidates) {
    const token = randomUUID();
    // The full eligibility condition is repeated in the UPDATE, so a row another
    // worker claimed (or renewed) since the read above matches zero rows.
    const result = await prisma.notification.updateMany({
      where: { id, ...dueAndUnleased(now) },
      data: {
        claimToken: token,
        claimedBy: workerId,
        claimedAt: now,
        leaseExpiresAt: new Date(now.getTime() + config.leaseMs)
      }
    });
    if (result.count === 1) claims.push({ id, token, workerId });
  }
  return claims;
}

/**
 * Extends the lease if, and only if, this claim still owns the row.
 * Returns false when ownership has been lost.
 */
export async function renewLease(
  claim: Claim,
  now = new Date(),
  config: LeaseConfig = leaseConfig()
): Promise<boolean> {
  const result = await prisma.notification.updateMany({
    where: { id: claim.id, claimToken: claim.token, status: "pending" },
    data: { leaseExpiresAt: new Date(now.getTime() + config.leaseMs) }
  });
  return result.count === 1;
}

/**
 * Renews several claims in one conditional statement — used for claims a
 * worker holds in its batch but has not started delivering yet. Each row is
 * matched only with its own token. Returns how many are still owned.
 */
export async function renewLeases(
  claims: Claim[],
  now = new Date(),
  config: LeaseConfig = leaseConfig()
): Promise<number> {
  if (claims.length === 0) return 0;
  const result = await prisma.notification.updateMany({
    where: {
      status: "pending",
      OR: claims.map((claim) => ({ id: claim.id, claimToken: claim.token }))
    },
    data: { leaseExpiresAt: new Date(now.getTime() + config.leaseMs) }
  });
  return result.count;
}

/** Gives a claim back without an attempt being recorded. Owner-only. */
export async function releaseClaim(claim: Claim): Promise<boolean> {
  const result = await prisma.notification.updateMany({
    where: { id: claim.id, claimToken: claim.token, status: "pending" },
    data: CLEARED_CLAIM
  });
  return result.count === 1;
}

export interface LeaseHeartbeat {
  /** Stops renewing and waits for any renewal already in flight. */
  stop(): Promise<void>;
  /** True once a renewal found the claim owned by someone else. */
  readonly lost: boolean;
  readonly renewals: number;
}

/**
 * Renews `claim` every `config.heartbeatMs` until stopped or until ownership is
 * lost. Timers are unref'd, so a crashing or exiting process simply stops
 * renewing and the lease lapses on its own. A renewal that *errors* (e.g. a
 * transient database failure) is not treated as lost ownership; the next beat
 * tries again, and if the lease lapses meanwhile the conditional finalization
 * will say so.
 */
export function startLeaseHeartbeat(
  claim: Claim,
  config: LeaseConfig = leaseConfig(),
  onLost?: () => void
): LeaseHeartbeat {
  return startHeartbeat(
    async () => {
      const owned = await renewLease(claim, new Date(), config);
      if (!owned) {
        console.warn(
          "[veyra:worker] lease lost id=%s worker=%s — another worker owns this notification",
          claim.id,
          claim.workerId
        );
      }
      return owned;
    },
    config,
    onLost
  );
}

/**
 * Keeps the leases of claims that are waiting their turn in a worker's batch
 * alive, so a slow delivery at the front of the batch cannot let the claims
 * behind it lapse. `waiting()` is read on every beat, so claims drop out as
 * their delivery starts (and gets its own heartbeat). A waiting claim that was
 * lost anyway is caught by the ownership check before its delivery starts.
 */
export function startBatchHeartbeat(
  waiting: () => Claim[],
  config: LeaseConfig = leaseConfig()
): LeaseHeartbeat {
  return startHeartbeat(
    async () => {
      await renewLeases(waiting(), new Date(), config);
      return true;
    },
    config
  );
}

/** Shared timer loop: `renew` resolves false when ownership is gone. */
function startHeartbeat(
  renew: () => Promise<boolean>,
  config: LeaseConfig,
  onLost?: () => void
): LeaseHeartbeat {
  let stopped = false;
  let lost = false;
  let renewals = 0;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = beat();
    }, config.heartbeatMs);
    timer.unref?.();
  };

  const beat = async () => {
    if (stopped) return;
    try {
      const owned = await renew();
      if (stopped) return;
      if (owned) {
        renewals += 1;
        schedule();
      } else {
        lost = true;
        stopped = true;
        onLost?.();
      }
    } catch (err) {
      console.error("[veyra:worker] lease renewal failed", err);
      schedule();
    }
  };

  schedule();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
    get lost() {
      return lost;
    },
    get renewals() {
      return renewals;
    }
  };
}
