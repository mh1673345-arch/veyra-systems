import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../src/db/client.js";
import {
  DatabaseEnvironmentError,
  assertDatabaseEnvironment,
  currentEnvironment,
  databaseEngine,
  describeDatabaseUrl
} from "../src/config/database.js";
import { checkResetTarget } from "../scripts/testDbTarget.mjs";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("database environment isolation", () => {
  it("runs the suite against the veyra_test Postgres database, not the development one", () => {
    expect(currentEnvironment()).toBe("test");
    const target = describeDatabaseUrl(process.env.DATABASE_URL ?? "");
    expect(target.engine).toBe("postgresql");
    expect(target.name).toBe("veyra_test");
    expect(target.role).toBe("test");
  });

  it("refuses to run tests against a development database", () => {
    expect(() =>
      assertDatabaseEnvironment("postgresql://veyra:pw@127.0.0.1:5434/veyra_dev", "test")
    ).toThrow(DatabaseEnvironmentError);
    expect(() => assertDatabaseEnvironment("file:./dev.db", "test")).toThrow(
      DatabaseEnvironmentError
    );
  });

  it("classifies by database name, not by substrings elsewhere in the URL", () => {
    // Password and host contain "test", database is development.
    expect(
      describeDatabaseUrl("postgresql://veyra:my_test@test-host:5432/veyra_dev").role
    ).toBe("development");
    expect(() =>
      assertDatabaseEnvironment("postgresql://veyra:my_test@test-host:5432/veyra_dev", "test")
    ).toThrow(DatabaseEnvironmentError);
    // "contest" is not a test database.
    expect(describeDatabaseUrl("postgresql://u:p@h/contest").role).toBe("other");
  });

  it("refuses to start dev or production against the test database", () => {
    const testUrl = "postgresql://veyra:pw@127.0.0.1:5434/veyra_test";
    expect(() => assertDatabaseEnvironment(testUrl, "development")).toThrow(
      DatabaseEnvironmentError
    );
    expect(() => assertDatabaseEnvironment(testUrl, "production")).toThrow(
      DatabaseEnvironmentError
    );
  });

  it("refuses to start production against the development database", () => {
    expect(() =>
      assertDatabaseEnvironment("postgresql://veyra:pw@db:5432/veyra_dev", "production")
    ).toThrow(/development database/);
  });

  it("requires DATABASE_URL to be set, and to be a recognised URL", () => {
    expect(() => assertDatabaseEnvironment(undefined, "development")).toThrow(
      DatabaseEnvironmentError
    );
    expect(() => assertDatabaseEnvironment("mysql://u:p@h/veyra", "production")).toThrow(
      /recognised/
    );
  });

  it("refuses a file-backed SQLite database in production", () => {
    expect(() => assertDatabaseEnvironment("file:./anything.db", "production")).toThrow(
      /SQLite/
    );
  });

  it("accepts a dedicated PostgreSQL URL in production", () => {
    expect(() =>
      assertDatabaseEnvironment("postgresql://user:pass@host:5432/veyra", "production")
    ).not.toThrow();
  });

  it("still refuses a production-looking Postgres URL during tests", () => {
    expect(() =>
      assertDatabaseEnvironment("postgresql://user:pass@prod-host:5432/veyra", "test")
    ).toThrow(DatabaseEnvironmentError);
  });

  it("identifies the engine behind a URL", () => {
    expect(databaseEngine("file:./dev.db")).toBe("sqlite");
    expect(databaseEngine("postgresql://user:pass@host/db")).toBe("postgresql");
    expect(databaseEngine("mysql://user:pass@host/db")).toBe("unknown");
  });
});

describe("destructive test reset target", () => {
  it("allows only a local _test database", () => {
    expect(checkResetTarget("postgresql://veyra:pw@127.0.0.1:5434/veyra_test?schema=public")).toEqual({
      ok: true,
      name: "veyra_test",
      host: "127.0.0.1"
    });
    expect(checkResetTarget("postgresql://veyra:pw@localhost:5434/veyra_test").ok).toBe(true);
  });

  it("refuses veyra_dev, production-looking, remote, SQLite and unknown URLs", () => {
    const refused = [
      "postgresql://veyra:pw@127.0.0.1:5434/veyra_dev",
      "postgresql://veyra:pw@127.0.0.1:5434/veyra",
      "postgresql://veyra:pw@prod-db.example.com:5432/veyra_test",
      "postgresql://veyra:pw@127.0.0.1:5434/",
      "file:./test.db",
      "mysql://veyra:pw@127.0.0.1/veyra_test",
      "not a url",
      "",
      undefined
    ];
    for (const url of refused) {
      expect(checkResetTarget(url).ok, String(url)).toBe(false);
    }
  });

  it("never echoes the password in its refusal", () => {
    const result = checkResetTarget("postgresql://veyra:s3cret-value@127.0.0.1:5434/veyra_dev");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("s3cret-value");
  });
});

describe("real database isolation", () => {
  /**
   * The real proof: write through the suite's client, then connect to veyra_dev
   * directly and confirm the row isn't there.
   */
  it("does not write test data into the development database", async () => {
    const marker = `isolation-probe-${Date.now()}`;
    await prisma.business.create({ data: { name: marker } });
    expect(await prisma.business.count({ where: { name: marker } })).toBe(1);

    // Read the development URL from apps/api/.env without touching process.env.
    const devUrl = dotenv.parse(readFileSync(path.join(apiRoot, ".env"))).DATABASE_URL;
    const devTarget = describeDatabaseUrl(devUrl ?? "");
    if (!devUrl || devTarget.role !== "development") {
      // Nothing to cross-check against on a machine without a dev database.
      return;
    }
    expect(devUrl).not.toBe(process.env.DATABASE_URL);

    const devClient = new PrismaClient({ datasources: { db: { url: devUrl } } });
    try {
      // Proves the connection is real (throws if veyra_dev is unreachable)...
      await devClient.$queryRaw`SELECT 1`;
      const [{ current_database }] = await devClient.$queryRaw<
        { current_database: string }[]
      >`SELECT current_database()`;
      expect(current_database).toBe(devTarget.name);
      // ...and that the probe did not land there.
      expect(await devClient.business.count({ where: { name: marker } })).toBe(0);
    } finally {
      await devClient.$disconnect();
    }
  });
});
