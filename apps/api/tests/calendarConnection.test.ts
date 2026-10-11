import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createHash } from "node:crypto";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { CSRF_COOKIE, hashPassword } from "../src/services/auth/sessions.js";
import {
  DecryptionError,
  decryptSecret,
  encryptSecret,
  encryptionConfigured
} from "../src/services/crypto/secretBox.js";
import { createCalendarBusiness, fakeCalendarProvider, resetFakeCalendar } from "./helpers/calendarFixtures.js";

/**
 * Connection management: who may change it, what the browser is allowed to see,
 * and whether a forged or replayed OAuth callback can connect anything.
 */

const app = createApp();
const PASSWORD = "calendar-suite-password";

interface Session {
  cookie: string;
  csrf: string;
}

const auth = (r: request.Test, session: Session) =>
  r.set({ Cookie: session.cookie, "x-csrf-token": session.csrf });

let businessId: string;
let otherBusinessId: string;
const sessions: Record<string, Session> = {};

async function signIn(email: string): Promise<Session> {
  const res = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  const cookies = res.headers["set-cookie"] as unknown as string[];
  return {
    cookie: cookies.map((cookie) => cookie.split(";")[0]).join("; "),
    csrf: cookies.find((cookie) => cookie.startsWith(CSRF_COOKIE))!.split(";")[0].split("=")[1]
  };
}

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: "@calendar.test" } } });

  const fixture = await createCalendarBusiness({ namePrefix: "Connection" });
  businessId = fixture.businessId;
  const other = await createCalendarBusiness({ namePrefix: "Other tenant" });
  otherBusinessId = other.businessId;

  const passwordHash = await hashPassword(PASSWORD);
  for (const role of ["OWNER", "ADMIN", "OPERATOR", "VIEWER"]) {
    const user = await prisma.user.create({
      data: { email: `${role.toLowerCase()}@calendar.test`, name: `Cal ${role}`, passwordHash }
    });
    await prisma.businessMembership.create({ data: { userId: user.id, businessId, role } });
    sessions[role] = await signIn(user.email);
  }

  // A member of the *other* tenant only.
  const outsider = await prisma.user.create({
    data: { email: "outsider@calendar.test", name: "Outsider", passwordHash }
  });
  await prisma.businessMembership.create({
    data: { userId: outsider.id, businessId: otherBusinessId, role: "OWNER" }
  });
  sessions.OUTSIDER = await signIn(outsider.email);
}, 60_000);

beforeEach(() => {
  resetFakeCalendar();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("who can see and change the connection", () => {
  it("lets any member with settings access see the status without exposing tokens", async () => {
    for (const role of ["OWNER", "ADMIN", "OPERATOR", "VIEWER"]) {
      const res = await auth(request(app).get(`/api/ops/businesses/${businessId}/calendar`), sessions[role]);
      expect(res.status, role).toBe(200);
      expect(res.body.connection.provider).toBe("fake");
      expect(res.body.timezone).toBe("America/New_York");

      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain("test-access-token");
      expect(serialized).not.toContain("test-refresh-token");
      expect(serialized).not.toMatch(/accessToken|refreshToken|TokenEnc/);
    }
  });

  it("reports management rights per role", async () => {
    const canManage = async (role: string) =>
      (await auth(request(app).get(`/api/ops/businesses/${businessId}/calendar`), sessions[role])).body.canManage;

    expect(await canManage("OWNER")).toBe(true);
    expect(await canManage("ADMIN")).toBe(true);
    // Day-to-day operators run the queue but cannot re-point the calendar.
    expect(await canManage("OPERATOR")).toBe(false);
    expect(await canManage("VIEWER")).toBe(false);
  });

  it("refuses connection changes for OPERATOR and VIEWER", async () => {
    for (const role of ["OPERATOR", "VIEWER"]) {
      const connect = await auth(
        request(app).post(`/api/ops/businesses/${businessId}/calendar/connect`),
        sessions[role]
      );
      expect(connect.status, role).toBe(403);

      const select = await auth(
        request(app).post(`/api/ops/businesses/${businessId}/calendar/select`),
        sessions[role]
      ).send({ calendarId: "secondary" });
      expect(select.status, role).toBe(403);

      const disconnect = await auth(
        request(app).post(`/api/ops/businesses/${businessId}/calendar/disconnect`),
        sessions[role]
      );
      expect(disconnect.status, role).toBe(403);
    }
  });

  it("hides another tenant's calendar entirely", async () => {
    const read = await auth(
      request(app).get(`/api/ops/businesses/${businessId}/calendar`),
      sessions.OUTSIDER
    );
    // Not 403: a non-member must not learn the business exists.
    expect(read.status).toBe(404);

    const select = await auth(
      request(app).post(`/api/ops/businesses/${businessId}/calendar/select`),
      sessions.OUTSIDER
    ).send({ calendarId: "primary" });
    expect(select.status).toBe(404);
  });

  it("requires a CSRF token for connection changes", async () => {
    const res = await request(app)
      .post(`/api/ops/businesses/${businessId}/calendar/disconnect`)
      .set("Cookie", sessions.OWNER.cookie)
      .send({});
    expect(res.status).toBe(403);
  });

  it("requires authentication at all", async () => {
    expect((await request(app).get(`/api/ops/businesses/${businessId}/calendar`)).status).toBe(401);
  });
});

describe("choosing a calendar", () => {
  it("lists the calendars on the connection and re-points to a writable one", async () => {
    const list = await auth(
      request(app).get(`/api/ops/businesses/${businessId}/calendar/calendars`),
      sessions.OWNER
    );
    expect(list.status).toBe(200);
    expect(list.body.calendars.map((calendar: { id: string }) => calendar.id)).toContain("secondary");

    const select = await auth(
      request(app).post(`/api/ops/businesses/${businessId}/calendar/select`),
      sessions.ADMIN
    ).send({ calendarId: "secondary" });

    expect(select.status).toBe(200);
    expect(select.body.connection.selectedCalendarId).toBe("secondary");
    expect(select.body.live).toBe(true);

    // Put it back for the other tests.
    await auth(request(app).post(`/api/ops/businesses/${businessId}/calendar/select`), sessions.OWNER).send({
      calendarId: "primary"
    });
  });

  it("refuses a calendar Veyra cannot write to", async () => {
    const res = await auth(
      request(app).post(`/api/ops/businesses/${businessId}/calendar/select`),
      sessions.OWNER
    ).send({ calendarId: "readonly" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/write access/i);
  });

  it("refuses a calendar that is not on the connection", async () => {
    const res = await auth(
      request(app).post(`/api/ops/businesses/${businessId}/calendar/select`),
      sessions.OWNER
    ).send({ calendarId: "someone-elses-calendar" });
    expect(res.status).toBe(400);
  });

  it("reports the provider being unreachable rather than silently failing", async () => {
    fakeCalendarProvider.setFailure("unavailable");
    const res = await auth(
      request(app).get(`/api/ops/businesses/${businessId}/calendar/calendars`),
      sessions.OWNER
    );
    expect(res.status).toBe(503);
  });
});

describe("disconnecting", () => {
  it("destroys the stored credentials and takes calendar booking offline", async () => {
    const fixture = await createCalendarBusiness({ namePrefix: "Disconnect" });
    const owner = await prisma.user.create({
      data: {
        email: `owner-disconnect@calendar.test`,
        name: "Disconnect Owner",
        passwordHash: await hashPassword(PASSWORD)
      }
    });
    await prisma.businessMembership.create({
      data: { userId: owner.id, businessId: fixture.businessId, role: "OWNER" }
    });
    const session = await signIn(owner.email);

    const res = await auth(
      request(app).post(`/api/ops/businesses/${fixture.businessId}/calendar/disconnect`),
      session
    );

    expect(res.status).toBe(200);
    expect(res.body.live).toBe(false);
    expect(res.body.connection).toBeNull();

    const row = await prisma.calendarConnection.findFirstOrThrow({
      where: { businessId: fixture.businessId }
    });
    expect(row.status).toBe("disconnected");
    expect(row.accessTokenEnc).toBeNull();
    expect(row.refreshTokenEnc).toBeNull();
    expect(row.selectedCalendarId).toBeNull();
  }, 30_000);
});

describe("OAuth flow", () => {
  const GOOGLE_ENV = {
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    GOOGLE_REDIRECT_URI: "http://localhost:4000/api/calendar/google/callback"
  };

  async function withGoogleConfigured<T>(run: () => PromiseLike<T>): Promise<T> {
    Object.assign(process.env, GOOGLE_ENV);
    try {
      return await run();
    } finally {
      for (const key of Object.keys(GOOGLE_ENV)) delete process.env[key as keyof typeof GOOGLE_ENV];
    }
  }

  it("refuses to start a connection when Google is not configured on this server", async () => {
    const res = await auth(
      request(app).post(`/api/ops/businesses/${businessId}/calendar/connect`),
      sessions.OWNER
    );
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/i);
  });

  it("returns a consent URL and stores only the hash of the state", async () => {
    const res = await withGoogleConfigured(() =>
      auth(request(app).post(`/api/ops/businesses/${businessId}/calendar/connect`), sessions.OWNER)
    );

    expect(res.status).toBe(200);
    const url = new URL(res.body.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(GOOGLE_ENV.GOOGLE_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(GOOGLE_ENV.GOOGLE_REDIRECT_URI);
    // Offline access is required or there is no refresh token to store.
    expect(url.searchParams.get("access_type")).toBe("offline");
    const state = url.searchParams.get("state")!;
    expect(state.length).toBeGreaterThan(20);

    const stored = await prisma.calendarOAuthState.findFirstOrThrow({
      where: { stateHash: createHash("sha256").update(state).digest("hex") }
    });
    expect(stored.businessId).toBe(businessId);
    // The raw state is never persisted.
    expect(await prisma.calendarOAuthState.findFirst({ where: { stateHash: state } })).toBeNull();
  });

  it("rejects a callback with an unknown state", async () => {
    const res = await request(app).get("/api/calendar/google/callback?code=abc&state=not-a-real-state");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid or has expired/i);
  });

  it("rejects a callback with no code or state at all", async () => {
    expect((await request(app).get("/api/calendar/google/callback")).status).toBe(400);
  });

  it("rejects an expired state", async () => {
    const state = `expired-state-${Date.now()}`;
    await prisma.calendarOAuthState.create({
      data: {
        businessId,
        userId: "someone",
        provider: "google",
        stateHash: createHash("sha256").update(state).digest("hex"),
        expiresAt: new Date(Date.now() - 60_000)
      }
    });

    const res = await request(app).get(`/api/calendar/google/callback?code=abc&state=${state}`);
    expect(res.status).toBe(400);
  });

  it("rejects a replayed state", async () => {
    const state = `used-state-${Date.now()}`;
    await prisma.calendarOAuthState.create({
      data: {
        businessId,
        userId: "someone",
        provider: "google",
        stateHash: createHash("sha256").update(state).digest("hex"),
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: new Date()
      }
    });

    const res = await request(app).get(`/api/calendar/google/callback?code=abc&state=${state}`);
    expect(res.status).toBe(400);
  });

  it("treats a declined consent screen as a redirect, not an error", async () => {
    const res = await request(app).get("/api/calendar/google/callback?error=access_denied");
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/calendar=declined/);
  });
});

describe("token storage", () => {
  it("has an encryption key configured for the test environment", () => {
    expect(encryptionConfigured()).toBe(true);
  });

  it("round-trips a secret and stores nothing readable", () => {
    const secret = "ya29.a0-super-secret-refresh-token";
    const sealed = encryptSecret(secret);

    expect(sealed).not.toContain(secret);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(decryptSecret(sealed)).toBe(secret);
    // A fresh IV each time, so the same token never produces the same ciphertext.
    expect(encryptSecret(secret)).not.toBe(sealed);
  });

  it("refuses to decrypt a tampered value", () => {
    const sealed = encryptSecret("tamper-me");
    const [version, iv, tag, ciphertext] = sealed.split(".");
    const flipped = `${version}.${iv}.${tag}.${Buffer.from("different-content").toString("base64url")}`;

    expect(() => decryptSecret(flipped)).toThrow(DecryptionError);
    expect(() => decryptSecret("not-even-encrypted")).toThrow(DecryptionError);
    expect(ciphertext.length).toBeGreaterThan(0);
  });

  it("refuses to decrypt with the wrong key", () => {
    const sealed = encryptSecret("key-bound");
    const otherKey = { VEYRA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") };
    expect(() => decryptSecret(sealed, otherKey as NodeJS.ProcessEnv)).toThrow(DecryptionError);
  });

  it("stores calendar tokens encrypted in the database", async () => {
    const row = await prisma.calendarConnection.findFirstOrThrow({ where: { businessId } });
    expect(row.accessTokenEnc).not.toBeNull();
    expect(row.accessTokenEnc).not.toContain("test-access-token");
    expect(decryptSecret(row.accessTokenEnc!)).toBe("test-access-token");
  });
});
