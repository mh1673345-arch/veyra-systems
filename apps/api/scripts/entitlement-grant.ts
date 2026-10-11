import "dotenv/config";

/**
 * Switches a rollout entitlement on (or off) for one business.
 *
 *   npm run entitlement:grant -w apps/api -- "Colour pix" sms "pilot with the owner"
 *   npm run entitlement:grant -w apps/api -- "Colour pix" whatsapp "pilot" --expires 2026-12-31
 *   npm run entitlement:grant -w apps/api -- "Colour pix" sms --revoke
 *
 * There is no HTTP route for this on purpose: nobody signed into the Console
 * can switch on a channel their plan does not include. Only entitlements on
 * ROLLOUT_ENTITLEMENTS may be named — a paid plan feature is refused here,
 * not silently granted — and every grant records who asked for it and why.
 */

const { prisma } = await import("../src/db/client.js");
const { ROLLOUT_ENTITLEMENTS, isRolloutEntitlement } = await import("@veyra/shared");
const { accessFor } = await import("../src/services/access/accessService.js");

async function main() {
  const args = process.argv.slice(2);
  const revoke = args.includes("--revoke");
  const expiresIndex = args.indexOf("--expires");
  const expiresAt = expiresIndex !== -1 ? new Date(args[expiresIndex + 1]) : null;
  const positional = args.filter((arg, index) => {
    if (arg.startsWith("--")) return false;
    if (expiresIndex !== -1 && index === expiresIndex + 1) return false;
    return true;
  });
  const [businessArg, entitlementArg, reasonArg] = positional;

  if (!businessArg || !entitlementArg) {
    console.error(
      'Usage: entitlement:grant -- "<business name or id>" <entitlement> "<reason>" [--expires YYYY-MM-DD] [--revoke]\n' +
        `Rollout entitlements: ${ROLLOUT_ENTITLEMENTS.join(", ")}`
    );
    process.exit(1);
  }

  if (!isRolloutEntitlement(entitlementArg as never)) {
    console.error(
      `"${entitlementArg}" is not a rollout entitlement. Only ${ROLLOUT_ENTITLEMENTS.join(", ")} can be granted ` +
        "this way; anything else belongs to a plan and must be changed through the subscription."
    );
    process.exit(1);
  }

  const business =
    (await prisma.business.findUnique({ where: { id: businessArg } })) ??
    (await prisma.business.findFirst({ where: { name: businessArg } }));
  if (!business) {
    console.error(`No business matches "${businessArg}".`);
    process.exit(1);
  }

  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    console.error("--expires needs a date Veyra can read, for example 2026-12-31.");
    process.exit(1);
  }

  if (revoke) {
    await prisma.entitlementGrant.updateMany({
      where: { businessId: business.id, entitlement: entitlementArg, revokedAt: null },
      data: { revokedAt: new Date() }
    });
    console.log(`Revoked "${entitlementArg}" for ${business.name}.`);
  } else {
    if (!reasonArg) {
      console.error("A reason is required: this is a deliberate act and it gets asked about later.");
      process.exit(1);
    }
    await prisma.entitlementGrant.upsert({
      where: { businessId_entitlement: { businessId: business.id, entitlement: entitlementArg } },
      create: {
        businessId: business.id,
        entitlement: entitlementArg,
        reason: reasonArg,
        expiresAt,
        grantedByUserId: null
      },
      update: { reason: reasonArg, expiresAt, revokedAt: null }
    });
    console.log(
      `Granted "${entitlementArg}" to ${business.name}${expiresAt ? ` until ${expiresAt.toISOString().slice(0, 10)}` : ""}.`
    );
  }

  const access = await accessFor(business.id);
  console.log(`Effective entitlements now include ${entitlementArg}: ${access.entitlements.has(entitlementArg as never)}`);
  console.log(`(plan ${access.plan ?? "none"}, status ${access.status})`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
