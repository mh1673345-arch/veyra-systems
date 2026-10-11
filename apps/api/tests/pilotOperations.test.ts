import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { CSRF_COOKIE, hashPassword } from "../src/services/auth/sessions.js";
import { releaseExpiredHolds } from "../src/services/calendar/holds.js";
import { confirmHeldBooking, holdSlot, pendingHold } from "../src/services/calendar/bookings.js";
import { checkAvailability } from "../src/services/calendar/service.js";
import { executeCalendarAction, resolveCalendarAction } from "../src/services/actions/calendarActions.js";
import { isRescheduleRequest } from "../src/services/calendar/requestedTime.js";
import { DemoResetRefused, resetDemoBusiness, resolveDemoBusiness } from "../src/services/demo/demoBusiness.js";
import { at, createCalendarBusiness, fakeCalendarProvider, resetFakeCalendar } from "./helpers/calendarFixtures.js";

/**
 * Demo stability, expired holds and the rescheduling entry point.
 *
 * These are the three "known limitations" this phase was asked to close, so
 * each test states the behaviour that was wrong before: the newest business
 * hijacking the public demo, a lapsed hold living forever, and rescheduling
 * having no way in.
 */

const app = createApp();
const PASSWORD = "harbour-quay-lantern-4417";

interface Session {
  cookie: string;
  csrf: string;
}
const authed = (r: request.Test, session: Session) => r.set({ Cookie: session.cookie, "x-csrf-token": session.csrf });

let passwordHash: string;
let counter = 0;
const savedEnv = { ...process.env };

async function owner(businessId: string): Promise<Session> {
  counter += 1;
  const user = await prisma.user.create({
    data: { email: `owner-${counter}-${Date.now()}@ops.test`, name: "Owner", passwordHash }
  });
  await prisma.businessMembership.create({ data: { userId: user.id, businessId, role: "OWNER" } });
  const res = await request(app).post("/api/auth/login").send({ email: user.email, password: PASSWORD });
  const cookies = res.headers["set-cookie"] as unknown as string[];
  return {
    cookie: cookies.map((cookie) => cookie.split(";")[0]).join("; "),
    csrf: cookies.find((cookie) => cookie.startsWith(CSRF_COOKIE))!.split(";")[0].split("=")[1]
  };
}

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
}, 60_000);

beforeEach(() => {
  resetFakeCalendar();
  delete process.env.VEYRA_DEMO_BUSINESS_ID;
});

afterEach(() => {
  if (savedEnv.VEYRA_DEMO_BUSINESS_ID === undefined) delete process.env.VEYRA_DEMO_BUSINESS_ID;
  else process.env.VEYRA_DEMO_BUSINESS_ID = savedEnv.VEYRA_DEMO_BUSINESS_ID;
});

afterAll(async () => {
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */

describe("demo business stability", () => {
  it("uses the configured business, and a brand-new workspace cannot take over", async () => {
    const demo = await createCalendarBusiness({ plan: "PRO", namePrefix: "Demo" });
    await prisma.business.update({ where: { id: demo.businessId }, data: { receptionStatus: "active" } });
    process.env.VEYRA_DEMO_BUSINESS_ID = demo.businessId;

    // The exact failure this replaces: someone signs up and their workspace is
    // the newest row in the table.
    const newcomer = await createCalendarBusiness({ plan: "STARTER", namePrefix: "Newcomer" });
    await prisma.business.update({ where: { id: newcomer.businessId }, data: { receptionStatus: "active" } });

    const resolved = await resolveDemoBusiness();
    expect(resolved.businessId).toBe(demo.businessId);
    expect(resolved.source).toBe("configured");
    expect(resolved.pinned).toBe(true);

    const res = await request(app).get("/api/demo/business");
    expect(res.status).toBe(200);
    expect(res.body.businessId).toBe(demo.businessId);
  }, 60_000);

  it("falls back to the oldest presentable business, never the newest", async () => {
    const oldest = await prisma.business.findFirst({
      where: { receptionStatus: "active", services: { some: { active: true } } },
      orderBy: { createdAt: "asc" },
      select: { id: true }
    });
    const newcomer = await createCalendarBusiness({ plan: "STARTER", namePrefix: "Newer" });
    await prisma.business.update({ where: { id: newcomer.businessId }, data: { receptionStatus: "active" } });

    const resolved = await resolveDemoBusiness();
    expect(resolved.source).toBe("fallback");
    expect(resolved.businessId).not.toBe(newcomer.businessId);
    if (oldest) expect(resolved.businessId).toBe(oldest.id);
  }, 60_000);

  it("ignores a draft business or one with no services", async () => {
    const draft = await createCalendarBusiness({ plan: "PRO", namePrefix: "Draft" });
    await prisma.business.update({ where: { id: draft.businessId }, data: { receptionStatus: "draft" } });
    const resolved = await resolveDemoBusiness();
    expect(resolved.businessId).not.toBe(draft.businessId);
  }, 60_000);

  it("falls back loudly when the configured id doesn't exist", async () => {
    process.env.VEYRA_DEMO_BUSINESS_ID = "does-not-exist";
    const resolved = await resolveDemoBusiness();
    expect(resolved.pinned).toBe(false);
    expect(["fallback", "none"]).toContain(resolved.source);
  });
});

describe("demo reset safety", () => {
  it("refuses without a configured demo business, and for any other business", async () => {
    const business = await createCalendarBusiness({ plan: "PRO", namePrefix: "NotDemo" });

    await expect(resetDemoBusiness({ businessId: business.businessId })).rejects.toBeInstanceOf(DemoResetRefused);

    const other = await createCalendarBusiness({ plan: "PRO", namePrefix: "Other" });
    process.env.VEYRA_DEMO_BUSINESS_ID = other.businessId;
    await expect(resetDemoBusiness({ businessId: business.businessId })).rejects.toThrow(/not the configured demo business/i);
  }, 60_000);

  it("refuses in production and against a non-local database", async () => {
    const demo = await createCalendarBusiness({ plan: "PRO", namePrefix: "DemoGuard" });
    const env = { ...process.env, VEYRA_DEMO_BUSINESS_ID: demo.businessId };

    await expect(resetDemoBusiness({ businessId: demo.businessId, env: { ...env, NODE_ENV: "production" } })).rejects.toThrow(
      /production/i
    );
    await expect(
      resetDemoBusiness({
        businessId: demo.businessId,
        env: { ...env, DATABASE_URL: "postgresql://user:pw@db.example.com:5432/prod" }
      })
    ).rejects.toThrow(/local database/i);
  }, 60_000);

  it("clears the demo's activity, keeps its configuration, and leaves other businesses alone", async () => {
    const demo = await createCalendarBusiness({ plan: "PRO", namePrefix: "DemoReset" });
    const bystander = await createCalendarBusiness({ plan: "PRO", namePrefix: "Bystander" });
    process.env.VEYRA_DEMO_BUSINESS_ID = demo.businessId;

    await prisma.appointment.create({
      data: { businessId: demo.businessId, conversationId: demo.conversationId, requestedTime: "Tuesday", mode: "request", status: "submitted" }
    });
    await prisma.escalation.create({ data: { businessId: demo.businessId, conversationId: demo.conversationId, reason: "test" } });
    await prisma.appointment.create({
      data: { businessId: bystander.businessId, conversationId: bystander.conversationId, requestedTime: "Wednesday", mode: "request", status: "submitted" }
    });

    const result = await resetDemoBusiness({ businessId: demo.businessId });
    expect(result.deleted.conversations).toBeGreaterThanOrEqual(1);

    expect(await prisma.conversation.count({ where: { businessId: demo.businessId } })).toBe(0);
    expect(await prisma.appointment.count({ where: { businessId: demo.businessId } })).toBe(0);
    // Configuration survives: it is what makes the demo a demo.
    expect(await prisma.service.count({ where: { businessId: demo.businessId } })).toBeGreaterThan(0);
    expect(await prisma.calendarConnection.count({ where: { businessId: demo.businessId } })).toBe(1);
    expect(await prisma.subscription.count({ where: { businessId: demo.businessId } })).toBe(1);
    // The pilot business next door is untouched.
    expect(await prisma.appointment.count({ where: { businessId: bystander.businessId } })).toBe(1);
    expect(await prisma.conversation.count({ where: { businessId: bystander.businessId } })).toBe(1);
  }, 60_000);
});

/* ------------------------------------------------------------------ */

describe("expired holds", () => {
  async function heldBooking(now: Date) {
    const fixture = await createCalendarBusiness({ plan: "PRO", namePrefix: "Hold" });
    const start = at("2026-10-06T15:00");
    const held = await holdSlot({
      businessId: fixture.businessId,
      conversationId: fixture.conversationId,
      serviceId: fixture.serviceId,
      serviceName: fixture.serviceName,
      start,
      end: at("2026-10-06T16:00"),
      timezone: fixture.timezone,
      requestedTimeText: "Tuesday at 3pm",
      now
    });
    return { fixture, held, start };
  }

  it("releases a lapsed hold, keeps its history, and frees the slot", async () => {
    const now = at("2026-10-05T09:00");
    const { fixture, held, start } = await heldBooking(now);
    const later = new Date(now.getTime() + 60 * 60_000);

    const { released } = await releaseExpiredHolds({ businessId: fixture.businessId, now: later });
    expect(released).toBe(1);

    const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: held.appointment.id } });
    expect(appointment.status).toBe("expired");
    // Nothing deleted: the row and its whole history are still there.
    const history = await prisma.statusEvent.findMany({ where: { entityId: held.appointment.id }, orderBy: { createdAt: "asc" } });
    expect(history.map((event) => event.toStatus)).toEqual(["awaiting_confirmation", "expired"]);
    expect(history.at(-1)!.note).toMatch(/never confirmed/i);

    // The slot is free again: availability says so, and the hold is gone from
    // the conversation's live state.
    expect(await pendingHold(fixture.conversationId, later)).toBeNull();
    const availability = await checkAvailability({
      businessId: fixture.businessId,
      serviceId: fixture.serviceId,
      startTime: start,
      now: later
    });
    expect(availability.status).toBe("available");
  }, 60_000);

  it("never touches a hold that is still open, or one already confirmed", async () => {
    const now = at("2026-10-05T09:00");
    const { fixture, held } = await heldBooking(now);

    // Still inside its window.
    expect((await releaseExpiredHolds({ businessId: fixture.businessId, now })).released).toBe(0);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: held.appointment.id } })).status).toBe("awaiting_confirmation");

    await confirmHeldBooking({ appointmentId: held.appointment.id, now });
    const later = new Date(now.getTime() + 60 * 60_000);
    expect((await releaseExpiredHolds({ businessId: fixture.businessId, now: later })).released).toBe(0);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: held.appointment.id } })).status).toBe("confirmed");
  }, 60_000);

  it("stops a lapsed hold from being confirmed by a late yes", async () => {
    const now = at("2026-10-05T09:00");
    const { fixture, held } = await heldBooking(now);
    const later = new Date(now.getTime() + 60 * 60_000);
    await releaseExpiredHolds({ businessId: fixture.businessId, now: later });

    const outcome = await confirmHeldBooking({ appointmentId: held.appointment.id, now: later });
    expect(outcome.status).toBe("not_found");
    expect(fakeCalendarProvider.listEvents()).toEqual([]);
  }, 60_000);
});

/* ------------------------------------------------------------------ */

describe("rescheduling", () => {
  async function confirmedBooking() {
    const fixture = await createCalendarBusiness({ plan: "PRO", namePrefix: "Resched" });
    const now = at("2026-10-05T09:00");
    const held = await holdSlot({
      businessId: fixture.businessId,
      conversationId: fixture.conversationId,
      serviceId: fixture.serviceId,
      serviceName: fixture.serviceName,
      start: at("2026-10-06T15:00"),
      end: at("2026-10-06T16:00"),
      timezone: fixture.timezone,
      requestedTimeText: "Tuesday at 3pm",
      now
    });
    const confirmed = await confirmHeldBooking({ appointmentId: held.appointment.id, now });
    expect(confirmed.status).toBe("confirmed");
    return { fixture, bookingId: held.appointment.id, now };
  }

  it("needs a rescheduling verb, not merely a date", () => {
    expect(isRescheduleRequest("can I move my appointment to Wednesday at 2")).toBe(true);
    expect(isRescheduleRequest("reschedule my booking please")).toBe(true);
    // A caller simply mentioning a day must never move anything.
    expect(isRescheduleRequest("Wednesday at 2 would have been easier")).toBe(false);
    expect(isRescheduleRequest("what are your hours on Wednesday?")).toBe(false);
    expect(isRescheduleRequest("cancel my appointment")).toBe(false);
  });

  it("offers the new time and only moves the booking after an explicit yes", async () => {
    const { fixture, bookingId, now } = await confirmedBooking();
    const capabilities = { booking_requests: true, calendar_booking: true, human_escalation: true, whatsapp: false, sms: false, email_notifications: true };

    const action = await resolveCalendarAction({
      requestedAction: "none",
      callerText: "can I move my appointment to Wednesday at 2pm",
      conversationId: fixture.conversationId,
      businessId: fixture.businessId,
      capabilities,
      now
    });
    expect(action).toBe("reschedule_calendar_booking");

    const proposal = await executeCalendarAction({
      action: "reschedule_calendar_booking",
      conversationId: fixture.conversationId,
      businessId: fixture.businessId,
      capabilities,
      callerText: "can I move my appointment to Wednesday at 2pm",
      now
    });
    expect(proposal.status).toBe("ready");
    expect(proposal.callerMessage).toMatch(/is available\. Would you like me to move your appointment/i);

    // Nothing has moved yet.
    const midway = await prisma.appointment.findUniqueOrThrow({ where: { id: bookingId } });
    expect(midway.startTime?.toISOString()).toBe(at("2026-10-06T15:00").toISOString());
    expect(midway.rescheduleProposedStart).not.toBeNull();

    const confirmAction = await resolveCalendarAction({
      requestedAction: "none",
      callerText: "yes please",
      conversationId: fixture.conversationId,
      businessId: fixture.businessId,
      capabilities,
      now
    });
    expect(confirmAction).toBe("reschedule_calendar_booking");

    const moved = await executeCalendarAction({
      action: "reschedule_calendar_booking",
      conversationId: fixture.conversationId,
      businessId: fixture.businessId,
      capabilities,
      callerText: "yes please",
      now
    });
    expect(moved.status).toBe("completed");

    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: bookingId } });
    expect(after.startTime?.toISOString()).toBe(at("2026-10-07T14:00").toISOString());
    expect(after.rescheduleProposedStart).toBeNull();

    // A second "yes" is safe: there is no live proposal any more.
    const duplicate = await executeCalendarAction({
      action: "reschedule_calendar_booking",
      conversationId: fixture.conversationId,
      businessId: fixture.businessId,
      capabilities,
      callerText: "yes please",
      now
    });
    expect(duplicate.status).toBe("ready");
    const unchanged = await prisma.appointment.findUniqueOrThrow({ where: { id: bookingId } });
    expect(unchanged.startTime?.toISOString()).toBe(at("2026-10-07T14:00").toISOString());
  }, 60_000);

  it("leaves the booking alone when the new time is busy", async () => {
    const { fixture, bookingId, now } = await confirmedBooking();
    const capabilities = { booking_requests: true, calendar_booking: true, human_escalation: true, whatsapp: false, sms: false, email_notifications: true };
    // Something else already occupies the requested slot.
    fakeCalendarProvider.setBusy([{ start: at("2026-10-07T14:00"), end: at("2026-10-07T15:00") }]);

    const result = await executeCalendarAction({
      action: "reschedule_calendar_booking",
      conversationId: fixture.conversationId,
      businessId: fixture.businessId,
      capabilities,
      callerText: "move my appointment to Wednesday at 2pm",
      now
    });
    expect(result.status).toBe("ready");
    expect(result.callerMessage).toMatch(/existing booking is still in place/i);

    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: bookingId } });
    expect(after.startTime?.toISOString()).toBe(at("2026-10-06T15:00").toISOString());
    expect(after.rescheduleProposedStart).toBeNull();
  }, 60_000);

  it("is refused on a plan without rescheduling", async () => {
    const { fixture, now } = await confirmedBooking();
    const { changePlan } = await import("../src/services/access/accessService.js");
    await changePlan({ businessId: fixture.businessId, plan: "STARTER", actorType: "admin_script" });

    const result = await executeCalendarAction({
      action: "reschedule_calendar_booking",
      conversationId: fixture.conversationId,
      businessId: fixture.businessId,
      capabilities: { booking_requests: true, calendar_booking: true, human_escalation: true, whatsapp: false, sms: false, email_notifications: true },
      callerText: "move my appointment to Wednesday at 2pm",
      now
    });
    expect(result.status).toBe("unsupported");
    // Operator-facing only: the caller never hears about plans.
    expect(result.callerMessage).toBeUndefined();
  }, 60_000);

  it("is refused while the pilot's reschedule brake is off", async () => {
    const { fixture, now } = await confirmedBooking();
    await prisma.business.update({ where: { id: fixture.businessId }, data: { allowAutoReschedule: false } });

    const result = await executeCalendarAction({
      action: "reschedule_calendar_booking",
      conversationId: fixture.conversationId,
      businessId: fixture.businessId,
      capabilities: { booking_requests: true, calendar_booking: true, human_escalation: true, whatsapp: false, sms: false, email_notifications: true },
      callerText: "move my appointment to Wednesday at 2pm",
      now
    });
    expect(result.status).toBe("unsupported");
    expect(result.message).toMatch(/PILOT_SAFETY/);
  }, 60_000);

  it("gives operators a Console entry point, and refuses a busy slot without changing anything", async () => {
    const { fixture, bookingId } = await confirmedBooking();
    const session = await owner(fixture.businessId);

    const busy = at("2026-10-08T14:00");
    fakeCalendarProvider.setBusy([{ start: busy, end: at("2026-10-08T15:00") }]);
    const rejected = await authed(
      request(app).post(`/api/ops/businesses/${fixture.businessId}/bookings/${bookingId}/reschedule`),
      session
    ).send({ start: busy.toISOString() });
    expect(rejected.status).toBe(409);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: bookingId } })).startTime?.toISOString()).toBe(
      at("2026-10-06T15:00").toISOString()
    );

    const free = at("2026-10-09T14:00");
    const moved = await authed(
      request(app).post(`/api/ops/businesses/${fixture.businessId}/bookings/${bookingId}/reschedule`),
      session
    ).send({ start: free.toISOString() });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: bookingId } })).startTime?.toISOString()).toBe(
      free.toISOString()
    );
  }, 60_000);

  it("refuses the Console reschedule while the pilot brake is off", async () => {
    const { fixture, bookingId } = await confirmedBooking();
    const session = await owner(fixture.businessId);
    await prisma.business.update({ where: { id: fixture.businessId }, data: { allowAutoReschedule: false } });

    const res = await authed(
      request(app).post(`/api/ops/businesses/${fixture.businessId}/bookings/${bookingId}/reschedule`),
      session
    ).send({ start: at("2026-10-09T14:00").toISOString() });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/safety control/i);
  }, 60_000);
});
