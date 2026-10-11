/**
 * Resets the *test* database only, by replaying the real migrations.
 *
 * Prisma's CLI reads apps/api/.env, which points at the development database,
 * so running `prisma migrate reset` directly would wipe dev data. This loads
 * .env.test over the top and refuses to run unless the resulting DATABASE_URL
 * names a local "_test" PostgreSQL database (see scripts/testDbTarget.mjs).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";
import { checkResetTarget } from "./testDbTarget.mjs";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testEnvPath = path.join(apiRoot, ".env.test");

if (!existsSync(testEnvPath)) {
  console.error(
    "Refusing to reset: apps/api/.env.test is missing. Copy apps/api/.env.test.example and " +
      "set the local Postgres password."
  );
  process.exit(1);
}

dotenv.config({ path: path.join(apiRoot, ".env") });
dotenv.config({ path: testEnvPath, override: true });

const target = checkResetTarget(process.env.DATABASE_URL);
if (!target.ok) {
  // Deliberately does not print the URL: it contains the password.
  console.error(`Refusing to reset: ${target.reason}. Check apps/api/.env.test.`);
  process.exit(1);
}

console.log(`Resetting test database "${target.name}" on ${target.host} from migrations.`);

const result = spawnSync(
  "npx",
  ["prisma", "migrate", "reset", "--force", "--skip-seed", "--skip-generate"],
  {
    cwd: apiRoot,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, NODE_ENV: "test" }
  }
);

process.exit(result.status ?? 1);
