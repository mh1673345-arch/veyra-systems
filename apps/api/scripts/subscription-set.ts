import "dotenv/config";

/**
 * Admin-only plan change, until a billing provider exists.
 *
 *   npm run subscription:set -w apps/api -- "SmileCare Dental" PRO
 *   npm run subscription:set -w apps/api -- "SmileCare Dental" STARTER active --actor owner@smilecare.local
 *   npm run subscription:set -w apps/api -- "SmileCare Dental" PRO past_due
 *
 * There is no HTTP route for this on purpose: nobody signed into the Console
 * can raise their own plan. The change is effective immediately and audited
 * (SubscriptionEvent, actorType "admin_script"). A downgrade deletes nothing —
 * calendar connections and existing bookings stay exactly as they are.
 */

const { prisma } = await import("../src/db/client.js");
const { changePlan, accessFor } = await import("../src/services/access/accessService.js");
const { isPlanCode, PLAN_CATALOG } = await import("@veyra/shared");

const STATUSES = ["trialing", "active", "past_due", "cancelled", "expired"] as const;
type Status = (typeof STATUSES)[number];

async function main() {
  const [businessArg, planArg, maybeStatus] = process.argv.slice(2);
  const actorIndex = process.argv.indexOf("--actor");
  const actorEmail = actorIndex !== -1 ? process.argv[actorIndex + 1] : null;

  if (!businessArg || !planArg || !isPlanCode(planArg.toUpperCase())) {
    console.error('Usage: subscription:set -- "<business name or id>" <STARTER|PRO|MAX> [status] [--actor email]');
    process.exit(1);
  }
  const plan = planArg.toUpperCase() as "STARTER" | "PRO" | "MAX";

  const status =
    maybeStatus && !maybeStatus.startsWith("--") ? (maybeStatus as Status) : undefined;
  if (status && !STATUSES.includes(status)) {
    console.error(`Unknown status "${status}". Use one of: ${STATUSES.join(", ")}.`);
    process.exit(1);
  }

  const business =
    (await prisma.business.findUnique({ where: { id: businessArg } })) ??
    (await prisma.business.findFirst({ where: { name: businessArg } }));
  if (!business) {
    console.error(`No business "${businessArg}".`);
    process.exit(1);
  }

  const actor = actorEmail
    ? await prisma.user.findUnique({ where: { email: actorEmail.toLowerCase() } })
    : null;
  if (actorEmail && !actor) {
    console.error(`No user "${actorEmail}" to record as the actor.`);
    process.exit(1);
  }

  const before = await accessFor(business.id);
  await changePlan({
    businessId: business.id,
    plan,
    status,
    actorType: "admin_script",
    actorUserId: actor?.id ?? null,
    reason: "Plan changed with scripts/subscription-set.ts"
  });
  const after = await accessFor(business.id);

  console.log(
    `${business.name}: ${before.plan ?? "none"} (${before.status}) -> ` +
      `${PLAN_CATALOG[plan].name} — ${PLAN_CATALOG[plan].tagline} (${after.status})` +
      (after.degraded ? " [degraded: paid features off]" : "")
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
