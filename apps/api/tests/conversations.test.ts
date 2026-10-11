import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";

const app = createApp();
const apiKey = process.env.VEYRA_API_KEY as string;

describe("receptionist conversation flow", () => {
  let businessId: string;
  let conversationId: string;

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates a business", async () => {
    const res = await request(app)
      .post("/api/businesses")
      .set("x-api-key", apiKey)
      .send({
        name: "Veyra Dental",
        hours: "Mon-Fri 8am-6pm",
        services: [{ name: "Whitening", priceLabel: "$250" }]
      });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Veyra Dental");
    expect(res.body.services[0].name).toBe("Whitening");
    businessId = res.body.id;
  });

  it("rejects requests without an api key", async () => {
    const res = await request(app).get("/api/businesses");
    expect(res.status).toBe(401);
  });

  it("starts a conversation and receives a greeting", async () => {
    const res = await request(app)
      .post("/api/conversations")
      .set("x-api-key", apiKey)
      .send({ businessId, callerName: "Sam" });

    expect(res.status).toBe(201);
    expect(res.body.conversation.businessId).toBe(businessId);
    expect(res.body.greeting.sender).toBe("receptionist");
    conversationId = res.body.conversation.id;
  });

  it("responds to a caller message about booking an appointment with structured intent", async () => {
    const res = await request(app)
      .post(`/api/conversations/${conversationId}/messages`)
      .set("x-api-key", apiKey)
      .send({ text: "I'd like to book an appointment for tomorrow" });

    expect(res.status).toBe(201);
    expect(res.body.callerMessage.sender).toBe("caller");
    expect(res.body.receptionistMessage.text.toLowerCase()).toContain("booking");
    expect(res.body.receptionistMessage.intent).toBe("booking");
    expect(res.body.receptionistMessage.action).toBe("show_booking_form");
    expect(res.body.receptionistMessage.requiresClarification).toBe(false);
  });

  it("recognizes a human escalation request and flags it on the message", async () => {
    const res = await request(app)
      .post(`/api/conversations/${conversationId}/messages`)
      .set("x-api-key", apiKey)
      .send({ text: "Can I talk to a real person please?" });

    expect(res.status).toBe(201);
    expect(res.body.receptionistMessage.intent).toBe("escalation");
    expect(res.body.receptionistMessage.action).toBe("escalate_to_human");
  });

  it("creates an appointment tied to the conversation", async () => {
    const res = await request(app)
      .post(`/api/conversations/${conversationId}/appointments`)
      .set("x-api-key", apiKey)
      .send({ requestedTime: "2026-08-18T14:00:00Z", notes: "First-time patient" });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("submitted");
    expect(res.body.businessId).toBe(businessId);
  });

  it("returns the full transcript for the conversation with structured intent preserved", async () => {
    const res = await request(app)
      .get(`/api/conversations/${conversationId}`)
      .set("x-api-key", apiKey);

    expect(res.status).toBe(200);
    expect(res.body.messages.length).toBeGreaterThanOrEqual(5);

    const escalated = res.body.messages.find((m: { intent: string | null }) => m.intent === "escalation");
    expect(escalated).toBeDefined();
    expect(escalated.action).toBe("escalate_to_human");
    expect(typeof escalated.confidence).toBe("number");
    expect(escalated.requiresClarification).toBe(false);

    // Caller messages carry no classification fields.
    const callerMsg = res.body.messages.find((m: { sender: string }) => m.sender === "caller");
    expect(callerMsg.intent).toBeNull();
    expect(callerMsg.action).toBeNull();
  });

  it("answers a service/price question using only the business's configured services", async () => {
    const res = await request(app)
      .post(`/api/conversations/${conversationId}/messages`)
      .set("x-api-key", apiKey)
      .send({ text: "How much is whitening?" });

    expect(res.status).toBe(201);
    expect(res.body.receptionistMessage.text).toContain("$250");
  });

  it("switches intent mid-conversation instead of staying stuck in the booking flow", async () => {
    const convo = await request(app)
      .post("/api/conversations")
      .set("x-api-key", apiKey)
      .send({ businessId });
    const id = convo.body.conversation.id as string;

    const send = async (text: string) => {
      const res = await request(app)
        .post(`/api/conversations/${id}/messages`)
        .set("x-api-key", apiKey)
        .send({ text });
      expect(res.status).toBe(201);
      return res.body.receptionistMessage;
    };

    const booking = await send("appointment booking");
    expect(booking.intent).toBe("booking");
    expect(booking.action).toBe("show_booking_form");

    // The originally reported bug: this came back as "Got it — I've noted that down."
    const pricing = await send("prices");
    expect(pricing.intent).toBe("pricing");
    expect(pricing.text.toLowerCase()).toContain("which treatment");
    expect(pricing.text.toLowerCase()).not.toContain("noted that down");
    expect(pricing.action).toBe("none");

    const whitening = await send("How much is whitening?");
    expect(whitening.text).toContain("$250");
    expect(whitening.action).toBe("none");
  });

  it("gives an honest out-of-scope answer rather than hallucinating", async () => {
    const convo = await request(app)
      .post("/api/conversations")
      .set("x-api-key", apiKey)
      .send({ businessId });
    const id = convo.body.conversation.id as string;

    const res = await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set("x-api-key", apiKey)
      .send({ text: "What is the population of Mars?" });

    expect(res.status).toBe(201);
    expect(res.body.receptionistMessage.intent).toBe("out_of_scope");
    expect(res.body.receptionistMessage.text.toLowerCase()).toContain("don't have that information");
  });

  it("never reports an appointment as confirmed when only a request was stored", async () => {
    const convo = await request(app)
      .post("/api/conversations")
      .set("x-api-key", apiKey)
      .send({ businessId });
    const id = convo.body.conversation.id as string;

    const appt = await request(app)
      .post(`/api/conversations/${id}/appointments`)
      .set("x-api-key", apiKey)
      .send({ requestedTime: "2026-09-20T10:00:00Z" });

    expect(appt.status).toBe(201);
    expect(appt.body.status).toBe("submitted");
    expect(appt.body.status).not.toBe("confirmed");
    expect(appt.body.submittedAt).toBeTruthy();
  });

  it("returns the executed action result alongside the reply", async () => {
    const convo = await request(app)
      .post("/api/conversations")
      .set("x-api-key", apiKey)
      .send({ businessId });
    const id = convo.body.conversation.id as string;

    const booking = await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set("x-api-key", apiKey)
      .send({ text: "I want to book an appointment" });
    expect(booking.body.actionResult).toMatchObject({
      action: "show_booking_form",
      status: "ready"
    });

    const escalation = await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set("x-api-key", apiKey)
      .send({ text: "I want to speak to a person" });
    expect(escalation.body.actionResult).toMatchObject({
      action: "escalate_to_human",
      status: "pending"
    });
    expect(escalation.body.actionResult.metadata.escalationId).toBeTruthy();

    // The escalation was really recorded, not just described.
    const stored = await prisma.escalation.findMany({ where: { conversationId: id } });
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe("requested");
  });
});

describe("capability enforcement through the API", () => {
  let limitedBusinessId: string;
  let conversationId: string;

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates a business with booking and escalation switched off", async () => {
    const res = await request(app)
      .post("/api/businesses")
      .set("x-api-key", apiKey)
      .send({
        name: "No Capabilities Dental",
        capabilities: { booking_requests: false, human_escalation: false }
      });

    expect(res.status).toBe(201);
    expect(res.body.capabilities.booking_requests).toBe(false);
    expect(res.body.capabilities.human_escalation).toBe(false);
    limitedBusinessId = res.body.id;

    const convo = await request(app)
      .post("/api/conversations")
      .set("x-api-key", apiKey)
      .send({ businessId: limitedBusinessId });
    conversationId = convo.body.conversation.id;
  });

  it("does not offer or execute booking when the capability is off", async () => {
    const res = await request(app)
      .post(`/api/conversations/${conversationId}/messages`)
      .set("x-api-key", apiKey)
      .send({ text: "I want to book an appointment" });

    expect(res.status).toBe(201);
    expect(res.body.receptionistMessage.action).toBe("none");
    expect(res.body.actionResult.status).toBe("not_required");
    expect(res.body.receptionistMessage.text).toContain("not able to take appointment requests");
  });

  it("does not promise or record an escalation when the capability is off", async () => {
    const res = await request(app)
      .post(`/api/conversations/${conversationId}/messages`)
      .set("x-api-key", apiKey)
      .send({ text: "I want to speak to a person" });

    expect(res.status).toBe(201);
    expect(res.body.receptionistMessage.action).toBe("none");
    expect(await prisma.escalation.count({ where: { businessId: limitedBusinessId } })).toBe(0);
  });

  it("rejects a direct booking request for a business that cannot take them", async () => {
    const res = await request(app)
      .post(`/api/conversations/${conversationId}/appointments`)
      .set("x-api-key", apiKey)
      .send({ requestedTime: "2026-09-20T10:00:00Z" });

    expect(res.status).toBe(422);
    expect(await prisma.appointment.count({ where: { businessId: limitedBusinessId } })).toBe(0);
  });
});
