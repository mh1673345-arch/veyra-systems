/**
 * Decides whether a DATABASE_URL may be reset destructively by the test suite.
 *
 * Plain JavaScript (no build step) so scripts/reset-test-db.mjs can use it
 * before anything else runs; tests/databaseIsolation.test.ts imports it too.
 * The answer never echoes the URL, which carries the database password.
 *
 * Allowed: a PostgreSQL database whose name ends in "_test" (veyra_test) on a
 * loopback host. Everything else — veyra_dev, a remote or production-looking
 * database, SQLite, an unparseable URL — is refused.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** @returns {{ ok: true, name: string, host: string } | { ok: false, reason: string }} */
export function checkResetTarget(databaseUrl) {
  if (!databaseUrl) {
    return { ok: false, reason: "DATABASE_URL is not set" };
  }
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    return { ok: false, reason: "DATABASE_URL is not a PostgreSQL URL" };
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return { ok: false, reason: "DATABASE_URL could not be parsed" };
  }

  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const host = parsed.hostname;

  if (!name.endsWith("_test")) {
    return {
      ok: false,
      reason: `database "${name || "(none)"}" is not a test database (expected a name ending in _test)`
    };
  }
  if (!LOCAL_HOSTS.has(host)) {
    return { ok: false, reason: `host "${host}" is not local; the test reset only runs on loopback` };
  }

  return { ok: true, name, host };
}
