import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { DateTime } from "luxon";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { CSRF_COOKIE, hashPassword } from "../src/services/auth/sessions.js";
import { changePlan } from "../src/services/access/accessService.js";
import { evaluatePilotReadiness } from "../src/services/pilot/readiness.js";
import { resolveRange } from "../src/services/pilot/range.js";
import { deriveOutcome } from "../src/services/pilot/outcomes.js";
import { detectGap } from "../src/services/pilot/knowledgeGaps.js";
import { pilotMetrics } from "../src/services/pilot/metrics.js";
import { createCalendarBusiness, resetFakeCalendar } from "./helpers/calendarFixtures.js";

/**
 * Pilot operations: state, readiness, measurement, feedback, issues, knowledge
 * gaps and exports — through real HTTP against the real database.
 *
 * The recurring assertion in this file is not "the number is right" but "the
 * number is honest": unmeasurable things stay null, rates refuse to appear
 * without a denominator, and nothing a caller said leaks into analytics.
 */

const app = createApp();
const PASSWORD = "harbour-quay-lantern-8812";

interface Session {
  cookie: string;
  csrf: string;
}
const authed = (r: request.Test, session: Session) => r.set({ Cookie: session.cookie, "x-csrf-token": session.csrf });
const base = (businessId: string) => `/api/ops/businesses/${businessId}`;

let passwordHash: string;
let counter = 0;

async function signIn(email: string): Promise<Session> {
  const res = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  const cookies = res.headers["set-cookie"] as unknown as string[];
  return {
    cookie: cookies.map((cookie) => cookie.split(";")[0]).join("; "),
    csrf: cookies.find((cookie) => cookie.startsWith(CSRF_COOKIE))!.split(";")[0].split("=")[1]
  };
}

async function member(businessId: string, role: string): Promise<Session> {
  counter += 1;
  const user = await prisma.user.create({
    data: { email: `${role.toLowerCase()}-${counter}-${Date.now()}@pilot.test`, name: role, passwordHash }
  });
  await prisma.businessMembership.create({ data: { userId: user.id, businessId, role } });
  return signIn(user.email);
}

/** A business that would pass pilot readiness, with an owner signed in. */
async function pilotBusiness(options: { plan?: "STARTER" | "PRO"; calendarBooking?: boolean } = {}) {
  const fixture = await createCalendarBusiness({
    plan: options.plan ?? "PRO",
    calendarBooking: options.calendarBooking ?? false,
    namePrefix: "Pilot"
  });
  await prisma.business.update({
    where: { id: fixture.businessId },
    data: {
      receptionStatus: "active",
      escalationPhone: "+1 555 0100",
      contactEmail: "team@pilot.test",
      faqs: { create: [{ question: "Do you take card?", answer: "Yes.", sortOrder: 1 }] }
    }
  });
  const owner = await member(fixture.businessId, "OWNER");
  return { ...fixture, owner };
}

async function conversationWith(
  businessId: string,
  messages: { sender: string; text: string; intent?: string; responder?: string; fallbackReason?: string; actionStatus?: string }[],
  createdAt?: Date
) {
  const conversation = await prisma.conversation.create({
    data: { businessId, callerName: "Test caller", ...(createdAt ? { createdAt } : {}) }
  });
  let offset = 0;
  for (const message of messages) {
    offset += 1000;
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        sender: message.sender,
        text: message.text,
        intent: message.intent ?? null,
        responder: message.responder ?? null,
        fallbackReason: message.fallbackReason ?? null,
        actionStatus: message.actionStatus ?? null,
        createdAt: new Date((createdAt ?? conversation.createdAt).getTime() + offset)
      }
    });
  }
  return conversation;
}

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
}, 60_000);

beforeEach(() => {
  resetFakeCalendar();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */

describe("pilot status", () => {
  it("moves none → preparing → active → paused → active → completed, and no further", async () => {
    const { businessId, owner } = await pilotBusiness();
    const set = (status: string) => authed(request(app).post(`${base(businessId)}/pilot/status`), owner).send({ status });

    expect((await set("preparing")).status).toBe(200);
    const activated = await set("active");
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    expect(activated.body.startedAt).not.toBeNull();

    expect((await set("paused")).status).toBe(200);
    expect((await set("active")).status).toBe(200);
    const completed = await set("completed");
    expect(completed.status).toBe(200);
    expect(completed.body.endedAt).not.toBeNull();
    // The start survives the pause: lifetime means the whole pilot.
    expect(completed.body.startedAt).toBe(activated.body.startedAt);

    // Completed is final.
    const reopened = await set("active");
    expect(reopened.status).toBe(422);
    expect(reopened.body.error).toMatch(/final/i);
  }, 60_000);

  it("refuses an illegal jump", async () => {
    const { businessId, owner } = await pilotBusiness();
    const res = await authed(request(app).post(`${base(businessId)}/pilot/status`), owner).send({ status: "completed" });
    expect(res.status).toBe(422);
  });

  it("refuses to activate a pilot that cannot be monitored, and says why", async () => {
    const fixture = await createCalendarBusiness({ plan: "PRO", namePrefix: "Unready", calendarBooking: false });
    // No services, no contact, Reception not live.
    await prisma.service.deleteMany({ where: { businessId: fixture.businessId } });
    await prisma.business.update({
      where: { id: fixture.businessId },
      data: { receptionStatus: "draft", contactPhone: null, contactEmail: null, escalationPhone: null, escalationEmail: null }
    });
    const owner = await member(fixture.businessId, "OWNER");

    await authed(request(app).post(`${base(fixture.businessId)}/pilot/status`), owner).send({ status: "preparing" });
    const res = await authed(request(app).post(`${base(fixture.businessId)}/pilot/status`), owner).send({ status: "active" });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/isn't ready to monitor/i);
    expect((await prisma.business.findUniqueOrThrow({ where: { id: fixture.businessId } })).pilotStatus).toBe("preparing");
  }, 60_000);

  it("lets every role read the pilot, but only OWNER/ADMIN change it", async () => {
    const { businessId } = await pilotBusiness();
    for (const role of ["ADMIN", "OPERATOR", "VIEWER"]) {
      const session = await member(businessId, role);
      const view = await authed(request(app).get(`${base(businessId)}/pilot`), session);
      expect(view.status, `${role} read`).toBe(200);
      expect(view.body.canManage, `${role} canManage`).toBe(role === "ADMIN");

      const change = await authed(request(app).post(`${base(businessId)}/pilot/status`), session).send({ status: "preparing" });
      expect(change.status, `${role} write`).toBe(role === "ADMIN" ? 200 : 403);
    }
  }, 60_000);

  it("keeps every pilot resource inside its own business", async () => {
    const mine = await pilotBusiness();
    const theirs = await pilotBusiness();
    for (const path of ["pilot", "pilot/readiness", "pilot/issues", "pilot/report", "pilot/knowledge-gaps", "pilot/export/metrics"]) {
      const res = await authed(request(app).get(`${base(theirs.businessId)}/${path}`), mine.owner);
      expect(res.status, path).toBe(404);
    }
    const write = await authed(request(app).post(`${base(theirs.businessId)}/pilot/status`), mine.owner).send({ status: "preparing" });
    expect(write.status).toBe(404);
  }, 60_000);
});

/* ------------------------------------------------------------------ */

describe("pilot readiness", () => {
  it("is ready for a well-configured request-only business", async () => {
    const { businessId } = await pilotBusiness();
    const readiness = await evaluatePilotReadiness(businessId);
    expect(readiness.requiresLiveBooking).toBe(false);
    expect(readiness.checks.find((check) => check.key === "calendar")?.message).toMatch(/request-only/i);
    expect(readiness.canActivate).toBe(true);
  });

  it("warns without blocking when only optional things are missing", async () => {
    const { businessId } = await pilotBusiness();
    await prisma.faq.deleteMany({ where: { businessId } });
    const readiness = await evaluatePilotReadiness(businessId);
    expect(readiness.level).toBe("warning");
    expect(readiness.canActivate).toBe(true);
    expect(readiness.checks.find((check) => check.key === "knowledge")?.level).toBe("warning");
  });

  it("blocks a live-booking pilot whose calendar isn't usable", async () => {
    const fixture = await createCalendarBusiness({ plan: "PRO", calendarBooking: true, connect: false, namePrefix: "NoCal" });
    await prisma.business.update({
      where: { id: fixture.businessId },
      data: { receptionStatus: "active", escalationPhone: "+1 555 0100" }
    });
    await member(fixture.businessId, "OWNER");

    const readiness = await evaluatePilotReadiness(fixture.businessId);
    expect(readiness.requiresLiveBooking).toBe(true);
    expect(readiness.canActivate).toBe(false);
    expect(readiness.checks.find((check) => check.key === "calendar")?.level).toBe("blocking");
  }, 60_000);

  it("blocks a live-booking pilot whose plan excludes calendar booking", async () => {
    const fixture = await createCalendarBusiness({ plan: "STARTER", calendarBooking: true, namePrefix: "StarterCal" });
    await prisma.business.update({
      where: { id: fixture.businessId },
      data: { receptionStatus: "active", escalationPhone: "+1 555 0100" }
    });
    const readiness = await evaluatePilotReadiness(fixture.businessId);
    expect(readiness.canActivate).toBe(false);
    expect(readiness.checks.find((check) => check.key === "entitlements")?.level).toBe("blocking");
  }, 60_000);

  it("blocks when the subscription has lapsed", async () => {
    const { businessId } = await pilotBusiness();
    await changePlan({ businessId, plan: "PRO", status: "cancelled", actorType: "admin_script" });
    const readiness = await evaluatePilotReadiness(businessId);
    expect(readiness.canActivate).toBe(false);
    expect(readiness.checks.find((check) => check.key === "subscription")?.level).toBe("blocking");
  });
});

/* ------------------------------------------------------------------ */

describe("metrics", () => {
  it("counts conversations, bookings, escalations and fallbacks from real rows", async () => {
    const { businessId, owner, conversationId } = await pilotBusiness();

    await conversationWith(businessId, [
      { sender: "caller", text: "How much is a clean?" },
      { sender: "receptionist", text: "It's $120.", intent: "pricing", responder: "rule_based" }
    ]);
    await conversationWith(businessId, [
      { sender: "caller", text: "Do you validate parking?" },
      { sender: "receptionist", text: "I don't have that on file.", intent: "out_of_scope", responder: "rule_based", fallbackReason: "provider_error" }
    ]);
    await prisma.appointment.create({
      data: { businessId, conversationId, requestedTime: "Tuesday 2pm", mode: "request", status: "submitted" }
    });
    await prisma.escalation.create({ data: { businessId, conversationId, reason: "Wants a person" } });

    const res = await authed(request(app).get(`${base(businessId)}/pilot?range=last_7_days`), owner);
    expect(res.status).toBe(200);
    const value = (key: string) =>
      [...res.body.metrics.activity, ...res.body.metrics.outcomes, ...res.body.metrics.derived].find(
        (metric: { key: string }) => metric.key === key
      );

    expect(value("conversations").value).toBeGreaterThanOrEqual(2);
    expect(value("booking_requests").value).toBe(1);
    expect(value("escalations").value).toBe(1);
    expect(value("fallback_replies").value).toBe(1);
    expect(value("out_of_scope_replies").value).toBe(1);
  }, 60_000);

  it("reports a rate as 'not available' rather than zero when the sample is too small", async () => {
    const { businessId, owner } = await pilotBusiness();
    await conversationWith(businessId, [
      { sender: "caller", text: "Hello" },
      { sender: "receptionist", text: "Hi", intent: "greeting", responder: "rule_based" }
    ]);

    const res = await authed(request(app).get(`${base(businessId)}/pilot`), owner);
    const conversion = res.body.metrics.derived.find((metric: { key: string }) => metric.key === "booking_conversion");
    expect(conversion.value).toBeNull();
    expect(conversion.unavailableReason).toMatch(/at least/i);
    // The definition travels with the metric, so nobody has to guess.
    expect(conversion.definition).toMatch(/÷/);
  }, 60_000);

  it("counts by the business's own timezone, not the server's", async () => {
    const fixture = await createCalendarBusiness({ plan: "PRO", namePrefix: "TZ", calendarBooking: false });
    await prisma.business.update({
      where: { id: fixture.businessId },
      data: { timezone: "Pacific/Kiritimati", receptionStatus: "active", escalationPhone: "+1 555 0100" }
    });
    const range = resolveRange({
      key: "today",
      timezone: "Pacific/Kiritimati",
      now: new Date("2026-09-25T09:00:00Z")
    });
    // Kiritimati is UTC+14, so "today" there began the previous UTC evening.
    expect(range.from).toBe("2026-09-24T10:00:00.000Z");
    expect(range.to).toBe("2026-09-25T10:00:00.000Z");
    expect(range.timezone).toBe("Pacific/Kiritimati");
  }, 60_000);

  it("filters by the requested range", async () => {
    const { businessId, owner } = await pilotBusiness();
    const old = DateTime.now().minus({ days: 20 }).toJSDate();
    await conversationWith(businessId, [{ sender: "caller", text: "Old question" }], old);
    await conversationWith(businessId, [{ sender: "caller", text: "New question" }]);

    const week = await authed(request(app).get(`${base(businessId)}/pilot?range=last_7_days`), owner);
    const month = await authed(request(app).get(`${base(businessId)}/pilot?range=last_30_days`), owner);
    const count = (body: { metrics: { activity: { key: string; value: number }[] } }) =>
      body.metrics.activity.find((metric) => metric.key === "conversations")!.value;

    // The fixture opens a conversation of its own, so this asserts the
    // difference the range makes rather than an absolute count.
    expect(count(month.body)).toBe(count(week.body) + 1);
    expect(count(week.body)).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("refuses pilot lifetime when no pilot has started", async () => {
    const { businessId, owner } = await pilotBusiness();
    const res = await authed(request(app).get(`${base(businessId)}/pilot?range=pilot_lifetime`), owner);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no pilot start date/i);
  });
});

/* ------------------------------------------------------------------ */

describe("conversation outcome", () => {
  const conversation = { id: "c1", status: "open", createdAt: new Date(), outcomeOverride: null, outcomeOverrideNote: null, outcomeOverrideAt: null };

  it("derives from evidence, strongest first", () => {
    const base = { conversation, appointments: [], escalations: [] };
    expect(
      deriveOutcome({
        ...base,
        messages: [{ sender: "caller", intent: null, action: null, actionStatus: null, createdAt: new Date() }],
        appointments: [{ status: "confirmed", mode: "calendar" }]
      }).outcome
    ).toBe("booking_confirmed");

    expect(
      deriveOutcome({ ...base, messages: [{ sender: "caller", intent: null, action: null, actionStatus: null, createdAt: new Date() }], escalations: [{ status: "requested" }] }).outcome
    ).toBe("escalated");

    expect(
      deriveOutcome({
        ...base,
        messages: [
          { sender: "caller", intent: null, action: null, actionStatus: null, createdAt: new Date() },
          { sender: "receptionist", intent: "pricing", action: "none", actionStatus: "not_required", createdAt: new Date() }
        ]
      }).outcome
    ).toBe("answered");

    expect(
      deriveOutcome({
        ...base,
        messages: [
          { sender: "caller", intent: null, action: null, actionStatus: null, createdAt: new Date() },
          { sender: "receptionist", intent: "out_of_scope", action: "none", actionStatus: "not_required", createdAt: new Date() }
        ]
      }).outcome
    ).toBe("out_of_scope");
  });

  it("says 'undetermined' rather than guessing", () => {
    const result = deriveOutcome({
      conversation,
      messages: [
        { sender: "caller", intent: null, action: null, actionStatus: null, createdAt: new Date() },
        { sender: "receptionist", intent: "greeting", action: "none", actionStatus: "not_required", createdAt: new Date() }
      ],
      appointments: [],
      escalations: []
    });
    expect(result.outcome).toBe("undetermined");
    expect(result.evidence).toBeTruthy();
  });

  it("lets an operator correct it, and the correction wins", async () => {
    const { businessId, owner } = await pilotBusiness();
    const conversationRow = await conversationWith(businessId, [
      { sender: "caller", text: "Thanks" },
      { sender: "receptionist", text: "Any time.", intent: "acknowledgement" }
    ]);

    const before = await authed(request(app).get(`${base(businessId)}/conversations/${conversationRow.id}/outcome`), owner);
    expect(before.body.outcome).toBe("undetermined");
    expect(before.body.source).toBe("derived");

    const set = await authed(request(app).put(`${base(businessId)}/conversations/${conversationRow.id}/outcome`), owner).send({
      outcome: "answered",
      note: "Caller got what they needed by phone."
    });
    expect(set.status).toBe(204);

    const after = await authed(request(app).get(`${base(businessId)}/conversations/${conversationRow.id}/outcome`), owner);
    expect(after.body).toMatchObject({ outcome: "answered", source: "operator" });
    expect(after.body.note).toMatch(/by phone/);

    // The transcript itself is untouched.
    const messages = await prisma.message.findMany({ where: { conversationId: conversationRow.id } });
    expect(messages.map((m) => m.text)).toEqual(["Thanks", "Any time."]);
  }, 60_000);
});

/* ------------------------------------------------------------------ */

describe("feedback and issues", () => {
  it("reports an issue, works it through the queue, and never edits the conversation", async () => {
    const { businessId, owner } = await pilotBusiness();
    const conversation = await conversationWith(businessId, [
      { sender: "caller", text: "Do you do implants?" },
      { sender: "receptionist", text: "No idea.", intent: "out_of_scope" }
    ]);

    const reported = await authed(request(app).post(`${base(businessId)}/pilot/issues`), owner).send({
      category: "incorrect_answer",
      conversationId: conversation.id,
      note: "We do offer implants."
    });
    expect(reported.status).toBe(201);
    expect(reported.body).toMatchObject({ status: "open", category: "incorrect_answer" });

    const reviewing = await authed(request(app).patch(`${base(businessId)}/pilot/issues/${reported.body.id}`), owner).send({
      status: "reviewing"
    });
    expect(reviewing.status).toBe(200);

    const resolved = await authed(request(app).patch(`${base(businessId)}/pilot/issues/${reported.body.id}`), owner).send({
      status: "resolved",
      resolutionNote: "Added an implants service."
    });
    expect(resolved.body).toMatchObject({ status: "resolved", resolutionNote: "Added an implants service." });
    expect(resolved.body.resolvedAt).not.toBeNull();

    const messages = await prisma.message.findMany({ where: { conversationId: conversation.id } });
    expect(messages.map((m) => m.text)).toEqual(["Do you do implants?", "No idea."]);
  }, 60_000);

  it("rejects an unknown category and an illegal status move", async () => {
    const { businessId, owner } = await pilotBusiness();
    const bad = await authed(request(app).post(`${base(businessId)}/pilot/issues`), owner).send({ category: "vibes" });
    expect(bad.status).toBe(400);

    const issue = await authed(request(app).post(`${base(businessId)}/pilot/issues`), owner).send({ category: "other" });
    await authed(request(app).patch(`${base(businessId)}/pilot/issues/${issue.body.id}`), owner).send({ status: "resolved" });
    const illegal = await authed(request(app).patch(`${base(businessId)}/pilot/issues/${issue.body.id}`), owner).send({
      status: "reviewing"
    });
    expect(illegal.status).toBe(422);
  }, 60_000);

  it("refuses a conversation reference from another business", async () => {
    const mine = await pilotBusiness();
    const theirs = await pilotBusiness();
    const theirConversation = await conversationWith(theirs.businessId, [{ sender: "caller", text: "Hi" }]);

    const res = await authed(request(app).post(`${base(mine.businessId)}/pilot/issues`), mine.owner).send({
      category: "other",
      conversationId: theirConversation.id
    });
    expect(res.status).toBe(404);
  }, 60_000);

  it("lets an operator report and triage, but not a viewer", async () => {
    const { businessId } = await pilotBusiness();
    const operator = await member(businessId, "OPERATOR");
    const viewer = await member(businessId, "VIEWER");

    const reported = await authed(request(app).post(`${base(businessId)}/pilot/issues`), operator).send({ category: "bad_tone" });
    expect(reported.status).toBe(201);
    expect((await authed(request(app).patch(`${base(businessId)}/pilot/issues/${reported.body.id}`), operator).send({ status: "resolved" })).status).toBe(200);

    expect((await authed(request(app).post(`${base(businessId)}/pilot/issues`), viewer).send({ category: "bad_tone" })).status).toBe(403);
    expect((await authed(request(app).get(`${base(businessId)}/pilot/issues`), viewer)).status).toBe(200);
  }, 60_000);

  it("records feedback, and counts a negative rating as human intervention", async () => {
    const { businessId, owner } = await pilotBusiness();
    const conversation = await conversationWith(businessId, [
      { sender: "caller", text: "Are you open Sunday?" },
      { sender: "receptionist", text: "Yes.", intent: "business_information" }
    ]);

    const feedback = await authed(request(app).post(`${base(businessId)}/conversations/${conversation.id}/feedback`), owner).send({
      rating: "incorrect",
      note: "We're closed on Sundays."
    });
    expect(feedback.status).toBe(201);

    const range = resolveRange({ key: "last_7_days", timezone: "UTC" });
    const metrics = await pilotMetrics(businessId, range);
    expect(metrics.raw.humanInterventions).toBeGreaterThanOrEqual(1);
    expect(metrics.raw.outcomes.human_intervention).toBe(1);
  }, 60_000);
});

/* ------------------------------------------------------------------ */

describe("knowledge gaps", () => {
  it("only records a gap when Veyra actually failed to answer", () => {
    const context = { hours: "Mon-Fri 9-5", location: "1 High St", contactPhone: "+1", contactEmail: null, services: [], faqs: [] };
    const input = { businessId: "b", conversationId: "c", messageId: "m", context };

    // Answered normally: no gap, even though "parking" is in the vocabulary.
    expect(detectGap({ ...input, callerText: "Is there parking?", intent: "business_information" })).toBeNull();
    // Unanswerable and in the vocabulary: a parking gap.
    expect(detectGap({ ...input, callerText: "Is there parking nearby?", intent: "out_of_scope" })).toMatchObject({
      topic: "parking"
    });
  });

  it("names a service whose price is missing, from the business's own record", () => {
    const gap = detectGap({
      businessId: "b",
      conversationId: "c",
      messageId: "m",
      callerText: "how much is teeth whitening",
      intent: "pricing",
      context: {
        hours: "",
        location: "",
        contactPhone: null,
        contactEmail: null,
        services: [{ name: "Teeth whitening", description: "", priceLabel: "" }],
        faqs: []
      }
    });
    expect(gap).toMatchObject({ kind: "missing_price", detail: "Teeth whitening" });
  });

  it("falls back to an unknown topic rather than inventing a label", () => {
    const gap = detectGap({
      businessId: "b",
      conversationId: "c",
      messageId: "m",
      callerText: "do you sell timeshares in antarctica",
      intent: "out_of_scope",
      context: { hours: "9-5", location: "here", contactPhone: "+1", contactEmail: null, services: [{ name: "Clean", description: "", priceLabel: "$1" }], faqs: [] }
    });
    expect(gap).toMatchObject({ kind: "unknown_topic", topic: "other" });
  });

  it("counts one gap per conversation, however often the caller repeats it", async () => {
    const { businessId, owner } = await pilotBusiness();
    const conversation = await conversationWith(businessId, [{ sender: "caller", text: "parking?" }]);

    for (let i = 0; i < 3; i += 1) {
      await prisma.knowledgeGapSignal
        .create({ data: { businessId, conversationId: conversation.id, kind: "missing_faq", topic: "parking" } })
        .catch(() => undefined);
    }
    const second = await conversationWith(businessId, [{ sender: "caller", text: "parking?" }]);
    await prisma.knowledgeGapSignal.create({ data: { businessId, conversationId: second.id, kind: "missing_faq", topic: "parking" } });

    const res = await authed(request(app).get(`${base(businessId)}/pilot/knowledge-gaps`), owner);
    const parking = res.body.gaps.find((gap: { topic: string }) => gap.topic === "parking");
    expect(parking.conversations).toBe(2);
    expect(parking.suggestion).toMatch(/FAQ/i);
  }, 60_000);
});

/* ------------------------------------------------------------------ */

describe("pilot safety controls", () => {
  it("cannot grant a feature the plan excludes", async () => {
    const fixture = await createCalendarBusiness({ plan: "STARTER", calendarBooking: true, namePrefix: "Safety" });
    await prisma.business.update({
      where: { id: fixture.businessId },
      data: { receptionStatus: "active", escalationPhone: "+1 555 0100" }
    });
    const owner = await member(fixture.businessId, "OWNER");

    // Every control switched on, on a plan that includes none of them.
    const res = await authed(request(app).put(`${base(fixture.businessId)}/pilot/safety`), owner).send({
      allowAutoBooking: true,
      allowAutoReschedule: true,
      allowAutoCancellation: true
    });
    expect(res.status).toBe(200);

    const { effectiveCapabilitiesFor } = await import("../src/services/access/accessService.js");
    const capabilities = await effectiveCapabilitiesFor(fixture.businessId);
    expect(capabilities.calendar_booking).toBe(false);

    const overview = await authed(request(app).get(`${base(fixture.businessId)}/pilot`), owner);
    expect(overview.body.safetyLockedByPlan).toContain("allowAutoBooking");
  }, 60_000);

  it("switching a control off withholds the feature even though the plan includes it", async () => {
    const fixture = await createCalendarBusiness({ plan: "PRO", calendarBooking: true, namePrefix: "Brake" });
    await prisma.business.update({
      where: { id: fixture.businessId },
      data: { receptionStatus: "active", escalationPhone: "+1 555 0100" }
    });
    const owner = await member(fixture.businessId, "OWNER");
    const { effectiveCapabilitiesFor } = await import("../src/services/access/accessService.js");

    expect((await effectiveCapabilitiesFor(fixture.businessId)).calendar_booking).toBe(true);

    await authed(request(app).put(`${base(fixture.businessId)}/pilot/safety`), owner).send({ allowAutoBooking: false });
    expect((await effectiveCapabilitiesFor(fixture.businessId)).calendar_booking).toBe(false);
  }, 60_000);

  it("is refused to an operator", async () => {
    const { businessId } = await pilotBusiness();
    const operator = await member(businessId, "OPERATOR");
    const res = await authed(request(app).put(`${base(businessId)}/pilot/safety`), operator).send({ allowEscalation: false });
    expect(res.status).toBe(403);
  }, 60_000);
});

/* ------------------------------------------------------------------ */

describe("targets", () => {
  it("stores targets and rejects nonsense", async () => {
    const { businessId, owner } = await pilotBusiness();
    const saved = await authed(request(app).put(`${base(businessId)}/pilot/targets`), owner).send({
      targetConversations: 100,
      maxHumanInterventionRate: 0.25
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ targetConversations: 100, maxHumanInterventionRate: 0.25 });

    const bad = await authed(request(app).put(`${base(businessId)}/pilot/targets`), owner).send({ maxHumanInterventionRate: 250 });
    expect(bad.status).toBe(400);
  }, 60_000);
});

/* ------------------------------------------------------------------ */

describe("report and export", () => {
  it("grounds every recommendation in a count it also reports", async () => {
    const { businessId, owner } = await pilotBusiness();
    for (let i = 0; i < 3; i += 1) {
      const conversation = await conversationWith(businessId, [
        { sender: "caller", text: "do you validate parking" },
        { sender: "receptionist", text: "I don't have that on file.", intent: "out_of_scope" }
      ]);
      await prisma.knowledgeGapSignal.create({
        data: { businessId, conversationId: conversation.id, kind: "missing_faq", topic: "parking" }
      });
    }

    const res = await authed(request(app).get(`${base(businessId)}/pilot/report`), owner);
    expect(res.status).toBe(200);
    const parking = res.body.recommendations.find((item: { evidence: string }) => item.evidence.includes("Parking"));
    expect(parking.message).toMatch(/FAQ/i);
    expect(parking.evidence).toMatch(/3 separate conversations/);
    expect(res.body.outcomes.some((row: { outcome: string }) => row.outcome === "out_of_scope")).toBe(true);
  }, 60_000);

  it("exports business-scoped CSV with no message text or secrets", async () => {
    const { businessId, owner } = await pilotBusiness();
    await conversationWith(businessId, [
      { sender: "caller", text: "SENSITIVE-CALLER-TEXT" },
      { sender: "receptionist", text: "SENSITIVE-REPLY-TEXT", intent: "pricing" }
    ]);

    const res = await authed(request(app).get(`${base(businessId)}/pilot/export/conversations`), owner);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename=/);
    expect(res.text).toMatch(/conversation_id,started_at/);
    // Counts and outcomes only — never what anyone said.
    expect(res.text).not.toMatch(/SENSITIVE-CALLER-TEXT|SENSITIVE-REPLY-TEXT/);
  }, 60_000);

  it("exports an unmeasurable metric as not_available, never as 0", async () => {
    const { businessId, owner } = await pilotBusiness();
    const res = await authed(request(app).get(`${base(businessId)}/pilot/export/metrics`), owner);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/booking_conversion,[^,]*,not_available/);
  }, 60_000);

  it("refuses an unknown export", async () => {
    const { businessId, owner } = await pilotBusiness();
    expect((await authed(request(app).get(`${base(businessId)}/pilot/export/passwords`), owner)).status).toBe(404);
  }, 60_000);
});
