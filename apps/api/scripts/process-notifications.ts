import "dotenv/config";
import { assertDatabaseEnvironment } from "../src/config/database.js";
import { prisma } from "../src/db/client.js";
import { processPendingNotifications } from "../src/services/notifications/processor.js";

/**
 * Manual/dev processor. Claims through the same leases as the durable worker,
 * so it is safe to run while the API (and its in-process worker) is running.
 */
async function main() {
  assertDatabaseEnvironment();

  const result = await processPendingNotifications(200);
  console.log(
    `Processed ${result.attempted} notification(s): ${result.sent} sent, ` +
      `${result.retrying} awaiting retry, ${result.failed} failed permanently, ` +
      `${result.lostOwnership} skipped (claimed by another worker first).`
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
