/**
 * Backs up a local Veyra database from the docker-compose Postgres container.
 *
 *   npm run db:backup                 # veyra_dev
 *   npm run db:backup -- veyra_test
 *
 * Writes a custom-format pg_dump to infra/postgres/backups/ (gitignored) and
 * then proves the file is a readable archive with `pg_restore --list`.
 * pg_dump runs inside the container over its local socket, so no password is
 * read, passed on a command line, or printed.
 *
 * Local development only. Production backups belong to the managed database
 * provider (point-in-time recovery), not to this script.
 */
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, createWriteStream, mkdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTAINER = "veyra-postgres";
const ALLOWED = new Set(["veyra_dev", "veyra_test"]);

const here = path.dirname(fileURLToPath(import.meta.url));
const backupsDir = path.join(here, "backups");

const database = process.argv[2] ?? "veyra_dev";
if (!ALLOWED.has(database)) {
  console.error(`Refusing to back up "${database}": only ${[...ALLOWED].join(", ")} are local databases.`);
  process.exit(1);
}

const running = spawnSync("docker", ["inspect", "-f", "{{.State.Health.Status}}", CONTAINER], {
  encoding: "utf8"
});
if (running.status !== 0 || running.stdout.trim() !== "healthy") {
  console.error(`Container ${CONTAINER} is not running and healthy. Start it with: docker compose up -d`);
  process.exit(1);
}

mkdirSync(backupsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = path.join(backupsDir, `${database}-${stamp}.dump`);

function pipeToFile(args, destination) {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "inherit"] });
    const out = createWriteStream(destination);
    child.stdout.pipe(out);
    child.on("close", (code) => out.end(() => resolve(code)));
  });
}

const dumpCode = await pipeToFile(
  ["exec", CONTAINER, "pg_dump", "-U", "veyra", "-d", database, "--format=custom", "--no-owner"],
  file
);
if (dumpCode !== 0) {
  try {
    unlinkSync(file);
  } catch {}
  console.error(`pg_dump failed (exit ${dumpCode}); no backup written.`);
  process.exit(1);
}

// Verify: the archive must be readable by pg_restore and list real tables.
const listing = await new Promise((resolve) => {
  const child = spawn("docker", ["exec", "-i", CONTAINER, "pg_restore", "--list"], {
    stdio: ["pipe", "pipe", "inherit"]
  });
  let text = "";
  child.stdout.on("data", (chunk) => (text += chunk));
  child.on("close", (code) => resolve({ code, text }));
  createReadStream(file).pipe(child.stdin);
});
const tables = listing.text.split("\n").filter((line) => / TABLE DATA /.test(line)).length;

if (listing.code !== 0 || tables === 0) {
  console.error(`Backup written to ${file} but failed verification (pg_restore --list exit ${listing.code}, ${tables} tables).`);
  process.exit(1);
}

const size = statSync(file).size;
console.log(`Backed up ${database} -> ${path.relative(process.cwd(), file)} (${size} bytes, ${tables} tables, verified with pg_restore --list)`);
