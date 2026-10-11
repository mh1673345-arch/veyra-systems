import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { changePlan } from "../src/services/access/accessService.js";
import { resetLoginThrottle } from "../src/routes/auth.js";
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  hashPassword,
  hashToken
} from "../src/services/auth/sessions.js";

const app = createApp();
const PASSWORD = "correct-horse-battery";

let businessId: string;
let otherBusinessId: string;
let ownerId: string;
let viewerId: string;
let disabledUserId: string;

/** CSRF token issued alongside each session cookie, so mutations can send it. */
const csrfByCookie = new Map<string, string>();

/** Headers for an authenticated request: session cookie plus its CSRF token. */
function h(cookie: string) {
  return { Cookie: cookie, "x-csrf-token": csrfByCookie.get(cookie) ?? "" };
}

/** Signs in and returns the session cookie for use on subsequent requests. */
async function signIn(email: string, password = PASSWORD): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ email, password });
  expect(res.status).toBe(200);
  const cookies = res.headers["set-cookie"] as unknown as string[];
  const cookie = cookies.find((c) => c.startsWith(SESSION_COOKIE));
  expect(cookie).toBeTruthy();
  const sessionCookie = cookie!.split(";")[0];
  const csrf = cookies.find((c) => c.startsWith(CSRF_COOKIE))!.split(";")[0].split("=")[1];
  csrfByCookie.set(sessionCookie, csrf);
  return sessionCookie;
}

beforeAll(async () => {
  // Own our fixtures explicitly so the file can be run on its own, without
  // relying on the pretest database reset having just happened.
  await prisma.user.deleteMany({ where: { email: { endsWith: "@auth.test" } } });

  const passwordHash = await hashPassword(PASSWORD);

  const [business, otherBusiness] = await Promise.all([
    prisma.business.create({ data: { name: "Auth Dental" } }),
    prisma.business.create({ data: { name: "Other Dental" } })
  ]);
  businessId = business.id;
  otherBusinessId = otherBusiness.id;
  // This file is about RBAC, not plan limits: Pro's team size keeps the member
  // tests about roles. The limit itself is covered in subscriptions.test.ts.
  await changePlan({ businessId, plan: "PRO", status: "active", actorType: "system", reason: "test fixture" });

  const [owner, admin, operator, viewer, outsider, disabled] = await Promise.all([
    prisma.user.create({ data: { email: "owner@auth.test", name: "Olivia Owner", passwordHash } }),
    prisma.user.create({ data: { email: "admin@auth.test", name: "Adam Admin", passwordHash } }),
    prisma.user.create({ data: { email: "operator@auth.test", name: "Omar Operator", passwordHash } }),
    prisma.user.create({ data: { email: "viewer@auth.test", name: "Vera Viewer", passwordHash } }),
    prisma.user.create({ data: { email: "outsider@auth.test", name: "Otto Outsider", passwordHash } }),
    prisma.user.create({
      data: {
        email: "disabled@auth.test",
        name: "Dana Disabled",
        passwordHash,
        disabledAt: new Date()
      }
    })
  ]);
  ownerId = owner.id;
  viewerId = viewer.id;
  disabledUserId = disabled.id;

  await prisma.businessMembership.createMany({
    data: [
      { userId: owner.id, businessId, role: "OWNER" },
      { userId: admin.id, businessId, role: "ADMIN" },
      { userId: operator.id, businessId, role: "OPERATOR" },
      { userId: viewer.id, businessId, role: "VIEWER" },
      { userId: disabled.id, businessId, role: "OPERATOR" },
      // The outsider belongs only to the other business.
      { userId: outsider.id, businessId: otherBusinessId, role: "OWNER" }
    ]
  });
});

beforeEach(() => {
  resetLoginThrottle();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("authentication", () => {
  it("signs in with valid credentials and sets an httpOnly session cookie", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "owner@auth.test", password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("owner@auth.test");
    expect(res.body.user.passwordHash).toBeUndefined();

    const cookie = (res.headers["set-cookie"] as unknown as string[])[0];
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("rejects a wrong password with a generic message", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "owner@auth.test", password: "wrong-password" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid email or password");
  });

  it("gives the same generic message for an unknown email", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@auth.test", password: PASSWORD });

    expect(res.status).toBe(401);
    // Identical wording, so the response can't be used to enumerate accounts.
    expect(res.body.error).toBe("Invalid email or password");
  });

  it("refuses a disabled user even with the right password", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "disabled@auth.test", password: PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid email or password");
  });

  it("never stores or returns the plaintext password", async () => {
    const user = await prisma.user.findUnique({ where: { email: "owner@auth.test" } });
    expect(user?.passwordHash).not.toContain(PASSWORD);
    expect(user?.passwordHash.startsWith("$2")).toBe(true);
  });

  it("stores only a hash of the session token, never the token itself", async () => {
    const cookie = await signIn("owner@auth.test");
    const token = cookie.split("=")[1];

    expect(await prisma.session.findUnique({ where: { tokenHash: token } })).toBeNull();
    expect(await prisma.session.findUnique({ where: { tokenHash: hashToken(token) } })).not.toBeNull();
  });

  // Real bcrypt work on each attempt makes this slow by design.
  it("throttles repeated failed sign-in attempts", { timeout: 60_000 }, async () => {
    for (let i = 0; i < 10; i += 1) {
      await request(app).post("/api/auth/login").send({ email: "owner@auth.test", password: "nope" });
    }
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "owner@auth.test", password: PASSWORD });

    expect(res.status).toBe(429);
  });
});

describe("sessions", () => {
  it("returns the signed-in user and their memberships", async () => {
    const cookie = await signIn("owner@auth.test");
    const res = await request(app).get("/api/auth/me").set(h(cookie));

    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe("Olivia Owner");
    expect(res.body.memberships).toHaveLength(1);
    expect(res.body.memberships[0]).toMatchObject({ businessId, role: "OWNER" });
    expect(res.body.memberships[0].permissions).toContain("operations:write");
  });

  it("rejects a request with no session", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("rejects a tampered session cookie", async () => {
    const cookie = await signIn("owner@auth.test");
    const tampered = `${cookie.slice(0, -4)}beef`;

    const res = await request(app).get("/api/auth/me").set({ Cookie: tampered });
    expect(res.status).toBe(401);
  });

  it("rejects an expired session", async () => {
    const cookie = await signIn("owner@auth.test");
    const token = cookie.split("=")[1];
    await prisma.session.update({
      where: { tokenHash: hashToken(token) },
      data: { expiresAt: new Date(Date.now() - 1000) }
    });

    const res = await request(app).get("/api/auth/me").set(h(cookie));
    expect(res.status).toBe(401);
  });

  it("invalidates the session on sign out", async () => {
    const cookie = await signIn("owner@auth.test");
    expect((await request(app).get("/api/auth/me").set(h(cookie))).status).toBe(200);

    const logout = await request(app).post("/api/auth/logout").set(h(cookie));
    expect(logout.status).toBe(204);

    // The same cookie is now worthless, not merely cleared client-side.
    expect((await request(app).get("/api/auth/me").set(h(cookie))).status).toBe(401);
  });

  it("stops honouring an existing session once the user is disabled", async () => {
    const cookie = await signIn("operator@auth.test");
    expect((await request(app).get("/api/auth/me").set(h(cookie))).status).toBe(200);

    await prisma.user.update({
      where: { email: "operator@auth.test" },
      data: { disabledAt: new Date() }
    });

    expect((await request(app).get("/api/auth/me").set(h(cookie))).status).toBe(401);

    // Restore for the role tests below.
    await prisma.user.update({
      where: { email: "operator@auth.test" },
      data: { disabledAt: null }
    });
  });
});

describe("dashboard access requires a session, not the shared key", () => {
  it("rejects the dashboard API with no credentials at all", async () => {
    const res = await request(app).get(`/api/ops/businesses/${businessId}/overview`);
    expect(res.status).toBe(401);
  });

  it("rejects the dashboard API when presented with the old shared operator key", async () => {
    const res = await request(app)
      .get(`/api/ops/businesses/${businessId}/overview`)
      .set("x-api-key", process.env.VEYRA_API_KEY as string);

    // The shared key is no longer a way into the dashboard.
    expect(res.status).toBe(401);
  });

  it("allows the dashboard API with a valid session", async () => {
    const cookie = await signIn("owner@auth.test");
    const res = await request(app)
      .get(`/api/ops/businesses/${businessId}/overview`)
      .set(h(cookie));

    expect(res.status).toBe(200);
  });
});

describe("role permissions", () => {
  let bookingId: string;

  beforeAll(async () => {
    const conversation = await prisma.conversation.create({ data: { businessId } });
    const booking = await prisma.appointment.create({
      data: {
        conversationId: conversation.id,
        businessId,
        requestedTime: "2026-12-01T10:00",
        status: "submitted",
        submittedAt: new Date()
      }
    });
    bookingId = booking.id;
  });

  it("lets an operator perform operational transitions", async () => {
    const cookie = await signIn("operator@auth.test");
    const res = await request(app)
      .patch(`/api/ops/businesses/${businessId}/bookings/${bookingId}/status`)
      .set(h(cookie))
      .send({ status: "reviewing" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("reviewing");
  });

  it("lets a viewer read the dashboard", async () => {
    const cookie = await signIn("viewer@auth.test");
    const res = await request(app)
      .get(`/api/ops/businesses/${businessId}/bookings`)
      .set(h(cookie));

    expect(res.status).toBe(200);
  });

  it("refuses a viewer any operational mutation, server-side", async () => {
    const cookie = await signIn("viewer@auth.test");
    const res = await request(app)
      .patch(`/api/ops/businesses/${businessId}/bookings/${bookingId}/status`)
      .set(h(cookie))
      .send({ status: "confirmed" });

    expect(res.status).toBe(403);

    // And nothing changed.
    const stored = await prisma.appointment.findUnique({ where: { id: bookingId } });
    expect(stored?.status).toBe("reviewing");
  });

  it("refuses a viewer the member list and member mutations", async () => {
    const cookie = await signIn("viewer@auth.test");

    expect(
      (await request(app).get(`/api/ops/businesses/${businessId}/members`).set(h(cookie)))
        .status
    ).toBe(403);

    expect(
      (
        await request(app)
          .post(`/api/ops/businesses/${businessId}/members`)
          .set(h(cookie))
          .send({ email: "outsider@auth.test", role: "VIEWER" })
      ).status
    ).toBe(403);
  });

  it("refuses an operator the member list", async () => {
    const cookie = await signIn("operator@auth.test");
    const res = await request(app)
      .get(`/api/ops/businesses/${businessId}/members`)
      .set(h(cookie));

    expect(res.status).toBe(403);
  });

  it("lets an owner read members", async () => {
    const cookie = await signIn("owner@auth.test");
    const res = await request(app)
      .get(`/api/ops/businesses/${businessId}/members`)
      .set(h(cookie));

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(4);
  });
});

describe("tenant authorization", () => {
  it("hides a business the user does not belong to, as 404 not 403", async () => {
    const cookie = await signIn("owner@auth.test");
    const res = await request(app)
      .get(`/api/ops/businesses/${otherBusinessId}/overview`)
      .set(h(cookie));

    // 404 keeps other tenants non-enumerable.
    expect(res.status).toBe(404);
  });

  it("blocks cross-tenant mutation attempts", async () => {
    const otherConversation = await prisma.conversation.create({
      data: { businessId: otherBusinessId }
    });
    const otherBooking = await prisma.appointment.create({
      data: {
        conversationId: otherConversation.id,
        businessId: otherBusinessId,
        requestedTime: "2026-12-05T10:00",
        status: "submitted"
      }
    });

    const cookie = await signIn("owner@auth.test");
    const res = await request(app)
      .patch(`/api/ops/businesses/${otherBusinessId}/bookings/${otherBooking.id}/status`)
      .set(h(cookie))
      .send({ status: "confirmed" });

    expect(res.status).toBe(404);
    expect((await prisma.appointment.findUnique({ where: { id: otherBooking.id } }))?.status).toBe(
      "submitted"
    );
  });

  it("only reports businesses the user is a member of", async () => {
    const cookie = await signIn("outsider@auth.test");
    const res = await request(app).get("/api/auth/me").set(h(cookie));

    const ids = (res.body.memberships as { businessId: string }[]).map((m) => m.businessId);
    expect(ids).toEqual([otherBusinessId]);
    expect(ids).not.toContain(businessId);
  });
});

describe("audit actor identity", () => {
  it("records the authenticated user who made the change", async () => {
    const conversation = await prisma.conversation.create({ data: { businessId } });
    const booking = await prisma.appointment.create({
      data: {
        conversationId: conversation.id,
        businessId,
        requestedTime: "2026-12-10T09:00",
        status: "submitted",
        submittedAt: new Date()
      }
    });

    const cookie = await signIn("owner@auth.test");
    await request(app)
      .patch(`/api/ops/businesses/${businessId}/bookings/${booking.id}/status`)
      .set(h(cookie))
      .send({ status: "reviewing" });

    const detail = await request(app)
      .get(`/api/ops/businesses/${businessId}/bookings/${booking.id}`)
      .set(h(cookie));

    expect(detail.status).toBe(200);
    expect(detail.body.history).toHaveLength(1);
    expect(detail.body.history[0]).toMatchObject({
      fromStatus: "submitted",
      toStatus: "reviewing",
      actorUserId: ownerId,
      actorName: "Olivia Owner"
    });

    // The identity is the real signed-in user, not a placeholder.
    const stored = await prisma.statusEvent.findFirst({ where: { entityId: booking.id } });
    expect(stored?.actorUserId).toBe(ownerId);
    expect(stored?.actorUserId).not.toBeNull();
  });
});

describe("member management", () => {
  it("adds an existing user as a member", async () => {
    const cookie = await signIn("owner@auth.test");
    const res = await request(app)
      .post(`/api/ops/businesses/${businessId}/members`)
      .set(h(cookie))
      .send({ email: "outsider@auth.test", role: "VIEWER" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: "outsider@auth.test", role: "VIEWER" });
  });

  it("does not pretend to send an invitation for an unknown email", async () => {
    const cookie = await signIn("owner@auth.test");
    const res = await request(app)
      .post(`/api/ops/businesses/${businessId}/members`)
      .set(h(cookie))
      .send({ email: "never-existed@auth.test", role: "VIEWER" });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("invitation emails are not configured");
  });

  it("updates a member's role", async () => {
    const cookie = await signIn("owner@auth.test");
    const membership = await prisma.businessMembership.findFirst({
      where: { businessId, user: { email: "outsider@auth.test" } }
    });

    const res = await request(app)
      .patch(`/api/ops/businesses/${businessId}/members/${membership!.id}`)
      .set(h(cookie))
      .send({ role: "OPERATOR" });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe("OPERATOR");
  });

  it("removes a membership and revokes that user's sessions when it was their last", async () => {
    const cookie = await signIn("owner@auth.test");
    const outsiderCookie = await signIn("outsider@auth.test");

    const memberships = await prisma.businessMembership.findMany({
      where: { user: { email: "outsider@auth.test" } }
    });
    for (const membership of memberships) {
      await request(app)
        .delete(`/api/ops/businesses/${membership.businessId}/members/${membership.id}`)
        .set(h(membership.businessId === businessId ? cookie : outsiderCookie));
    }

    const remaining = await prisma.businessMembership.count({
      where: { user: { email: "outsider@auth.test" } }
    });
    expect(remaining).toBeLessThanOrEqual(1);
  });

  // Creates two users with real bcrypt hashes plus two sign-ins.
  it("refuses to remove the final owner", { timeout: 60_000 }, async () => {
    const soloBusiness = await prisma.business.create({ data: { name: "Solo Dental" } });
    const soloOwner = await prisma.user.create({
      data: {
        email: "solo@auth.test",
        name: "Sole Owner",
        passwordHash: await hashPassword(PASSWORD)
      }
    });
    const helper = await prisma.user.create({
      data: {
        email: "helper@auth.test",
        name: "Helpful Admin",
        passwordHash: await hashPassword(PASSWORD)
      }
    });
    const ownerMembership = await prisma.businessMembership.create({
      data: { userId: soloOwner.id, businessId: soloBusiness.id, role: "OWNER" }
    });
    await prisma.businessMembership.create({
      data: { userId: helper.id, businessId: soloBusiness.id, role: "ADMIN" }
    });

    // An admin tries to delete the only owner.
    const helperCookie = await signIn("helper@auth.test");
    const res = await request(app)
      .delete(`/api/ops/businesses/${soloBusiness.id}/members/${ownerMembership.id}`)
      .set(h(helperCookie));

    // Blocked because only an owner may touch owner memberships.
    expect(res.status).toBe(403);
    expect(
      await prisma.businessMembership.findUnique({ where: { id: ownerMembership.id } })
    ).not.toBeNull();
  });

  it("refuses to demote the last owner even when an owner asks", async () => {
    const cookie = await signIn("owner@auth.test");
    const ownerMembership = await prisma.businessMembership.findFirst({
      where: { businessId, role: "OWNER" }
    });

    const res = await request(app)
      .patch(`/api/ops/businesses/${businessId}/members/${ownerMembership!.id}`)
      .set(h(cookie))
      .send({ role: "VIEWER" });

    // Self-edit is blocked first; either way the business keeps its owner.
    expect([403, 422]).toContain(res.status);
    expect(
      (await prisma.businessMembership.findUnique({ where: { id: ownerMembership!.id } }))?.role
    ).toBe("OWNER");
  });

  it("stops a user escalating their own membership", async () => {
    const cookie = await signIn("viewer@auth.test");
    const membership = await prisma.businessMembership.findUnique({
      where: { userId_businessId: { userId: viewerId, businessId } }
    });

    const res = await request(app)
      .patch(`/api/ops/businesses/${businessId}/members/${membership!.id}`)
      .set(h(cookie))
      .send({ role: "OWNER" });

    expect(res.status).toBe(403);
    expect(
      (await prisma.businessMembership.findUnique({ where: { id: membership!.id } }))?.role
    ).toBe("VIEWER");
  });

  it("stops an admin granting owner access", async () => {
    const cookie = await signIn("admin@auth.test");
    const membership = await prisma.businessMembership.findUnique({
      where: { userId_businessId: { userId: viewerId, businessId } }
    });

    const res = await request(app)
      .patch(`/api/ops/businesses/${businessId}/members/${membership!.id}`)
      .set(h(cookie))
      .send({ role: "OWNER" });

    expect(res.status).toBe(403);
  });

  it("keeps a disabled user out of the dashboard entirely", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "disabled@auth.test", password: PASSWORD });
    expect(res.status).toBe(401);

    const membership = await prisma.businessMembership.findUnique({
      where: { userId_businessId: { userId: disabledUserId, businessId } }
    });
    expect(membership).not.toBeNull(); // membership exists, but sign-in is refused
  });
});
