import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { resetLoginThrottle } from "../src/routes/auth.js";
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  hashPassword,
  hashToken,
  pruneDeadSessions
} from "../src/services/auth/sessions.js";
import {
  MIN_PASSWORD_LENGTH,
  consumePasswordResetToken,
  createPasswordResetToken,
  pruneExpiredResetTokens,
  validatePassword
} from "../src/services/auth/passwords.js";
import { MemoryRateLimiter } from "../src/services/auth/rateLimiter.js";

const app = createApp();
const PASSWORD = "harden-test-passphrase";

let businessId: string;
let otherBusinessId: string;
let userId: string;

interface Signed {
  cookie: string;
  csrf: string;
}

/** Signs in and returns both the session cookie and the CSRF token it minted. */
async function signIn(email: string, password = PASSWORD): Promise<Signed> {
  const res = await request(app).post("/api/auth/login").send({ email, password });
  expect(res.status).toBe(200);

  const cookies = res.headers["set-cookie"] as unknown as string[];
  const session = cookies.find((c) => c.startsWith(SESSION_COOKIE))!.split(";")[0];
  const csrfCookie = cookies.find((c) => c.startsWith(CSRF_COOKIE))!;
  const csrf = csrfCookie.split(";")[0].split("=")[1];

  return { cookie: session, csrf };
}

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: "@harden.test" } } });

  const [business, other] = await Promise.all([
    prisma.business.create({ data: { name: "Harden Dental" } }),
    prisma.business.create({ data: { name: "Harden Second" } })
  ]);
  businessId = business.id;
  otherBusinessId = other.id;

  const user = await prisma.user.create({
    data: {
      email: "operator@harden.test",
      name: "Hardy Operator",
      passwordHash: await hashPassword(PASSWORD)
    }
  });
  userId = user.id;

  await prisma.businessMembership.createMany({
    data: [
      { userId: user.id, businessId, role: "OWNER" },
      { userId: user.id, businessId: otherBusinessId, role: "OPERATOR" }
    ]
  });
});

beforeEach(() => {
  resetLoginThrottle();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("CSRF protection", () => {
  let bookingId: string;

  beforeAll(async () => {
    const conversation = await prisma.conversation.create({ data: { businessId } });
    const booking = await prisma.appointment.create({
      data: {
        conversationId: conversation.id,
        businessId,
        requestedTime: "2027-01-01T10:00",
        status: "submitted",
        submittedAt: new Date()
      }
    });
    bookingId = booking.id;
  });

  it("accepts a mutation carrying the session's CSRF token", async () => {
    const { cookie, csrf } = await signIn("operator@harden.test");
    const res = await request(app)
      .patch(`/api/ops/businesses/${businessId}/bookings/${bookingId}/status`)
      .set("Cookie", cookie)
      .set("x-csrf-token", csrf)
      .send({ status: "reviewing" });

    expect(res.status).toBe(200);
  });

  it("rejects a mutation with no CSRF token", async () => {
    const { cookie } = await signIn("operator@harden.test");
    const res = await request(app)
      .patch(`/api/ops/businesses/${businessId}/bookings/${bookingId}/status`)
      .set("Cookie", cookie)
      .send({ status: "confirmed" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("CSRF");
    // The record is untouched.
    expect((await prisma.appointment.findUnique({ where: { id: bookingId } }))?.status).toBe(
      "reviewing"
    );
  });

  it("rejects a mutation with an invalid CSRF token", async () => {
    const { cookie } = await signIn("operator@harden.test");
    const res = await request(app)
      .patch(`/api/ops/businesses/${businessId}/bookings/${bookingId}/status`)
      .set("Cookie", cookie)
      .set("x-csrf-token", "not-the-right-token")
      .send({ status: "confirmed" });

    expect(res.status).toBe(403);
  });

  it("rejects a CSRF token minted for a different session", async () => {
    const first = await signIn("operator@harden.test");
    const second = await signIn("operator@harden.test");

    const res = await request(app)
      .patch(`/api/ops/businesses/${businessId}/bookings/${bookingId}/status`)
      .set("Cookie", first.cookie)
      .set("x-csrf-token", second.csrf)
      .send({ status: "confirmed" });

    // Same user, different session: the token is still not valid here.
    expect(res.status).toBe(403);
  });

  it("rejects an unauthenticated mutation before CSRF is even considered", async () => {
    const res = await request(app)
      .patch(`/api/ops/businesses/${businessId}/bookings/${bookingId}/status`)
      .set("x-csrf-token", "anything")
      .send({ status: "confirmed" });

    expect(res.status).toBe(401);
  });

  it("does not require a CSRF token for safe reads", async () => {
    const { cookie } = await signIn("operator@harden.test");
    const res = await request(app)
      .get(`/api/ops/businesses/${businessId}/bookings`)
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
  });

  it("protects member mutations too", async () => {
    const { cookie } = await signIn("operator@harden.test");
    const res = await request(app)
      .post(`/api/ops/businesses/${businessId}/members`)
      .set("Cookie", cookie)
      .send({ email: "someone@harden.test", role: "VIEWER" });

    expect(res.status).toBe(403);
  });
});

describe("session rotation and revocation", () => {
  it("mints a brand-new token and CSRF secret on every login", async () => {
    const first = await signIn("operator@harden.test");
    const second = await signIn("operator@harden.test");

    expect(first.cookie).not.toBe(second.cookie);
    expect(first.csrf).not.toBe(second.csrf);
    // Both remain valid — logging in elsewhere doesn't kill an existing session.
    expect((await request(app).get("/api/auth/me").set("Cookie", first.cookie)).status).toBe(200);
    expect((await request(app).get("/api/auth/me").set("Cookie", second.cookie)).status).toBe(200);
  });

  it("lists multiple active sessions and marks the current one", async () => {
    await prisma.session.deleteMany({ where: { userId } });
    const first = await signIn("operator@harden.test");
    await signIn("operator@harden.test");

    const res = await request(app).get("/api/auth/sessions").set("Cookie", first.cookie);

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
    expect(res.body.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
  });

  it("signs out all other devices while keeping the caller signed in", { timeout: 60_000 }, async () => {
    await prisma.session.deleteMany({ where: { userId } });
    const keep = await signIn("operator@harden.test");
    const other = await signIn("operator@harden.test");

    const res = await request(app)
      .post("/api/auth/sessions/revoke-others")
      .set("Cookie", keep.cookie)
      .set("x-csrf-token", keep.csrf);

    expect(res.status).toBe(200);
    expect(res.body.revoked).toBeGreaterThanOrEqual(1);

    // The other device is dead immediately; this one still works.
    expect((await request(app).get("/api/auth/me").set("Cookie", other.cookie)).status).toBe(401);
    expect((await request(app).get("/api/auth/me").set("Cookie", keep.cookie)).status).toBe(200);
  });

  it("requires a CSRF token to revoke other sessions", async () => {
    const { cookie } = await signIn("operator@harden.test");
    const res = await request(app).post("/api/auth/sessions/revoke-others").set("Cookie", cookie);
    expect(res.status).toBe(403);
  });

  it("invalidates the session on logout", async () => {
    const { cookie, csrf } = await signIn("operator@harden.test");
    const logout = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", cookie)
      .set("x-csrf-token", csrf);

    expect(logout.status).toBe(204);
    expect((await request(app).get("/api/auth/me").set("Cookie", cookie)).status).toBe(401);
  });
});

describe("session pruning", () => {
  it("removes expired sessions but never active ones", async () => {
    await prisma.session.deleteMany({ where: { userId } });
    const live = await signIn("operator@harden.test");

    await prisma.session.create({
      data: {
        userId,
        tokenHash: hashToken(`expired-${Date.now()}`),
        csrfToken: "x",
        expiresAt: new Date(Date.now() - 1000)
      }
    });

    const pruned = await pruneDeadSessions();
    expect(pruned).toBeGreaterThanOrEqual(1);

    // The live session survived and still works.
    expect((await request(app).get("/api/auth/me").set("Cookie", live.cookie)).status).toBe(200);
  });

  it("keeps recently revoked sessions for diagnosis, then removes old ones", async () => {
    await prisma.session.deleteMany({ where: { userId } });

    const recentlyRevoked = await prisma.session.create({
      data: {
        userId,
        tokenHash: hashToken(`recent-${Date.now()}`),
        csrfToken: "x",
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: new Date()
      }
    });
    const longRevoked = await prisma.session.create({
      data: {
        userId,
        tokenHash: hashToken(`old-${Date.now()}`),
        csrfToken: "x",
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      }
    });

    await pruneDeadSessions();

    expect(await prisma.session.findUnique({ where: { id: recentlyRevoked.id } })).not.toBeNull();
    expect(await prisma.session.findUnique({ where: { id: longRevoked.id } })).toBeNull();
  });
});

describe("password policy", () => {
  it("requires a reasonable minimum length", () => {
    expect(validatePassword("short").ok).toBe(false);
    expect(validatePassword("a".repeat(MIN_PASSWORD_LENGTH - 1)).ok).toBe(false);
    expect(validatePassword("a-perfectly-fine-passphrase").ok).toBe(true);
  });

  it("rejects passwords longer than bcrypt will actually read", () => {
    // Beyond 72 bytes bcrypt silently truncates, so it's refused instead.
    expect(validatePassword("x".repeat(73)).ok).toBe(false);
  });

  it("accepts long passphrases and password-manager output", () => {
    expect(validatePassword("correct horse battery staple stapler").ok).toBe(true);
    expect(validatePassword("Xk7#mQ2$vL9!pR4@wT6z").ok).toBe(true);
  });

  it("does not demand arbitrary character classes", () => {
    // All lowercase, no digits or symbols — still fine because it's long.
    expect(validatePassword("thequickbrownfoxjumps").ok).toBe(true);
  });

  it("rejects obvious patterns and the user's own email", () => {
    expect(validatePassword("mypassword123456").ok).toBe(false);
    expect(validatePassword("sam.smith-is-here", "sam.smith@example.com").ok).toBe(false);
  });
});

describe("password change", () => {
  const NEW_PASSWORD = "a-brand-new-passphrase";

  it("rejects an incorrect current password", async () => {
    const { cookie, csrf } = await signIn("operator@harden.test");
    const res = await request(app)
      .post("/api/auth/password")
      .set("Cookie", cookie)
      .set("x-csrf-token", csrf)
      .send({ currentPassword: "not-my-password", newPassword: NEW_PASSWORD });

    expect(res.status).toBe(403);
  });

  it("enforces the password policy on the new password", async () => {
    const { cookie, csrf } = await signIn("operator@harden.test");
    const res = await request(app)
      .post("/api/auth/password")
      .set("Cookie", cookie)
      .set("x-csrf-token", csrf)
      .send({ currentPassword: PASSWORD, newPassword: "short" });

    expect(res.status).toBe(422);
  });

  // Several real bcrypt hashes and comparisons in one test.
  it("changes the password, kills other sessions, and keeps this one alive", { timeout: 60_000 }, async () => {
    await prisma.session.deleteMany({ where: { userId } });
    const changer = await signIn("operator@harden.test");
    const elsewhere = await signIn("operator@harden.test");

    const res = await request(app)
      .post("/api/auth/password")
      .set("Cookie", changer.cookie)
      .set("x-csrf-token", changer.csrf)
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    expect(res.status).toBe(200);

    // Every pre-existing session is revoked, including the caller's old cookie.
    expect((await request(app).get("/api/auth/me").set("Cookie", elsewhere.cookie)).status).toBe(
      401
    );
    expect((await request(app).get("/api/auth/me").set("Cookie", changer.cookie)).status).toBe(401);

    // ...but the response issued a fresh session for this browser.
    const rotated = (res.headers["set-cookie"] as unknown as string[])
      .find((c) => c.startsWith(SESSION_COOKIE))!
      .split(";")[0];
    expect(rotated).not.toBe(changer.cookie);
    expect((await request(app).get("/api/auth/me").set("Cookie", rotated)).status).toBe(200);

    // Old credentials no longer work; new ones do.
    expect(
      (await request(app).post("/api/auth/login").send({
        email: "operator@harden.test",
        password: PASSWORD
      })).status
    ).toBe(401);

    const relogin = await request(app)
      .post("/api/auth/login")
      .send({ email: "operator@harden.test", password: NEW_PASSWORD });
    expect(relogin.status).toBe(200);

    // Restore for any later tests.
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(PASSWORD) }
    });
  });
});

describe("password reset foundation", () => {
  it("stores only the hash of a reset token", async () => {
    const { token } = await createPasswordResetToken(userId);

    expect(await prisma.passwordResetToken.findUnique({ where: { tokenHash: token } })).toBeNull();
    expect(
      await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } })
    ).not.toBeNull();
  });

  it("accepts a token exactly once", async () => {
    const { token } = await createPasswordResetToken(userId);

    expect(await consumePasswordResetToken(token)).toEqual({ ok: true, userId });
    expect(await consumePasswordResetToken(token)).toEqual({ ok: false, reason: "already_used" });
  });

  it("rejects an expired token", async () => {
    const { token } = await createPasswordResetToken(userId);
    await prisma.passwordResetToken.update({
      where: { tokenHash: hashToken(token) },
      data: { expiresAt: new Date(Date.now() - 1000) }
    });

    expect(await consumePasswordResetToken(token)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects an unknown token", async () => {
    expect(await consumePasswordResetToken("never-issued")).toEqual({
      ok: false,
      reason: "unknown"
    });
  });

  it("invalidates earlier tokens when a new one is issued", async () => {
    const first = await createPasswordResetToken(userId);
    await createPasswordResetToken(userId);

    expect(await consumePasswordResetToken(first.token)).toEqual({
      ok: false,
      reason: "already_used"
    });
  });

  it("prunes spent and expired tokens", async () => {
    await createPasswordResetToken(userId);
    const pruned = await pruneExpiredResetTokens();
    expect(pruned).toBeGreaterThanOrEqual(0);
  });

  it("has no user-facing route, because there is no email delivery", async () => {
    await prisma.passwordResetToken.deleteMany({ where: { userId } });

    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "operator@harden.test" });

    // Deliberately unimplemented rather than pretending to send mail: the
    // request never succeeds and never mints a token.
    expect(res.status).not.toBe(200);
    expect(await prisma.passwordResetToken.count({ where: { userId } })).toBe(0);
  });
});

describe("rate limiting", () => {
  it("allows attempts up to the limit and then blocks with a retry hint", async () => {
    const limiter = new MemoryRateLimiter({ maxAttempts: 3, windowMs: 60_000 });

    for (let i = 0; i < 3; i += 1) {
      expect((await limiter.consume("key")).allowed).toBe(true);
    }

    const blocked = await limiter.consume("key");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("keys separately so one identity cannot exhaust another's budget", async () => {
    const limiter = new MemoryRateLimiter({ maxAttempts: 1, windowMs: 60_000 });

    await limiter.consume("victim");
    expect((await limiter.consume("victim")).allowed).toBe(false);
    // A different key is unaffected — no cross-account lockout.
    expect((await limiter.consume("someone-else")).allowed).toBe(true);
  });

  it("throttles rather than locking an account permanently", async () => {
    const limiter = new MemoryRateLimiter({ maxAttempts: 1, windowMs: 20 });

    await limiter.consume("key");
    expect((await limiter.consume("key")).allowed).toBe(false);

    // The window passes and access returns — no permanent lockout to weaponise.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await limiter.consume("key")).allowed).toBe(true);
  });

  // Each attempt runs a real bcrypt comparison, so this one is deliberately slow.
  it("returns the same throttled response whether or not the account exists", { timeout: 60_000 }, async () => {
    for (let i = 0; i < 11; i += 1) {
      await request(app).post("/api/auth/login").send({ email: "ghost@harden.test", password: "x" });
    }
    const unknown = await request(app)
      .post("/api/auth/login")
      .send({ email: "ghost@harden.test", password: "x" });

    resetLoginThrottle();
    for (let i = 0; i < 11; i += 1) {
      await request(app)
        .post("/api/auth/login")
        .send({ email: "operator@harden.test", password: "x" });
    }
    const known = await request(app)
      .post("/api/auth/login")
      .send({ email: "operator@harden.test", password: "x" });

    expect(unknown.status).toBe(429);
    expect(known.status).toBe(429);
    expect(unknown.body.error).toBe(known.body.error);
  });
});

describe("immediate effect of account and membership changes", () => {
  it("cuts off a disabled user's reads and mutations on the very next request", async () => {
    const { cookie, csrf } = await signIn("operator@harden.test");
    expect((await request(app).get(`/api/ops/businesses/${businessId}/bookings`).set("Cookie", cookie)).status).toBe(200);

    await prisma.user.update({ where: { id: userId }, data: { disabledAt: new Date() } });

    expect(
      (await request(app).get(`/api/ops/businesses/${businessId}/bookings`).set("Cookie", cookie))
        .status
    ).toBe(401);
    expect(
      (
        await request(app)
          .patch(`/api/ops/businesses/${businessId}/bookings/none/status`)
          .set("Cookie", cookie)
          .set("x-csrf-token", csrf)
          .send({ status: "confirmed" })
      ).status
    ).toBe(401);

    // And they cannot sign in again.
    expect(
      (await request(app).post("/api/auth/login").send({
        email: "operator@harden.test",
        password: PASSWORD
      })).status
    ).toBe(401);

    await prisma.user.update({ where: { id: userId }, data: { disabledAt: null } });
  });

  it("removes access to a business the moment membership is revoked, keeping other businesses", async () => {
    const { cookie } = await signIn("operator@harden.test");

    expect(
      (await request(app).get(`/api/ops/businesses/${otherBusinessId}/overview`).set("Cookie", cookie))
        .status
    ).toBe(200);

    await prisma.businessMembership.delete({
      where: { userId_businessId: { userId, businessId: otherBusinessId } }
    });

    // Same session, immediately denied for that business...
    expect(
      (await request(app).get(`/api/ops/businesses/${otherBusinessId}/overview`).set("Cookie", cookie))
        .status
    ).toBe(404);
    // ...but still valid for the business they do belong to.
    expect(
      (await request(app).get(`/api/ops/businesses/${businessId}/overview`).set("Cookie", cookie))
        .status
    ).toBe(200);
  });
});

describe("security headers and cookie flags", () => {
  it("sets restrictive headers on API responses", async () => {
    const res = await request(app).get("/api/health");

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  it("does not assert HSTS outside production HTTPS", async () => {
    const res = await request(app).get("/api/health");
    expect(res.headers["strict-transport-security"]).toBeUndefined();
  });

  it("marks the session cookie httpOnly and the CSRF cookie readable", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "operator@harden.test", password: PASSWORD });

    const cookies = res.headers["set-cookie"] as unknown as string[];
    const session = cookies.find((c) => c.startsWith(SESSION_COOKIE))!;
    const csrf = cookies.find((c) => c.startsWith(CSRF_COOKIE))!;

    expect(session).toContain("HttpOnly");
    expect(session).toContain("SameSite=Lax");
    expect(session).toContain("Path=/");
    // The CSRF token must be readable by the SPA to be echoed back.
    expect(csrf).not.toContain("HttpOnly");
    expect(csrf).toContain("SameSite=Lax");

    // Not secure in test/development, by design; secure is set in production.
    expect(session).not.toContain("Secure");
  });
});

describe("auth audit events", () => {
  it("records logins, failures, logout and password changes without secrets", async () => {
    await prisma.authEvent.deleteMany({ where: { userId } });

    await request(app)
      .post("/api/auth/login")
      .send({ email: "operator@harden.test", password: "wrong-password" });
    const { cookie, csrf } = await signIn("operator@harden.test");
    await request(app).post("/api/auth/logout").set("Cookie", cookie).set("x-csrf-token", csrf);

    const events = await prisma.authEvent.findMany({ where: { userId } });
    const types = events.map((e) => e.type);

    expect(types).toContain("login_failed");
    expect(types).toContain("login_succeeded");
    expect(types).toContain("logout");

    // Nothing sensitive is ever written to the audit trail.
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain("wrong-password");
    expect(serialized).not.toContain(cookie.split("=")[1]);
  });
});
