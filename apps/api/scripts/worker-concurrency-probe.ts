/**
 * Multi-process notification worker probe against the real test database.
 *
 *   npm run worker:probe -w apps/api
 *   PROBE_WORKERS=4 npm run worker:probe -w apps/api
 *
 * Spawns separate OS processes, each with its own PrismaClient and connections,
 * so claims, lease renewals and finalizations genuinely race inside PostgreSQL.
 *
 * Scenarios:
 *   A. fast delivery race            E. due / not-yet-due retries
 *   B. long delivery kept alive      F. exhausted retries
 *      by the heartbeat              G. rerun over a finished queue
 *   C. worker killed mid-delivery
 *   D. stalled owner trying to finalize after losing its lease
 *
 * Runs only against a local "_test" database (it deletes every notification
 * there first). Prints the measured numbers and exits non-zero on any violation.
 */
import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { checkResetTarget } from "./testDbTarget.mjs";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(apiRoot, ".env") });
dotenv.config({ path: path.join(apiRoot, ".env.test"), override: true });
process.env.NODE_ENV = "test";
process.env.VEYRA_DISABLE_WORKER = "1";

const target = checkResetTarget(process.env.DATABASE_URL);
if (!target.ok) {
  console.error(`Refusing to run the worker probe: ${target.reason}.`);
  process.exit(1);
}
// Narrowed here, at module level, so the functions below see a verified target.
const database = { name: target.name, host: target.host };

const { prisma } = await import("../src/db/client.js");
const { claimDueNotifications } = await import("../src/services/notifications/lease.js");
const { deliverClaims, MAX_ATTEMPTS } = await import(
  "../src/services/notifications/processor.js"
);
const { setEmailProvider } = await import("../src/services/notifications/providers.js");

const BUSINESS_NAME = "Worker Probe Dental";

/** Probe lease: short enough to exercise expiry in seconds, same code path as production. */
const LEASE_MS = 1_500;
const HEARTBEAT_MS = 300;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- child mode

/**
 * Child settings (env):
 *   PROBE_LIMIT      claims per pass
 *   PROBE_SEND_MS    async provider latency
 *   PROBE_STALL_MS   synchronous stall inside the provider (freezes the event
 *                    loop, so the heartbeat cannot run — a hung process)
 *   PROBE_IDLE_MS    exit after this long without claiming anything
 *   PROBE_POLL_MS    wait between empty passes
 */
async function runChild(workerId: string): Promise<void> {
  const limit = Number(process.env.PROBE_LIMIT ?? 10);
  const sendMs = Number(process.env.PROBE_SEND_MS ?? 10);
  const stallMs = Number(process.env.PROBE_STALL_MS ?? 0);
  const idleMs = Number(process.env.PROBE_IDLE_MS ?? 150);
  const pollMs = Number(process.env.PROBE_POLL_MS ?? 50);
  const out = (line: string) => process.stdout.write(`${line}\n`);

  setEmailProvider({
    name: "probe",
    supportsIdempotency: true,
    async send(message) {
      const id = message.idempotencyKey!.split(":")[1];
      out(`SEND_START ${id} ${message.idempotencyKey}`);
      if (stallMs > 0) {
        const until = Date.now() + stallMs;
        while (Date.now() < until) {
          // Busy-wait on purpose: no timers (and so no heartbeat) can fire.
        }
      }
      await sleep(sendMs);
      out(`SEND_DONE ${id}`);
      return { delivered: true, providerName: "probe" };
    }
  });

  let lastClaimAt = Date.now();
  while (Date.now() - lastClaimAt < idleMs) {
    const claims = await claimDueNotifications(workerId, limit);
    if (claims.length === 0) {
      await sleep(pollMs);
      continue;
    }
    for (const claim of claims) out(`CLAIMED ${claim.id}`);
    // The same batch delivery the worker and inline processor use.
    await deliverClaims(claims, { onOutcome: (claim, outcome) => out(`OUTCOME ${claim.id} ${outcome}`) });
    lastClaimAt = Date.now();
  }
  await prisma.$disconnect();
}

// --------------------------------------------------------------- parent mode

interface WorkerReport {
  workerId: string;
  claimed: string[];
  sendStarted: string[];
  sendDone: string[];
  outcomes: Map<string, string[]>;
  exitCode: number | null;
}

interface Spawned {
  report: WorkerReport;
  process: ChildProcess;
  done: Promise<WorkerReport>;
  /** Resolves when the child prints a line starting with the prefix. */
  waitFor(prefix: string): Promise<void>;
}

function spawnWorker(workerId: string, env: Record<string, string> = {}): Spawned {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), "--child", workerId],
    {
      cwd: apiRoot,
      env: {
        ...process.env,
        VEYRA_NOTIFICATION_LEASE_MS: String(LEASE_MS),
        VEYRA_NOTIFICATION_HEARTBEAT_MS: String(HEARTBEAT_MS),
        ...env
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  const report: WorkerReport = {
    workerId,
    claimed: [],
    sendStarted: [],
    sendDone: [],
    outcomes: new Map(),
    exitCode: null
  };
  const waiters: { prefix: string; resolve: () => void }[] = [];
  let buffer = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const [kind, id, value] = line.trim().split(" ");
      if (kind === "CLAIMED") report.claimed.push(id);
      if (kind === "SEND_START") report.sendStarted.push(id);
      if (kind === "SEND_DONE") report.sendDone.push(id);
      if (kind === "OUTCOME") report.outcomes.set(value, [...(report.outcomes.get(value) ?? []), id]);
      for (const waiter of waiters.filter((w) => line.startsWith(w.prefix))) waiter.resolve();
    }
  });
  // Lease-loss warnings are expected in some scenarios; keep stderr quiet
  // unless something unexpected is printed.
  child.stderr!.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (!/lease lost|ownership lost/.test(text)) process.stderr.write(text);
  });
  const done = new Promise<WorkerReport>((resolve) => {
    child.on("exit", (code) => {
      report.exitCode = code;
      resolve(report);
    });
  });
  return {
    report,
    process: child,
    done,
    waitFor: (prefix) => new Promise((resolve) => waiters.push({ prefix, resolve }))
  };
}

const violations: string[] = [];
function check(condition: boolean, message: string): void {
  console.log(`  ${condition ? "PASS" : "FAIL"} ${message}`);
  if (!condition) violations.push(message);
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  return [...dup];
}

function summarize(label: string, reports: WorkerReport[], elapsedMs: number) {
  const all = {
    claimed: reports.flatMap((r) => r.claimed),
    sendStarted: reports.flatMap((r) => r.sendStarted),
    sendDone: reports.flatMap((r) => r.sendDone),
    sent: reports.flatMap((r) => r.outcomes.get("sent") ?? []),
    lost: reports.flatMap((r) => r.outcomes.get("lost_ownership") ?? [])
  };
  console.log(`  ${reports.length} worker process(es), ${elapsedMs}ms`);
  for (const r of reports) {
    console.log(
      `    ${r.workerId}: claimed=${r.claimed.length} sendStarted=${r.sendStarted.length} ` +
        `emailSends=${r.sendDone.length} lostOwnership=${r.outcomes.get("lost_ownership")?.length ?? 0} exit=${r.exitCode}`
    );
  }
  console.log(
    `  ${label} totals: claimed=${all.claimed.length} emailSends=${all.sendDone.length} ` +
      `duplicateEmailSends=${duplicates(all.sendDone).length} duplicateFinalizations=${duplicates(all.sent).length} ` +
      `lostOwnership=${all.lost.length}`
  );
  return all;
}

async function race(label: string, workers: number, env: Record<string, string> = {}) {
  const started = Date.now();
  const reports = await Promise.all(
    Array.from({ length: workers }, (_, i) => spawnWorker(`${label}-w${i + 1}`, env).done)
  );
  return { reports, totals: summarize(label, reports, Date.now() - started) };
}

async function seedNotifications(
  businessId: string,
  userId: string,
  count: number,
  label: string,
  extra: Record<string, unknown> = {},
  channels: string[] = ["email", "in_app"]
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const event = await prisma.domainEvent.create({
      data: { businessId, type: "booking_request.created", entityType: "booking", entityId: `${label}-${i}` }
    });
    for (const channel of channels) {
      const n = await prisma.notification.create({
        data: { businessId, userId, eventId: event.id, channel, subject: `${label} ${i}`, ...extra }
      });
      ids.push(n.id);
    }
  }
  return ids;
}

const rowsOf = (ids: string[]) => prisma.notification.findMany({ where: { id: { in: ids } } });
const clearQueue = () => prisma.notification.deleteMany({});

async function runParent(): Promise<void> {
  const workers = Number(process.env.PROBE_WORKERS ?? 6);
  const events = Number(process.env.PROBE_EVENTS ?? 150);
  console.log(
    `Worker probe on PostgreSQL database "${database.name}" (${database.host}), ${workers} worker processes, ` +
      `lease=${LEASE_MS}ms heartbeat=${HEARTBEAT_MS}ms MAX_ATTEMPTS=${MAX_ATTEMPTS}`
  );

  await clearQueue();
  await prisma.domainEvent.deleteMany({ where: { business: { name: BUSINESS_NAME } } });
  await prisma.user.deleteMany({ where: { email: "probe@worker-probe.test" } });
  await prisma.business.deleteMany({ where: { name: BUSINESS_NAME } });
  const business = await prisma.business.create({ data: { name: BUSINESS_NAME, capEmailNotifications: true } });
  const user = await prisma.user.create({
    data: { email: "probe@worker-probe.test", name: "Probe", passwordHash: "x" }
  });

  // A. Fast delivery race ------------------------------------------------------
  console.log(`\n[A] Fast delivery: ${events * 2} due notifications`);
  const aIds = await seedNotifications(business.id, user.id, events, "fast");
  const a = await race("A", workers);
  const aRows = await rowsOf(aIds);
  check(a.reports.every((r) => r.exitCode === 0), "every worker exited cleanly");
  check(a.reports.filter((r) => r.claimed.length > 0).length >= 2, "work was shared across processes");
  check(duplicates(a.totals.claimed).length === 0, `no row claimed twice (${a.totals.claimed.length} claims)`);
  check(duplicates(a.totals.sendDone).length === 0, `no duplicate deliveries (${a.totals.sendDone.length})`);
  check(a.totals.lost.length === 0, "no lost ownership");
  check(aRows.every((r) => r.status === "sent" && r.attemptCount === 1), "every row sent once, attemptCount=1");
  check(aRows.every((r) => r.claimToken === null && r.leaseExpiresAt === null), "no claim fields left behind");

  // B. Long delivery with heartbeat ------------------------------------------
  await clearQueue();
  const sendMs = LEASE_MS * 3;
  console.log(`\n[B] Long delivery: each send takes ${sendMs}ms (3x the lease); idle workers keep polling`);
  const bIds = await seedNotifications(business.id, user.id, 4, "long", {}, ["email"]);
  const b = await race("B", 4, {
    PROBE_LIMIT: "1",
    PROBE_SEND_MS: String(sendMs),
    PROBE_IDLE_MS: String(sendMs + 1_000),
    PROBE_POLL_MS: "100"
  });
  const bRows = await rowsOf(bIds);
  check(duplicates(b.totals.claimed).length === 0, `no row claimed twice during long sends (${b.totals.claimed.length} claims)`);
  check(duplicates(b.totals.sendStarted).length === 0, "no send ever started twice");
  check(b.totals.sendDone.length === bIds.length, `delivered once each (${b.totals.sendDone.length}/${bIds.length})`);
  check(b.totals.lost.length === 0, "no lost ownership — heartbeats kept every lease");
  check(bRows.every((r) => r.status === "sent" && r.attemptCount === 1), "every row sent, attemptCount=1");

  // C. Worker killed mid-delivery --------------------------------------------
  await clearQueue();
  console.log(`\n[C] Crash: a worker claims 5 rows, starts a send, and is killed`);
  const cIds = await seedNotifications(business.id, user.id, 5, "crash", {}, ["email"]);
  // A longer lease for the victim, so the few seconds it takes to start the
  // "early" worker processes cannot themselves outlast it.
  const victimLeaseMs = 12_000;
  const victim = spawnWorker("C-victim", {
    PROBE_LIMIT: "5",
    PROBE_SEND_MS: "600000",
    VEYRA_NOTIFICATION_LEASE_MS: String(victimLeaseMs),
    VEYRA_NOTIFICATION_HEARTBEAT_MS: String(victimLeaseMs / 4)
  });
  await victim.waitFor("SEND_START");
  const killedAt = Date.now();
  victim.process.kill("SIGKILL");
  await victim.done;
  console.log(`    C-victim: claimed=${victim.report.claimed.length} sendStarted=${victim.report.sendStarted.length} killed`);

  const leases = await rowsOf(cIds);
  const firstExpiry = Math.min(...leases.map((r) => r.leaseExpiresAt?.getTime() ?? 0));
  const early = await race("C-early", 2, { PROBE_IDLE_MS: "1000" });
  check(Date.now() < firstExpiry, `early workers finished ${firstExpiry - Date.now()}ms before the dead worker's first lease expiry`);
  check(early.totals.claimed.length === 0, "before the lease expires, nobody can reclaim the dead worker's rows");

  const lastExpiry = Math.max(...leases.map((r) => r.leaseExpiresAt?.getTime() ?? 0));
  await sleep(Math.max(0, lastExpiry + 200 - Date.now()));
  console.log(`  dead worker's leases expired ${Date.now() - killedAt}ms after the kill`);
  const recovery = await race("C-recovery", workers);
  const cRows = await rowsOf(cIds);
  check(victim.report.claimed.length === 5, "victim held 5 claims when killed");
  check(recovery.totals.claimed.length === 5, `after expiry, all 5 reclaimed (${recovery.totals.claimed.length})`);
  check(duplicates(recovery.totals.claimed).length === 0, "reclaimed exactly once each");
  check(cRows.every((r) => r.status === "sent" && r.attemptCount === 1), "all recovered rows sent, attemptCount=1");
  const crashResent = victim.report.sendStarted.filter((id) => recovery.totals.sendDone.includes(id));
  console.log(
    `  note: ${crashResent.length} row(s) had a send in flight when the victim died and were re-sent by recovery ` +
      "with the same idempotency key (documented at-least-once edge)"
  );

  // D. Stalled owner tries to finalize --------------------------------------
  await clearQueue();
  const stallMs = LEASE_MS * 3;
  console.log(`\n[D] Stale owner: worker A freezes ${stallMs}ms mid-send (no heartbeat possible); B polls`);
  const [dId] = await seedNotifications(business.id, user.id, 1, "stale", {}, ["email"]);
  const dStarted = Date.now();
  const stalled = spawnWorker("D-stalled", { PROBE_LIMIT: "1", PROBE_STALL_MS: String(stallMs) });
  await stalled.waitFor("CLAIMED");
  const rescuer = spawnWorker("D-rescuer", { PROBE_IDLE_MS: String(stallMs + 2_000), PROBE_POLL_MS: "100" });
  const [dStalled, dRescuer] = await Promise.all([stalled.done, rescuer.done]);
  const d = summarize("D", [dStalled, dRescuer], Date.now() - dStarted);
  const [dRow] = await rowsOf([dId]);
  check(dRescuer.claimed.length === 1, "rescuer reclaimed the row once the stalled lease expired");
  check((dStalled.outcomes.get("lost_ownership") ?? []).length === 1, "stalled owner's finalization was rejected (lost_ownership)");
  check((dStalled.outcomes.get("sent") ?? []).length === 0, "stalled owner did not report the notification as sent");
  check((dRescuer.outcomes.get("sent") ?? []).length === 1, "rescuer finalized it as sent");
  check(dRow.status === "sent" && dRow.attemptCount === 1, `row recorded once (status=${dRow.status}, attemptCount=${dRow.attemptCount})`);
  check(dRow.claimToken === null, "no claim left behind");
  console.log(
    `  note: external sends=${d.sendDone.length} — the stalled owner's provider call was already in flight ` +
      "when it froze; both carried the same idempotency key"
  );

  // E + F. Retries and exhaustion -------------------------------------------
  await clearQueue();
  console.log(`\n[E/F] Retries: due, not yet due, exhausted, stale lease, live lease`);
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
  const due = await seedNotifications(business.id, user.id, 10, "due", { attemptCount: 1, nextAttemptAt: minutesAgo(1) });
  const notYetDue = await seedNotifications(business.id, user.id, 10, "backoff", {
    attemptCount: 1,
    nextAttemptAt: new Date(Date.now() + 60 * 60_000)
  });
  const exhausted = await seedNotifications(business.id, user.id, 10, "exhausted", {
    attemptCount: MAX_ATTEMPTS,
    nextAttemptAt: minutesAgo(1)
  });
  const staleLease = await seedNotifications(business.id, user.id, 5, "stale-lease", {
    claimToken: "dead-token",
    claimedBy: "dead-worker",
    claimedAt: minutesAgo(10),
    leaseExpiresAt: minutesAgo(8)
  });
  const liveLease = await seedNotifications(business.id, user.id, 5, "live-lease", {
    claimToken: "live-token",
    claimedBy: "live-worker",
    claimedAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + 60 * 60_000)
  });
  const ef = await race("E/F", workers);
  const claimedSet = new Set(ef.totals.claimed);
  const taken = (ids: string[]) => ids.filter((id) => claimedSet.has(id)).length;
  check(taken(due) === due.length, `due retries claimed: ${taken(due)}/${due.length}`);
  check(taken(notYetDue) === 0, `future nextAttemptAt not claimed: ${taken(notYetDue)}`);
  check(taken(exhausted) === 0, `attemptCount=MAX_ATTEMPTS not claimed: ${taken(exhausted)}`);
  check(taken(staleLease) === staleLease.length, `expired leases reclaimed: ${taken(staleLease)}/${staleLease.length}`);
  check(taken(liveLease) === 0, `live leases untouched: ${taken(liveLease)}`);
  check(duplicates(ef.totals.sendDone).length === 0, `no duplicate deliveries (${ef.totals.sendDone.length})`);
  const dueRows = await rowsOf(due);
  check(dueRows.every((r) => r.status === "sent" && r.attemptCount === 2), "retried rows sent on attempt 2");
  const liveRows = await rowsOf(liveLease);
  check(liveRows.every((r) => r.claimToken === "live-token" && r.status === "pending"), "live-leased rows still owned by their token");

  // G. Rerun over a finished queue ------------------------------------------
  console.log(`\n[G] Rerun: ${workers} workers over the finished queue`);
  const sentBefore = await prisma.notification.count({ where: { status: "sent" } });
  const g = await race("G", workers);
  const sentAfter = await prisma.notification.count({ where: { status: "sent" } });
  check(g.totals.claimed.length === 0, "nothing already handled was claimed again");
  check(sentAfter === sentBefore, `sent count unchanged (${sentBefore} -> ${sentAfter})`);

  await clearQueue();
  await prisma.domainEvent.deleteMany({ where: { businessId: business.id } });
  await prisma.user.delete({ where: { id: user.id } });
  await prisma.business.delete({ where: { id: business.id } });
  await prisma.$disconnect();

  console.log(
    violations.length === 0
      ? "\nWorker probe: all checks passed."
      : `\nWorker probe: ${violations.length} violation(s):\n- ${violations.join("\n- ")}`
  );
  process.exitCode = violations.length === 0 ? 0 : 1;
}

const childIndex = process.argv.indexOf("--child");
if (childIndex !== -1) {
  await runChild(process.argv[childIndex + 1]);
} else {
  await runParent();
}
