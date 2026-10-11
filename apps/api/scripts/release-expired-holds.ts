import "dotenv/config";
import { prisma } from "../src/db/client.js";
import { assertDatabaseEnvironment } from "../src/config/database.js";
import { releaseExpiredHolds } from "../src/services/calendar/holds.js";

/**
 * Releases held slots whose confirmation window has passed.
 *
 *   npm run holds:release -w apps/api
 *
 * The application already sweeps lazily whenever holds are read or changed, so
 * this exists for the case where a business went quiet with holds outstanding
 * and nobody has looked since. Nothing is deleted: each hold becomes `expired`
 * with a status-history entry saying why.
 */
async function main() {
  assertDatabaseEnvironment();
  const { released, appointments } = await releaseExpiredHolds();
  if (released === 0) {
    console.log("No expired holds to release.");
  } else {
    console.log(`Released ${released} expired hold${released === 1 ? "" : "s"}:`);
    for (const appointment of appointments) {
      console.log(`  ${appointment.id}  business=${appointment.businessId}  ${appointment.requestedTime}`);
    }
  }
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
