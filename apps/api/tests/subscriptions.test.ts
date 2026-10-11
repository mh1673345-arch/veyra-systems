import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { DateTime } from "luxon";
import {
  DEGRADED_ENTITLEMENTS,
  ENTITLEMENT_DEFINITIONS,
  PLAN_CATALOG,
  lowestPlanWith,
  planIncludes
} from "@veyra/shared";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { CSRF_COOKIE, hashPassword } from "../src/services/auth/sessions.js";
import {
  accessFor,
  changePlan,
  effectiveCapabilitiesFor,
  limitUsage
} from "../src/services/access/accessService.js";
import { calendarStatus, checkAvailability } from "../src/services/calendar/service.js";
import { cancelCalendarBooking, confirmHeldBooking, holdSlot } from "../src/services/calendar/bookings.js";
import { decryptSecret } from "../src/services/crypto/secretBox.js";
import {
  TZ,
  at,
  createCalendarBusiness,
  fakeCalendarProvider,
  resetFakeCalendar
} from "./helpers/calendarFixtures.js";

/**
 * Subscriptions, entitlements and limits — through the real AccessService, the
 * real CalendarService and real HTTP. The backend is the authority; nothing
 * here relies on the Console hiding a button.
 */

const app = createApp();
const PASSWORD = "subscription-suite-password";
const apiKey = process.env.VEYRA_API_KEY as string;

interface Session {
  cookie: string;
  csrf: string;
}
const authed = (r: request.Test, session: Session) =>
  r.set({ Cookie: session.cookie, "x-csrf-token": session.csrf });

async function signIn(email: string): Promise<Session> {
  const res = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  const cookies = res.headers["set-cookie"] as unknown as string[];
  return {
    cookie: cookies.map((cookie) => cookie.split(";")[0]).join("; "),
    csrf: cookies.find((cookie) => cookie.startsWith(CSRF_COOKIE))!.split(";")[0].split("=")[1]
  };
}

let passwordHash: string;
const sessions: Record<string, Session> = {};
let starterId: string;
let proId: string;
let userIds: Record<string, string> = {};

/** A member of `businessId` with `role`, signed in. */
async function member(businessId: string, role: string, label: string): Promise<Session> {
  const user = await prisma.user.create({
    data: { email: `${label}@subscription.test`, name: label, passwordHash }
  });
  userIds[label] = user.id;
  await prisma.businessMembership.create({ data: { userId: user.id, businessId, role } });
  return signIn(user.email);
}

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: "@subscription.test" } } });
  passwordHash = await hashPassword(PASSWORD);
  userIds = {};

  starterId = (await createCalendarBusiness({ plan: "STARTER", namePrefix: "Starter" })).businessId;
  proId = (await createCalendarBusiness({ plan: "PRO", namePrefix: "Pro" })).businessId;

  sessions.starterOwner = await member(starterId, "OWNER", "starter-owner");
  sessions.starterOperator = await member(starterId, "OPERATOR", "starter-operator");
  sessions.proOwner = await member(proId, "OWNER", "pro-owner");
  sessions.proAdmin = await member(proId, "ADMIN", "pro-admin");
  sessions.proOperator = await member(proId, "OPERATOR", "pro-operator");
  sessions.proViewer = await member(proId, "VIEWER", "pro-viewer");
}, 120_000);

beforeEach(() => {
  resetFakeCalendar();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** The next weekday at 2pm in New York, and how a caller would say it. */
function nextWeekdaySlot() {
  let day = DateTime.now().setZone(TZ).startOf("day").plus({ days: 1 });
  while (day.weekday > 5) day = day.plus({ days: 1 });
  const start = day.set({ hour: 14 });
  return { start: start.toJSDate(), phrase: `${start.toFormat("cccc").toLowerCase()} at 2pm` };
}

async function say(conversationId: string, text: string) {
  const res = await request(app)
    .post(`/api/conversations/${conversationId}/messages`)
    .set("x-api-key", apiKey)
    .send({ text });
  expect(res.status).toBe(201);
  return res.body as {
    receptionistMessage: { text: string };
    actionResult: { action: string; status: string; message?: string };
  };
}

describe("plan matrix", () => {
  const STARTER_INCLUDED = [
    "core_reception",
    "business_knowledge",
    "service_answers",
    "pricing_answers",
    "booking_requests",
    "human_escalation",
    "console_access"
  ] as const;
  const PRO_ADDS = [
    "calendar_availability",
    "calendar_booking",
    "calendar_reschedule",
    "calendar_cancellation",
    "advanced_integrations"
  ] as const;
  const MAX_ADDS = ["voice_reception", "voice_inbound", "voice_outbound", "advanced_automation"] as const;

  it("Starter — Answer: the core receptionist, no calendar, no voice", () => {
    for (const key of STARTER_INCLUDED) expect(planIncludes("STARTER", key), key).toBe(true);
    for (const key of [...PRO_ADDS, ...MAX_ADDS]) expect(planIncludes("STARTER", key), key).toBe(false);
    expect(PLAN_CATALOG.STARTER.tagline).toBe("Answer");
  });

  it("Pro — Act: everything in Starter plus live calendar", () => {
    for (const key of [...STARTER_INCLUDED, ...PRO_ADDS]) expect(planIncludes("PRO", key), key).toBe(true);
    for (const key of MAX_ADDS) expect(planIncludes("PRO", key), key).toBe(false);
    expect(PLAN_CATALOG.PRO.tagline).toBe("Act");
  });

  it("Max — Speak: everything in Pro plus voice and automation", () => {
    for (const key of [...STARTER_INCLUDED, ...PRO_ADDS, ...MAX_ADDS]) {
      expect(planIncludes("MAX", key), key).toBe(true);
    }
    expect(PLAN_CATALOG.MAX.tagline).toBe("Speak");
  });

  it("keeps WhatsApp and SMS defined but on no plan until channel strategy is set", () => {
    for (const key of ["whatsapp", "sms"] as const) {
      expect(ENTITLEMENT_DEFINITIONS.some((definition) => definition.key === key)).toBe(true);
      expect(lowestPlanWith(key)).toBeNull();
    }
  });

  it("names the lowest plan that includes a feature", () => {
    expect(lowestPlanWith("booking_requests")).toBe("STARTER");
    expect(lowestPlanWith("calendar_booking")).toBe("PRO");
    expect(lowestPlanWith("voice_inbound")).toBe("MAX");
  });

  it("marks features that are included but not built yet, rather than implying they work", () => {
    const voice = ENTITLEMENT_DEFINITIONS.find((definition) => definition.key === "voice_reception")!;
    expect(voice.implemented).toBe(false);
  });

  it("represents unlimited explicitly, not as a large number", () => {
    expect(PLAN_CATALOG.MAX.limits.team_members).toEqual({ kind: "unlimited" });
    expect(PLAN_CATALOG.STARTER.limits.team_members).toEqual({ kind: "count", value: 3 });
  });
});

describe("subscription status policy", () => {
  it("trialing and active get the plan's entitlements", async () => {
    for (const status of ["trialing", "active"] as const) {
      const { businessId } = await createCalendarBusiness({ plan: "PRO", subscriptionStatus: status });
      const access = await accessFor(businessId);
      expect(access.entitlements.has("calendar_booking"), status).toBe(true);
      expect(access.degraded).toBe(false);
    }
  });

  it("past_due keeps service running but flags billing attention", async () => {
    const { businessId } = await createCalendarBusiness({ plan: "PRO", subscriptionStatus: "past_due" });
    const access = await accessFor(businessId);

    expect(access.entitlements.has("calendar_booking")).toBe(true);
    expect(access.degraded).toBe(false);
    expect(access.billingAttention).toBe(true);
    expect((await calendarStatus(businessId)).live).toBe(true);
  });

  it("cancelled and expired keep core Reception but switch paid features off", async () => {
    for (const status of ["cancelled", "expired"] as const) {
      const { businessId } = await createCalendarBusiness({ plan: "PRO", subscriptionStatus: status });
      const access = await accessFor(businessId);

      expect(access.degraded, status).toBe(true);
      expect(access.entitlements.has("calendar_booking"), status).toBe(false);
      // Callers are never abandoned.
      expect(access.entitlements.has("core_reception"), status).toBe(true);
      expect(access.entitlements.has("booking_requests"), status).toBe(true);
      expect(access.entitlements.has("human_escalation"), status).toBe(true);
      expect((await calendarStatus(businessId)).live, status).toBe(false);
    }
  });

  it("a business with no subscription at all is treated as lapsed, not as paid", async () => {
    const { businessId } = await createCalendarBusiness({ plan: null });
    const access = await accessFor(businessId);

    expect(access.status).toBe("none");
    expect([...access.entitlements].sort()).toEqual([...DEGRADED_ENTITLEMENTS].sort());
  });
});

describe("entitlement vs configuration", () => {
  it("Starter with the calendar flag switched on still has no live calendar", async () => {
    const { businessId } = await createCalendarBusiness({ plan: "STARTER", calendarBooking: true });

    expect((await effectiveCapabilitiesFor(businessId)).calendar_booking).toBe(false);
    const status = await calendarStatus(businessId);
    expect(status.capabilityEnabled).toBe(true);
    expect(status.entitled).toBe(false);
    expect(status.live).toBe(false);
  });

  it("Pro with the calendar flag off has no live calendar", async () => {
    const { businessId } = await createCalendarBusiness({ plan: "PRO", calendarBooking: false });

    expect((await effectiveCapabilitiesFor(businessId)).calendar_booking).toBe(false);
    expect((await calendarStatus(businessId)).live).toBe(false);
  });

  it("Pro with no connection has no live calendar", async () => {
    const { businessId } = await createCalendarBusiness({ plan: "PRO", connect: false });
    const status = await calendarStatus(businessId);
    expect(status.entitled).toBe(true);
    expect(status.live).toBe(false);
  });

  it("Pro with the flag on and a healthy connection is live", async () => {
    const { businessId } = await createCalendarBusiness({ plan: "PRO" });
    expect((await calendarStatus(businessId)).live).toBe(true);
  });

  it("Max with a healthy connection is live", async () => {
    const { businessId } = await createCalendarBusiness({ plan: "MAX" });
    expect((await calendarStatus(businessId)).live).toBe(true);
  });

  it("does not switch on voice for Max just because the plan includes it", async () => {
    const { businessId } = await createCalendarBusiness({ plan: "MAX" });
    const access = await accessFor(businessId);
    expect(access.entitlements.has("voice_reception")).toBe(true);
    // There is no voice capability to configure yet, so nothing is "available".
    const capabilities = await effectiveCapabilitiesFor(businessId);
    expect(Object.keys(capabilities)).not.toContain("voice_reception");
  });
});

describe("the caller-facing flow by plan", () => {
  it("Starter with a configured calendar stays request-only, and never mentions plans", async () => {
    const fixture = await createCalendarBusiness({ plan: "STARTER" });
    const slot = nextWeekdaySlot();

    const reply = await say(fixture.conversationId, `Book me ${slot.phrase}`);

    expect(reply.actionResult.action).not.toBe("check_calendar_availability");
    expect(reply.receptionistMessage.text).not.toMatch(/is available/i);
    expect(reply.receptionistMessage.text).not.toMatch(/upgrade|\bplan\b|subscription|\bpro\b|starter/i);
    expect(await prisma.appointment.count({ where: { conversationId: fixture.conversationId } })).toBe(0);
    expect(fakeCalendarProvider.listEvents()).toEqual([]);
  });

  it("Pro without a connection stays request-only", async () => {
    const fixture = await createCalendarBusiness({ plan: "PRO", connect: false });
    const reply = await say(fixture.conversationId, `Book me ${nextWeekdaySlot().phrase}`);
    expect(reply.receptionistMessage.text).not.toMatch(/is available/i);
  });

  it("Pro with a connection checks live availability", async () => {
    const fixture = await createCalendarBusiness({ plan: "PRO" });
    const reply = await say(fixture.conversationId, `Book me ${nextWeekdaySlot().phrase}`);
    expect(reply.actionResult.action).toBe("check_calendar_availability");
    expect(reply.receptionistMessage.text).toMatch(/is available/i);
  });

  it("Max with a connection checks live availability", async () => {
    const fixture = await createCalendarBusiness({ plan: "MAX" });
    const reply = await say(fixture.conversationId, `Book me ${nextWeekdaySlot().phrase}`);
    expect(reply.actionResult.action).toBe("check_calendar_availability");
  });

  it("a cancelled Pro subscription degrades gracefully to request-only", async () => {
    const fixture = await createCalendarBusiness({ plan: "PRO", subscriptionStatus: "cancelled" });
    const reply = await say(fixture.conversationId, `Book me ${nextWeekdaySlot().phrase}`);

    expect(reply.receptionistMessage.text).not.toMatch(/is available/i);
    expect(reply.receptionistMessage.text).not.toMatch(/upgrade|subscription|cancelled/i);
    // Core Reception still answers.
    const pricing = await say(fixture.conversationId, "how much is teeth whitening?");
    expect(pricing.receptionistMessage.text).toContain("$250");
  });
});

describe("server-side enforcement", () => {
  it("rejects a Starter business calling calendar endpoints directly, with a stable error", async () => {
    const connect = await authed(
      request(app).post(`/api/ops/businesses/${starterId}/calendar/connect`),
      sessions.starterOwner
    );
    expect(connect.status).toBe(403);
    expect(connect.body).toEqual({
      error: expect.any(String),
      code: "ENTITLEMENT_REQUIRED",
      entitlement: "calendar_booking",
      requiredPlan: "PRO"
    });

    const list = await authed(
      request(app).get(`/api/ops/businesses/${starterId}/calendar/calendars`),
      sessions.starterOwner
    );
    expect(list.status).toBe(403);
    expect(list.body.code).toBe("ENTITLEMENT_REQUIRED");

    const select = await authed(
      request(app).post(`/api/ops/businesses/${starterId}/calendar/select`),
      sessions.starterOwner
    ).send({ calendarId: "secondary" });
    expect(select.status).toBe(403);
    expect(select.body.code).toBe("ENTITLEMENT_REQUIRED");
  });

  it("exposes no internals in the entitlement error", async () => {
    const res = await authed(
      request(app).post(`/api/ops/businesses/${starterId}/calendar/connect`),
      sessions.starterOwner
    );
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/prisma|stack|subscriptionId|businessId|sql/i);
  });

  it("allows a Pro business through the same endpoints", async () => {
    const list = await authed(
      request(app).get(`/api/ops/businesses/${proId}/calendar/calendars`),
      sessions.proOwner
    );
    expect(list.status).toBe(200);
  });

  it("ignores anything the client claims about its plan", async () => {
    const res = await authed(
      request(app)
        .post(`/api/ops/businesses/${starterId}/calendar/select`)
        .set("x-veyra-plan", "PRO"),
      sessions.starterOwner
    ).send({ calendarId: "primary", plan: "PRO", entitlements: ["calendar_booking"] });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ENTITLEMENT_REQUIRED");
  });

  it("still lets a Starter business disconnect stored calendar credentials", async () => {
    const { businessId } = await createCalendarBusiness({ plan: "STARTER", namePrefix: "Starter disconnect" });
    const owner = await member(businessId, "OWNER", `starter-disconnect-${Date.now()}`);

    const res = await authed(
      request(app).post(`/api/ops/businesses/${businessId}/calendar/disconnect`),
      owner
    );
    expect(res.status).toBe(200);
    const row = await prisma.calendarConnection.findFirstOrThrow({ where: { businessId } });
    expect(row.accessTokenEnc).toBeNull();
  }, 30_000);

  it("shows the locked state in calendar settings instead of pretending", async () => {
    const res = await authed(
      request(app).get(`/api/ops/businesses/${starterId}/calendar`),
      sessions.starterOperator
    );
    expect(res.status).toBe(200);
    expect(res.body.entitled).toBe(false);
    expect(res.body.requiredPlan).toBe("PRO");
    expect(res.body.live).toBe(false);
  });
});

describe("downgrade and upgrade", () => {
  it("Pro → Starter keeps existing bookings, events and credentials, and stops new live booking", async () => {
    const fixture = await createCalendarBusiness({ plan: "PRO", namePrefix: "Downgrade" });
    const owner = await member(fixture.businessId, "OWNER", `downgrade-owner-${Date.now()}`);
    const now = at("2026-10-05T09:00");

    // A confirmed future booking made while on Pro.
    const availability = await checkAvailability({
      businessId: fixture.businessId,
      serviceId: fixture.serviceId,
      startTime: at("2026-10-06T15:00"),
      now
    });
    const held = await holdSlot({
      businessId: fixture.businessId,
      conversationId: fixture.conversationId,
      serviceId: fixture.serviceId,
      serviceName: fixture.serviceName,
      start: availability.slot!.start,
      end: availability.slot!.end,
      timezone: availability.timezone,
      requestedTimeText: "Tuesday",
      now
    });
    await confirmHeldBooking({ appointmentId: held.appointment.id, now });
    const connectionBefore = await prisma.calendarConnection.findFirstOrThrow({
      where: { businessId: fixture.businessId }
    });

    // Downgrade.
    await changePlan({ businessId: fixture.businessId, plan: "STARTER", actorType: "admin_script", reason: "test" });

    // Existing booking and its external event are untouched.
    const booking = await prisma.appointment.findUniqueOrThrow({ where: { id: held.appointment.id } });
    expect(booking.status).toBe("confirmed");
    expect(booking.externalEventId).not.toBeNull();
    expect(fakeCalendarProvider.listEvents()[0].status).toBe("confirmed");

    // The connection and its encrypted credentials are still stored.
    const connectionAfter = await prisma.calendarConnection.findFirstOrThrow({
      where: { businessId: fixture.businessId }
    });
    expect(connectionAfter.status).toBe("connected");
    expect(connectionAfter.accessTokenEnc).toBe(connectionBefore.accessTokenEnc);
    expect(decryptSecret(connectionAfter.accessTokenEnc!)).toBe("test-access-token");

    // But it is not live, and new live booking is refused.
    expect((await calendarStatus(fixture.businessId)).live).toBe(false);
    const reply = await say(fixture.conversationId, `Book me ${nextWeekdaySlot().phrase}`);
    expect(reply.receptionistMessage.text).not.toMatch(/is available/i);
    expect(fakeCalendarProvider.listEvents()).toHaveLength(1);

    // The operator sees the restriction.
    const settings = await authed(
      request(app).get(`/api/ops/businesses/${fixture.businessId}/calendar`),
      owner
    );
    expect(settings.body.entitled).toBe(false);

    // Lapsed-plan cleanup: a confirmed booking Veyra put in the calendar while
    // on Pro can still be cancelled by staff, so no event is left orphaned.
    // This is not a Starter entitlement (see the next test).
    const cancel = await authed(
      request(app).patch(`/api/ops/businesses/${fixture.businessId}/bookings/${booking.id}/status`),
      owner
    ).send({ status: "cancelled" });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe("cancelled");
    expect(fakeCalendarProvider.listEvents()[0].status).toBe("cancelled");
    const audit = await prisma.statusEvent.findFirstOrThrow({
      where: { entityId: booking.id, toStatus: "cancelled" }
    });
    expect(audit.note).toMatch(/previous plan/);
    // Still not live: the exception did not switch calendar booking back on.
    expect((await calendarStatus(fixture.businessId)).live).toBe(false);
  }, 60_000);

  it("the lapsed-plan exception is narrow: callers, pending holds and non-Veyra bookings stay locked", async () => {
    const fixture = await createCalendarBusiness({ plan: "PRO", namePrefix: "Narrow" });
    const now = at("2026-10-05T09:00");
    const held = await holdSlot({
      businessId: fixture.businessId,
      conversationId: fixture.conversationId,
      serviceId: fixture.serviceId,
      serviceName: fixture.serviceName,
      start: at("2026-10-06T15:00"),
      end: at("2026-10-06T16:00"),
      timezone: fixture.timezone,
      requestedTimeText: "Tuesday",
      now
    });
    await confirmHeldBooking({ appointmentId: held.appointment.id, now });
    await changePlan({ businessId: fixture.businessId, plan: "STARTER", actorType: "admin_script" });

    // A caller-side cancel (no operator exception) is still refused.
    expect((await cancelCalendarBooking({ appointmentId: held.appointment.id, reason: "caller" })).status).toBe(
      "not_entitled"
    );
    // A confirmed calendar booking without an external event is refused too.
    await prisma.appointment.update({ where: { id: held.appointment.id }, data: { externalEventId: null } });
    expect(
      (await cancelCalendarBooking({ appointmentId: held.appointment.id, allowLapsedPlanCleanup: true })).status
    ).toBe("not_entitled");
    expect(fakeCalendarProvider.listEvents()[0].status).toBe("confirmed");
  });

  it("a slot held before a downgrade cannot be confirmed after it", async () => {
    const fixture = await createCalendarBusiness({ plan: "PRO" });
    const now = at("2026-10-05T09:00");
    const held = await holdSlot({
      businessId: fixture.businessId,
      conversationId: fixture.conversationId,
      serviceId: fixture.serviceId,
      serviceName: fixture.serviceName,
      start: at("2026-10-06T15:00"),
      end: at("2026-10-06T16:00"),
      timezone: fixture.timezone,
      requestedTimeText: "Tuesday",
      now
    });

    await changePlan({ businessId: fixture.businessId, plan: "STARTER", actorType: "admin_script" });

    expect((await confirmHeldBooking({ appointmentId: held.appointment.id, now })).status).toBe("not_entitled");
    expect(fakeCalendarProvider.listEvents()).toEqual([]);
  });

  it("Starter → Pro unlocks the stored connection immediately, without reconnecting", async () => {
    const fixture = await createCalendarBusiness({ plan: "STARTER" });
    const before = await prisma.calendarConnection.findFirstOrThrow({ where: { businessId: fixture.businessId } });
    expect((await calendarStatus(fixture.businessId)).live).toBe(false);

    await changePlan({ businessId: fixture.businessId, plan: "PRO", actorType: "admin_script" });

    expect((await calendarStatus(fixture.businessId)).live).toBe(true);
    const after = await prisma.calendarConnection.findFirstOrThrow({ where: { businessId: fixture.businessId } });
    // Same connection, same credentials: nothing was re-entered.
    expect(after.id).toBe(before.id);
    expect(after.accessTokenEnc).toBe(before.accessTokenEnc);

    const reply = await say(fixture.conversationId, `Book me ${nextWeekdaySlot().phrase}`);
    expect(reply.receptionistMessage.text).toMatch(/is available/i);
  });
});

describe("limits", () => {
  it("enforces the Starter team-member limit, and names the plan that allows more", async () => {
    const { businessId } = await createCalendarBusiness({ plan: "STARTER", namePrefix: "Team limit" });
    const owner = await member(businessId, "OWNER", `limit-owner-${Date.now()}`);
    await member(businessId, "OPERATOR", `limit-op1-${Date.now()}`);
    await member(businessId, "VIEWER", `limit-view-${Date.now()}`);
    expect(await prisma.businessMembership.count({ where: { businessId } })).toBe(3);

    const extra = await prisma.user.create({
      data: { email: `limit-extra-${Date.now()}@subscription.test`, name: "Extra", passwordHash }
    });
    const res = await authed(request(app).post(`/api/ops/businesses/${businessId}/members`), owner).send({
      email: extra.email,
      role: "OPERATOR"
    });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: expect.stringMatching(/3 team members/i),
      code: "PLAN_LIMIT_REACHED",
      limit: "team_members",
      allowed: 3,
      requiredPlan: "PRO"
    });
    expect(await prisma.businessMembership.count({ where: { businessId } })).toBe(3);
  }, 60_000);

  it("keeps owner-safety rules intact at the limit", async () => {
    const { businessId } = await createCalendarBusiness({ plan: "STARTER", namePrefix: "Owner safety" });
    const owner = await member(businessId, "OWNER", `safety-owner-${Date.now()}`);
    const ownerMembership = await prisma.businessMembership.findFirstOrThrow({
      where: { businessId, role: "OWNER" }
    });

    // Removing the only owner is still refused — the limit never weakens RBAC.
    const res = await authed(
      request(app).delete(`/api/ops/businesses/${businessId}/members/${ownerMembership.id}`),
      owner
    );
    expect([400, 403, 409, 422]).toContain(res.status);
    expect(await prisma.businessMembership.count({ where: { businessId, role: "OWNER" } })).toBe(1);
  }, 30_000);

  it("lets an unlimited plan grow past Starter's limit", async () => {
    const { businessId } = await createCalendarBusiness({ plan: "MAX", namePrefix: "Unlimited" });
    const owner = await member(businessId, "OWNER", `max-owner-${Date.now()}`);
    for (let i = 0; i < 3; i += 1) await member(businessId, "VIEWER", `max-viewer-${i}-${Date.now()}`);

    const extra = await prisma.user.create({
      data: { email: `max-extra-${Date.now()}@subscription.test`, name: "Extra", passwordHash }
    });
    const res = await authed(request(app).post(`/api/ops/businesses/${businessId}/members`), owner).send({
      email: extra.email,
      role: "VIEWER"
    });
    expect(res.status).toBe(201);
  }, 60_000);

  it("reports real usage, and unknown where no counter exists", async () => {
    const usage = await limitUsage(proId);
    const byKey = Object.fromEntries(usage.map((entry) => [entry.key, entry]));

    expect(byKey.team_members.used).toBe(await prisma.businessMembership.count({ where: { businessId: proId } }));
    expect(byKey.team_members.enforcement).toBe("enforced");
    expect(byKey.calendar_connections.used).toBe(1);
    // Voice minutes are counted from completed calls since Phase 13, so a
    // business with no calls really has used zero — that is a measurement, not
    // a placeholder.
    expect(byKey.monthly_voice_minutes.used).toBe(0);
    expect(byKey.monthly_voice_minutes.enforcement).toBe("enforced");
    // Locations still have no counter, so they stay unknown. Never a fake zero.
    expect(byKey.business_locations.used).toBeNull();
  });
});

describe("tenancy, roles and audit", () => {
  it("shows the subscription to owners and admins only", async () => {
    for (const [name, expected] of [
      ["proOwner", 200],
      ["proAdmin", 200],
      ["proOperator", 403],
      ["proViewer", 403]
    ] as const) {
      const res = await authed(request(app).get(`/api/ops/businesses/${proId}/subscription`), sessions[name]);
      expect(res.status, name).toBe(expected);
    }
  });

  it("returns the plan, status, features and usage from the enforced catalog", async () => {
    const res = await authed(request(app).get(`/api/ops/businesses/${proId}/subscription`), sessions.proOwner);

    expect(res.body.plan.code).toBe("PRO");
    expect(res.body.plan.tagline).toBe("Act");
    expect(res.body.status).toBe("active");
    expect(res.body.billingAvailable).toBe(false);
    const calendar = res.body.entitlements.find((entry: { key: string }) => entry.key === "calendar_booking");
    expect(calendar.included).toBe(true);
    const voice = res.body.entitlements.find((entry: { key: string }) => entry.key === "voice_reception");
    expect(voice).toMatchObject({ included: false, requiredPlan: "MAX", implemented: false });
    expect(res.body.plans.map((plan: { code: string }) => plan.code)).toEqual(["STARTER", "PRO", "MAX"]);
  });

  it("hides another business's subscription entirely", async () => {
    const res = await authed(request(app).get(`/api/ops/businesses/${proId}/subscription`), sessions.starterOwner);
    expect(res.status).toBe(404);
  });

  it("has no HTTP route that changes a plan, for any role", async () => {
    for (const method of ["post", "put", "patch"] as const) {
      // The API key gets past the reception middleware that answers unmatched
      // /api paths with 401, so this shows the route itself does not exist.
      const res = await authed(
        request(app)[method](`/api/ops/businesses/${starterId}/subscription`).set("x-api-key", apiKey),
        sessions.starterOwner
      ).send({ plan: "MAX" });
      expect(res.status, method).toBe(404);
    }
    expect((await accessFor(starterId)).plan).toBe("STARTER");
  });

  it("audits plan changes with the previous and new plan, status and actor", async () => {
    const { businessId } = await createCalendarBusiness({ plan: "STARTER", namePrefix: "Audit" });
    await changePlan({
      businessId,
      plan: "PRO",
      status: "trialing",
      actorType: "admin_script",
      actorUserId: userIds["pro-owner"],
      reason: "trial"
    });

    const event = await prisma.subscriptionEvent.findFirstOrThrow({
      where: { businessId, newPlan: "PRO" },
      orderBy: { createdAt: "desc" }
    });
    expect(event).toMatchObject({
      previousPlan: "STARTER",
      newPlan: "PRO",
      previousStatus: "active",
      newStatus: "trialing",
      actorType: "admin_script",
      actorUserId: userIds["pro-owner"]
    });
  });

  it("gives a newly created business an audited Starter subscription", async () => {
    const res = await request(app)
      .post("/api/businesses")
      .set("x-api-key", apiKey)
      .send({ name: `New Business ${Date.now()}` });
    expect(res.status).toBe(201);

    const access = await accessFor(res.body.id);
    expect(access.plan).toBe("STARTER");
    expect(access.status).toBe("active");
    expect(await prisma.subscriptionEvent.count({ where: { businessId: res.body.id, actorType: "system" } })).toBe(1);
  });
});
