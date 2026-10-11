import "dotenv/config";
import { currentEnvironment } from "../src/config/database.js";

/**
 * Connects a business to the **fake** calendar provider for local demos.
 *
 *   npm run calendar:dev-connect -w apps/api -- "SmileCare Dental"
 *
 * This is not Google. It exists so the live-calendar product flow can be
 * exercised end to end without OAuth credentials, and it refuses to run outside
 * development. The Console shows the provider as "fake", so nobody can mistake
 * a demo connection for a real one.
 */

if (currentEnvironment() === "production") {
  console.error("Refusing to create a fake calendar connection in production.");
  process.exit(1);
}

const { prisma } = await import("../src/db/client.js");
const { saveConnection, selectCalendar, calendarStatus } = await import("../src/services/calendar/service.js");
const { encryptionConfigured } = await import("../src/services/crypto/secretBox.js");

async function main() {
  if (!encryptionConfigured()) {
    console.error(
      "VEYRA_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32` and put it in apps/api/.env."
    );
    process.exit(1);
  }

  const name = process.argv[2] ?? "SmileCare Dental";
  const business = await prisma.business.findFirst({ where: { name } });
  if (!business) {
    console.error(`No business named "${name}". Run \`npm run db:seed -w apps/api\` first.`);
    process.exit(1);
  }
  if (!business.capCalendarBooking) {
    console.error(
      `"${business.name}" does not have the calendar_booking capability, so a connection would stay inactive.`
    );
    process.exit(1);
  }

  const owner = await prisma.businessMembership.findFirst({
    where: { businessId: business.id, role: "OWNER" }
  });

  await saveConnection({
    businessId: business.id,
    provider: "fake",
    userId: owner?.userId ?? "dev-script",
    credentials: {
      accessToken: "dev-fake-access-token",
      refreshToken: "dev-fake-refresh-token",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    }
  });
  await selectCalendar(business.id, "primary");

  const status = await calendarStatus(business.id);
  console.log(
    `Connected "${business.name}" to the FAKE calendar provider ` +
      `(calendar=${status.connection?.selectedCalendarName}, timezone=${status.timezone}, live=${status.live}).`
  );
  console.log("This is a local demo connection, not Google Calendar.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
