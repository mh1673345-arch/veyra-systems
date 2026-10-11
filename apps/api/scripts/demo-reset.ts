import "dotenv/config";
import { prisma } from "../src/db/client.js";
import { assertDatabaseEnvironment, currentEnvironment } from "../src/config/database.js";
import { configuredDemoBusinessId, DemoResetRefused, resetDemoBusiness } from "../src/services/demo/demoBusiness.js";

/**
 * Resets the demo business's activity so a presentation starts from a known
 * state: conversations, bookings, escalations, notifications, reported issues
 * and knowledge gaps go; configuration, members and the subscription stay.
 *
 *   npm run demo:reset -w apps/api
 *
 * Development only, and deliberately not reachable over HTTP. It refuses
 * unless the environment is non-production, the database is local, and the
 * target is the business named by VEYRA_DEMO_BUSINESS_ID — so it can never
 * touch a pilot customer's data.
 */

async function main() {
  // Same guard the test-database reset uses: never run against the wrong DB.
  assertDatabaseEnvironment();

  if (currentEnvironment() === "production") {
    console.error("Refusing to reset demo data in production.");
    process.exit(1);
  }

  const businessId = configuredDemoBusinessId();
  if (!businessId) {
    console.error(
      "VEYRA_DEMO_BUSINESS_ID is not set, so there is no demo business to reset.\n" +
        "Set it in apps/api/.env to the business you want to use for demos."
    );
    process.exit(1);
  }

  try {
    const result = await resetDemoBusiness({ businessId });
    const summary = Object.entries(result.deleted)
      .filter(([, count]) => count > 0)
      .map(([name, count]) => `${count} ${name}`)
      .join(", ");
    console.log(`Reset "${result.name}" (${result.businessId}).`);
    console.log(summary ? `Cleared: ${summary}.` : "Nothing to clear — it was already empty.");
    console.log("Configuration, members and subscription were left untouched.");
  } catch (err) {
    if (err instanceof DemoResetRefused) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
