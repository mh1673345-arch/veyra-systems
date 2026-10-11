/**
 * Restores a backup made by backup.mjs. Never runs automatically.
 *
 * Safe default — restore into a brand-new scratch database, leaving every
 * existing database untouched (use this to check a backup is good):
 *
 *   npm run db:restore -- <file.dump> --into veyra_restore_check
 *
 * Overwriting an existing local database is destructive and needs the database
 * name typed twice:
 *
 *   npm run db:restore -- <file.dump> --into veyra_dev --replace --confirm veyra_dev
 *
 * Stop the API first when replacing veyra_dev. Only local databases on the
 * docker-compose container can be targeted; this script has no way to reach a
 * production database.
 */
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";

const CONTAINER = "veyra-postgres";
const NAME = /^veyra_[a-z0-9_]+$/;
const REPLACEABLE = new Set(["veyra_dev", "veyra_test"]);

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

const file = process.argv[2];
const into = arg("--into");
const replace = process.argv.includes("--replace");
const confirm = arg("--confirm");

function fail(message) {
  console.error(`Refusing to restore: ${message}`);
  process.exit(1);
}

if (!file || file.startsWith("--") || !existsSync(file)) fail("pass an existing backup file as the first argument.");
if (!into) fail("pass --into <database>. There is no default target.");
if (!NAME.test(into)) fail(`"${into}" is not a local veyra_* database name.`);

function psql(sql) {
  return spawnSync("docker", ["exec", CONTAINER, "psql", "-U", "veyra", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-Atc", sql], {
    encoding: "utf8"
  });
}

const exists = psql(`SELECT 1 FROM pg_database WHERE datname = '${into}'`);
if (exists.status !== 0) fail(`cannot reach ${CONTAINER}. Start it with: docker compose up -d`);
const targetExists = exists.stdout.trim() === "1";

if (targetExists) {
  if (!replace) {
    fail(`database "${into}" already exists. Restore into a new database, or pass --replace --confirm ${into}.`);
  }
  if (!REPLACEABLE.has(into) && !into.startsWith("veyra_restore")) {
    fail(`"${into}" is not a database this script may replace.`);
  }
  if (confirm !== into) fail(`--replace requires --confirm ${into}.`);

  console.log(`Replacing "${into}": dropping and recreating it (connections are terminated).`);
  const dropped = psql(`DROP DATABASE "${into}" WITH (FORCE)`);
  if (dropped.status !== 0) fail(`could not drop "${into}": ${dropped.stderr.trim()}`);
}

const created = psql(`CREATE DATABASE "${into}" OWNER veyra`);
if (created.status !== 0) fail(`could not create "${into}": ${created.stderr.trim()}`);

const code = await new Promise((resolve) => {
  const child = spawn(
    "docker",
    ["exec", "-i", CONTAINER, "pg_restore", "-U", "veyra", "-d", into, "--no-owner", "--exit-on-error"],
    { stdio: ["pipe", "inherit", "inherit"] }
  );
  child.on("close", resolve);
  createReadStream(file).pipe(child.stdin);
});

if (code !== 0) {
  console.error(`pg_restore failed (exit ${code}). "${into}" may be partially restored.`);
  process.exit(1);
}
console.log(`Restored ${file} into "${into}".`);
