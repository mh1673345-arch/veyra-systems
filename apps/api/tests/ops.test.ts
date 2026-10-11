import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";

import { CSRF_COOKIE, SESSION_COOKIE, hashPassword } from "../src/services/auth/sessions.js";

const app = createApp();

/**
 * These tests cover record-level scoping and lifecycle rules, so the operator
 * here is a member of every business involved. Membership-level isolation
 * (a user who simply doesn't belong) is covered in auth.test.ts.
 */
const OPS_PASSWORD = "ops-suite-password";
let sessionCookie = "";
let csrfToken = "";
// Mutations need the session cookie and the CSRF header it was issued with.
const auth = (r: request.Test) => r.set({ Cookie: sessionCookie, "x-csrf-token": csrfToken });

/** Two tenants, so every isolation assertion has something real to cross. */
let alphaId: string;
let betaId: string;
let alphaConversationId: string;
let betaConversationId: string;
let alphaBookingId: string;
let betaBookingId: string;
let alphaEscalationId: string;
let betaEscalationId: string;
let emptyBusinessId: string;

beforeAll(async () => {
  const [alpha, beta, empty] = await Promise.all([
    prisma.business.create({ data: { name: "Alpha Dental" } }),
    prisma.business.create({ data: { name: "Beta Dental" } }),
    prisma.business.create({ data: { name: "Empty Dental" } })
  ]);
  alphaId = alpha.id;
  betaId = beta.id;
  emptyBusinessId = empty.id;

  const [alphaConversation, betaConversation] = await Promise.all([
    prisma.conversation.create({ data: { businessId: alphaId, callerName: "Alpha Caller" } }),
    prisma.conversation.create({ data: { businessId: betaId, callerName: "Beta Caller" } })
  ]);
  alphaConversationId = alphaConversation.id;
  betaConversationId = betaConversation.id;

  await prisma.message.createMany({
    data: [
      { conversationId: alphaConversationId, sender: "caller", text: "I want to book a cleaning" },
      {
        conversationId: alphaConversationId,
        sender: "receptionist",
        text: "Please use the booking request below.",
        intent: "booking",
        action: "show_booking_form",
        confidence: 0.85,
        requiresClarification: false
      }
    ]
  });

  const [alphaBooking, betaBooking] = await Promise.all([
    prisma.appointment.create({
      data: {
        conversationId: alphaConversationId,
        businessId: alphaId,
        requestedTime: "2026-10-01T10:00",
        serviceName: "Routine cleaning",
        status: "submitted",
        submittedAt: new Date()
      }
    }),
    prisma.appointment.create({
      data: {
        conversationId: betaConversationId,
        businessId: betaId,
        requestedTime: "2026-10-02T11:00",
        status: "submitted",
        submittedAt: new Date()
      }
    })
  ]);
  alphaBookingId = alphaBooking.id;
  betaBookingId = betaBooking.id;

  const [alphaEscalation, betaEscalation] = await Promise.all([
    prisma.escalation.create({
      data: {
        conversationId: alphaConversationId,
        businessId: alphaId,
        reason: "I want to speak to a person",
        status: "requested"
      }
    }),
    prisma.escalation.create({
      data: {
        conversationId: betaConversationId,
        businessId: betaId,
        reason: "Beta caller wants a human",
        status: "requested"
      }
    })
  ]);
  alphaEscalationId = alphaEscalation.id;
  betaEscalationId = betaEscalation.id;

  // Self-cleaning fixture so this file can run without the pretest reset.
  await prisma.user.deleteMany({ where: { email: "ops-suite@veyra.test" } });
  const operator = await prisma.user.create({
    data: {
      email: "ops-suite@veyra.test",
      name: "Ops Suite Operator",
      passwordHash: await hashPassword(OPS_PASSWORD)
    }
  });
  await prisma.businessMembership.createMany({
    data: [alphaId, betaId, emptyBusinessId].map((businessId) => ({
      userId: operator.id,
      businessId,
      role: "OWNER"
    }))
  });

  const login = await request(app)
    .post("/api/auth/login")
    .send({ email: "ops-suite@veyra.test", password: OPS_PASSWORD });
  const cookies = login.headers["set-cookie"] as unknown as string[];
  sessionCookie = cookies.find((c) => c.startsWith(SESSION_COOKIE))!.split(";")[0];
  csrfToken = cookies.find((c) => c.startsWith(CSRF_COOKIE))!.split(";")[0].split("=")[1];
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("ops — overview", () => {
  it("reports real counts for the business", async () => {
    const res = await auth(request(app).get(`/api/ops/businesses/${alphaId}/overview`));

    expect(res.status).toBe(200);
    expect(res.body.businessName).toBe("Alpha Dental");
    expect(res.body.conversationsTotal).toBe(1);
    expect(res.body.openBookings).toBe(1);
    expect(res.body.openEscalations).toBe(1);
    expect(Array.isArray(res.body.recentActivity)).toBe(true);
  });

  it("shows genuine zeroes for a business with no activity, not sample data", async () => {
    const res = await auth(request(app).get(`/api/ops/businesses/${emptyBusinessId}/overview`));

    expect(res.status).toBe(200);
    expect(res.body.conversationsTotal).toBe(0);
    expect(res.body.openBookings).toBe(0);
    expect(res.body.openEscalations).toBe(0);
    expect(res.body.recentActivity).toEqual([]);
  });
});

describe("ops — bookings", () => {
  it("lists bookings with caller and service detail", async () => {
    const res = await auth(request(app).get(`/api/ops/businesses/${alphaId}/bookings`));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: alphaBookingId,
      callerName: "Alpha Caller",
      serviceName: "Routine cleaning",
      status: "submitted",
      conversationId: alphaConversationId
    });
    expect(res.body[0].allowedTransitions).toContain("reviewing");
  });

  it("returns booking detail with history and business name", async () => {
    const res = await auth(
      request(app).get(`/api/ops/businesses/${alphaId}/bookings/${alphaBookingId}`)
    );

    expect(res.status).toBe(200);
    expect(res.body.booking.id).toBe(alphaBookingId);
    expect(res.body.businessName).toBe("Alpha Dental");
    expect(Array.isArray(res.body.history)).toBe(true);
  });

  it("returns an empty list rather than failing when there are no bookings", async () => {
    const res = await auth(request(app).get(`/api/ops/businesses/${emptyBusinessId}/bookings`));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("performs the full submitted -> reviewing -> confirmed workflow", async () => {
    const reviewing = await auth(
      request(app)
        .patch(`/api/ops/businesses/${alphaId}/bookings/${alphaBookingId}/status`)
        .send({ status: "reviewing" })
    );
    expect(reviewing.status).toBe(200);
    expect(reviewing.body.status).toBe("reviewing");
    expect(reviewing.body.reviewedAt).toBeTruthy();

    const confirmed = await auth(
      request(app)
        .patch(`/api/ops/businesses/${alphaId}/bookings/${alphaBookingId}/status`)
        .send({ status: "confirmed" })
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("confirmed");
    expect(confirmed.body.resolvedAt).toBeTruthy();
  });

  it("records an auditable status history attributed to the authenticated operator", async () => {
    const res = await auth(
      request(app).get(`/api/ops/businesses/${alphaId}/bookings/${alphaBookingId}`)
    );

    const history = res.body.history as {
      fromStatus: string;
      toStatus: string;
      actorType: string;
      actorUserId: string | null;
      actorName: string | null;
      createdAt: string;
    }[];
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ fromStatus: "submitted", toStatus: "reviewing" });
    expect(history[1]).toMatchObject({ fromStatus: "reviewing", toStatus: "confirmed" });
    expect(history[0].actorType).toBe("operator");
    // The authenticated operator is recorded, not a placeholder.
    expect(history[0].actorUserId).toBeTruthy();
    expect(history[0].actorName).toBe("Ops Suite Operator");
    expect(history[0].createdAt).toBeTruthy();
  });

  it("rejects an invalid booking transition with 422 and leaves the record untouched", async () => {
    // confirmed -> reviewing is not a legal move.
    const res = await auth(
      request(app)
        .patch(`/api/ops/businesses/${alphaId}/bookings/${alphaBookingId}/status`)
        .send({ status: "reviewing" })
    );

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Cannot move a booking request");

    const stored = await prisma.appointment.findUnique({ where: { id: alphaBookingId } });
    expect(stored?.status).toBe("confirmed");
  });

  it("rejects an unknown status value", async () => {
    const res = await auth(
      request(app)
        .patch(`/api/ops/businesses/${alphaId}/bookings/${betaBookingId}/status`)
        .send({ status: "teleported" })
    );
    // Beta's booking is not visible to Alpha at all.
    expect(res.status).toBe(404);
  });
});

describe("ops — escalations", () => {
  it("lists escalations with reason and conversation reference", async () => {
    const res = await auth(request(app).get(`/api/ops/businesses/${alphaId}/escalations`));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: alphaEscalationId,
      reason: "I want to speak to a person",
      status: "requested",
      conversationId: alphaConversationId
    });
  });

  it("returns an empty list rather than failing when there are no escalations", async () => {
    const res = await auth(request(app).get(`/api/ops/businesses/${emptyBusinessId}/escalations`));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("performs the requested -> assigned -> resolved workflow", async () => {
    const assigned = await auth(
      request(app)
        .patch(`/api/ops/businesses/${alphaId}/escalations/${alphaEscalationId}/status`)
        .send({ status: "assigned" })
    );
    expect(assigned.status).toBe(200);
    expect(assigned.body.status).toBe("assigned");
    expect(assigned.body.assignedAt).toBeTruthy();

    const resolved = await auth(
      request(app)
        .patch(`/api/ops/businesses/${alphaId}/escalations/${alphaEscalationId}/status`)
        .send({ status: "resolved" })
    );
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe("resolved");
    expect(resolved.body.resolvedAt).toBeTruthy();
  });

  it("rejects an invalid escalation transition with 422", async () => {
    // resolved -> assigned is not a legal move.
    const res = await auth(
      request(app)
        .patch(`/api/ops/businesses/${alphaId}/escalations/${alphaEscalationId}/status`)
        .send({ status: "assigned" })
    );

    expect(res.status).toBe(422);
    const stored = await prisma.escalation.findUnique({ where: { id: alphaEscalationId } });
    expect(stored?.status).toBe("resolved");
  });

  it("does not resolve an escalation merely because it was read", async () => {
    const before = await prisma.escalation.findUnique({ where: { id: betaEscalationId } });
    await auth(request(app).get(`/api/ops/businesses/${betaId}/escalations/${betaEscalationId}`));
    const after = await prisma.escalation.findUnique({ where: { id: betaEscalationId } });

    expect(after?.status).toBe(before?.status);
    expect(after?.status).toBe("requested");
  });
});

describe("ops — conversations", () => {
  it("lists conversations with booking and escalation indicators", async () => {
    const res = await auth(request(app).get(`/api/ops/businesses/${alphaId}/conversations`));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: alphaConversationId,
      callerName: "Alpha Caller",
      bookingCount: 1,
      escalationCount: 1
    });
    expect(res.body[0].lastCallerMessage).toBe("I want to book a cleaning");
  });

  it("returns the message history and linked records for a conversation", async () => {
    const res = await auth(
      request(app).get(`/api/ops/businesses/${alphaId}/conversations/${alphaConversationId}`)
    );

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages[0].sender).toBe("caller");
    expect(res.body.bookings[0].id).toBe(alphaBookingId);
    expect(res.body.escalations[0].id).toBe(alphaEscalationId);
  });

  it("does not expose developer diagnostics to the business-facing view", async () => {
    const res = await auth(
      request(app).get(`/api/ops/businesses/${alphaId}/conversations/${alphaConversationId}`)
    );

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("confidence");
    expect(serialized).not.toContain("requiresClarification");
    expect(serialized).not.toContain("fallbackReason");
    expect(serialized).not.toContain("system");
    // The business-meaningful classification is still present.
    expect(res.body.messages[1].intent).toBe("booking");
    expect(res.body.messages[1].action).toBe("show_booking_form");
  });

  it("returns an empty list rather than failing when there are no conversations", async () => {
    const res = await auth(
      request(app).get(`/api/ops/businesses/${emptyBusinessId}/conversations`)
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("ops — capabilities", () => {
  it("exposes the business's configured capabilities", async () => {
    const res = await auth(request(app).get(`/api/ops/businesses/${alphaId}/capabilities`));

    expect(res.status).toBe(200);
    expect(res.body.capabilities).toMatchObject({
      booking_requests: true,
      calendar_booking: false,
      human_escalation: true,
      whatsapp: false,
      sms: false,
      email_notifications: false
    });
  });

  it("has no endpoint for mutating capabilities from the dashboard", async () => {
    const res = await auth(
      request(app)
        .patch(`/api/ops/businesses/${alphaId}/capabilities`)
        .send({ whatsapp: true })
    );
    // No such route exists, however the request is authenticated.
    expect(res.status).not.toBe(200);

    const business = await prisma.business.findUnique({ where: { id: alphaId } });
    expect(business?.capWhatsapp).toBe(false);
  });
});

describe("ops — tenant isolation", () => {
  it("does not leak another business's conversations in a list", async () => {
    const res = await auth(request(app).get(`/api/ops/businesses/${alphaId}/conversations`));
    const ids = (res.body as { id: string }[]).map((c) => c.id);
    expect(ids).not.toContain(betaConversationId);
  });

  it("does not leak another business's bookings or escalations in a list", async () => {
    const bookings = await auth(request(app).get(`/api/ops/businesses/${alphaId}/bookings`));
    expect((bookings.body as { id: string }[]).map((b) => b.id)).not.toContain(betaBookingId);

    const escalations = await auth(request(app).get(`/api/ops/businesses/${alphaId}/escalations`));
    expect((escalations.body as { id: string }[]).map((e) => e.id)).not.toContain(betaEscalationId);
  });

  it("refuses cross-tenant reads of a conversation, booking and escalation", async () => {
    const conversation = await auth(
      request(app).get(`/api/ops/businesses/${alphaId}/conversations/${betaConversationId}`)
    );
    expect(conversation.status).toBe(404);

    const booking = await auth(
      request(app).get(`/api/ops/businesses/${alphaId}/bookings/${betaBookingId}`)
    );
    expect(booking.status).toBe(404);

    const escalation = await auth(
      request(app).get(`/api/ops/businesses/${alphaId}/escalations/${betaEscalationId}`)
    );
    expect(escalation.status).toBe(404);
  });

  it("refuses cross-tenant mutations and leaves the other tenant's data unchanged", async () => {
    const booking = await auth(
      request(app)
        .patch(`/api/ops/businesses/${alphaId}/bookings/${betaBookingId}/status`)
        .send({ status: "confirmed" })
    );
    expect(booking.status).toBe(404);

    const escalation = await auth(
      request(app)
        .patch(`/api/ops/businesses/${alphaId}/escalations/${betaEscalationId}/status`)
        .send({ status: "resolved" })
    );
    expect(escalation.status).toBe(404);

    expect((await prisma.appointment.findUnique({ where: { id: betaBookingId } }))?.status).toBe(
      "submitted"
    );
    expect((await prisma.escalation.findUnique({ where: { id: betaEscalationId } }))?.status).toBe(
      "requested"
    );
  });

  it("requires an authenticated session for dashboard endpoints", async () => {
    const res = await request(app).get(`/api/ops/businesses/${alphaId}/overview`);
    expect(res.status).toBe(401);
  });
});

describe("ops — the AI cannot drive human transitions", () => {
  it("leaves an operator-set booking status untouched when the caller keeps chatting", async () => {
    const conversation = await prisma.conversation.create({ data: { businessId: alphaId } });
    const booking = await prisma.appointment.create({
      data: {
        conversationId: conversation.id,
        businessId: alphaId,
        requestedTime: "2026-11-01T09:00",
        status: "submitted",
        submittedAt: new Date()
      }
    });

    // An operator reviews it.
    await auth(
      request(app)
        .patch(`/api/ops/businesses/${alphaId}/bookings/${booking.id}/status`)
        .send({ status: "reviewing" })
    );

    // The caller then asks for confirmation and a human, exercising both actions.
    for (const text of [
      "Please confirm my appointment",
      "Mark it as confirmed",
      "I want to speak to a person"
    ]) {
      // The reception demo endpoints still use the demo key, not an operator session.
      const res = await request(app)
        .post(`/api/conversations/${conversation.id}/messages`)
        .set("x-api-key", process.env.VEYRA_API_KEY as string)
        .send({ text });
      expect(res.status).toBe(201);
    }

    // The AI may create an escalation, but it may not advance either lifecycle.
    const after = await prisma.appointment.findUnique({ where: { id: booking.id } });
    expect(after?.status).toBe("reviewing");

    const escalations = await prisma.escalation.findMany({
      where: { conversationId: conversation.id }
    });
    for (const escalation of escalations) {
      expect(escalation.status).toBe("requested");
    }

    // No status events: nothing here was an operator transition.
    const aiEvents = await prisma.statusEvent.findMany({
      where: { entityType: "escalation", entityId: { in: escalations.map((e) => e.id) } }
    });
    expect(aiEvents).toHaveLength(0);
  });
});
