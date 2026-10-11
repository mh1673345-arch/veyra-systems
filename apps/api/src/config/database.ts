/**
 * Guards against the ways these environments can be crossed: the test suite
 * wiping the development database, development pointing at the test database,
 * and production pointing at either of them (or at SQLite).
 *
 * PostgreSQL URLs are classified by their parsed database name, not by a
 * substring match on the whole URL, so a password or hostname that happens to
 * contain "test" or "dev" can never change the verdict.
 */

export type AppEnvironment = "test" | "development" | "production";

export type DatabaseRole = "test" | "development" | "other";

export interface DatabaseTarget {
  engine: "sqlite" | "postgresql" | "unknown";
  /** Database name (Postgres) or file path (SQLite). Never includes credentials. */
  name: string | null;
  host: string | null;
  role: DatabaseRole;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function currentEnvironment(nodeEnv = process.env.NODE_ENV): AppEnvironment {
  if (nodeEnv === "test") return "test";
  if (nodeEnv === "production") return "production";
  return "development";
}

export class DatabaseEnvironmentError extends Error {}

/** Which engine a URL names, for logging and guard messages. */
export function databaseEngine(databaseUrl = process.env.DATABASE_URL ?? ""): DatabaseTarget["engine"] {
  if (databaseUrl.startsWith("file:")) return "sqlite";
  if (databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://")) {
    return "postgresql";
  }
  return "unknown";
}

/** Parses a DATABASE_URL into what the guards need. Never returns the password. */
export function describeDatabaseUrl(databaseUrl: string): DatabaseTarget {
  const engine = databaseEngine(databaseUrl);

  if (engine === "sqlite") {
    const name = databaseUrl.slice("file:".length);
    const file = name.split(/[\\/]/).pop() ?? "";
    const role: DatabaseRole =
      file === "test.db" ? "test" : file === "dev.db" ? "development" : "other";
    return { engine, name, host: null, role };
  }

  if (engine === "postgresql") {
    let parsed: URL;
    try {
      parsed = new URL(databaseUrl);
    } catch {
      return { engine, name: null, host: null, role: "other" };
    }
    const name = decodeURIComponent(parsed.pathname.replace(/^\//, "")) || null;
    // Exact suffixes: veyra_test / veyra_dev. "contest" or "devices" are not matches.
    const role: DatabaseRole = name?.endsWith("_test")
      ? "test"
      : name?.endsWith("_dev")
        ? "development"
        : "other";
    return { engine, name, host: parsed.hostname, role };
  }

  return { engine, name: null, host: null, role: "other" };
}

/** True for loopback hosts only. The destructive test reset is local-only. */
export function isLocalHost(host: string | null): boolean {
  return host !== null && LOCAL_HOSTS.has(host);
}

/**
 * Throws when DATABASE_URL doesn't belong to the environment we're running in.
 * Called at API startup and from the test setup file, so a misconfiguration
 * fails loudly instead of silently destroying data.
 */
export function assertDatabaseEnvironment(
  databaseUrl = process.env.DATABASE_URL,
  nodeEnv = process.env.NODE_ENV
): void {
  const environment = currentEnvironment(nodeEnv);

  if (!databaseUrl) {
    throw new DatabaseEnvironmentError(
      "DATABASE_URL is not set. Copy apps/api/.env.example to apps/api/.env before starting."
    );
  }

  const target = describeDatabaseUrl(databaseUrl);

  if (target.engine === "unknown") {
    throw new DatabaseEnvironmentError(
      "DATABASE_URL is not a recognised database URL (expected postgresql://…)."
    );
  }

  if (environment === "test") {
    if (target.role !== "test") {
      throw new DatabaseEnvironmentError(
        "Refusing to run tests against a non-test database. NODE_ENV=test requires a DATABASE_URL " +
          "naming a test database (e.g. …/veyra_test); see apps/api/.env.test.example."
      );
    }
    return;
  }

  if (target.role === "test") {
    throw new DatabaseEnvironmentError(
      `Refusing to start in ${environment} against the test database. The test database is reset ` +
        "destructively by the suite."
    );
  }

  if (environment === "production") {
    // Production must not run on a file-backed SQLite database: it cannot support
    // concurrent workers or a second instance safely.
    if (target.engine === "sqlite") {
      throw new DatabaseEnvironmentError(
        "Refusing to start in production against a file-backed SQLite database. Use PostgreSQL."
      );
    }
    if (target.role === "development") {
      throw new DatabaseEnvironmentError(
        "Refusing to start in production against the development database."
      );
    }
  }
}
