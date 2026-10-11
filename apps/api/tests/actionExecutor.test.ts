import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BusinessCapabilities } from "@veyra/shared";
import { prisma } from "../src/db/client.js";
import { executeAssistantAction } from "../src/services/actions/actionExecutor.js";

const fullCapabilities: BusinessCapabilities = {
  booking_requests: true,
  calendar_booking: false,
  human_escalation: true,
  whatsapp: false,
  sms: false,
  email_notifications: false
};

let businessId: string;
let conversationId: string;

beforeAll(async () => {
  const business = await prisma.business.create({ data: { name: "Action Test Dental" } });
  const conversation = await prisma.conversation.create({
    data: { businessId: business.id }
  });
  businessId = business.id;
  conversationId = conversation.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

const baseParams = () => ({
  conversationId,
  businessId,
  capabilities: fullCapabilities,
  callerText: "I need help"
});

describe("action execution boundary", () => {
  it("treats 'none' as nothing to do", async () => {
    const result = await executeAssistantAction({ ...baseParams(), action: "none" });
    expect(result).toEqual({ action: "none", status: "not_required" });
  });

  it("marks a supported booking request as ready without creating a booking", async () => {
    const before = await prisma.appointment.count({ where: { businessId } });
    const result = await executeAssistantAction({ ...baseParams(), action: "show_booking_form" });

    expect(result.status).toBe("ready");
    expect(result.action).toBe("show_booking_form");
    // Surfacing the form must not itself create a request.
    expect(await prisma.appointment.count({ where: { businessId } })).toBe(before);
  });

  it("refuses a booking request when the business does not support booking_requests", async () => {
    const result = await executeAssistantAction({
      ...baseParams(),
      action: "show_booking_form",
      capabilities: { ...fullCapabilities, booking_requests: false }
    });

    expect(result.status).toBe("unsupported");
    expect(result.action).toBe("show_booking_form");
  });

  it("never reports calendar booking as available when calendar_booking is off", async () => {
    const result = await executeAssistantAction({ ...baseParams(), action: "show_booking_form" });
    expect(result.metadata?.calendarBooking).toBe("false");
    expect(result.status).not.toBe("completed");
  });

  it("records an escalation and reports it as pending, not completed", async () => {
    const result = await executeAssistantAction({
      ...baseParams(),
      action: "escalate_to_human",
      callerText: "I want to speak to a person"
    });

    expect(result.status).toBe("pending");
    const escalationId = result.metadata?.escalationId;
    expect(escalationId).toBeTruthy();

    const stored = await prisma.escalation.findUnique({ where: { id: escalationId as string } });
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe("requested");
    expect(stored?.conversationId).toBe(conversationId);
    expect(stored?.reason).toContain("speak to a person");
  });

  it("refuses escalation when the business does not support human_escalation", async () => {
    const before = await prisma.escalation.count({ where: { businessId } });
    const result = await executeAssistantAction({
      ...baseParams(),
      action: "escalate_to_human",
      capabilities: { ...fullCapabilities, human_escalation: false }
    });

    expect(result.status).toBe("unsupported");
    // Nothing persisted for an unsupported action.
    expect(await prisma.escalation.count({ where: { businessId } })).toBe(before);
  });

  it("fails safely on a malformed or unknown action", async () => {
    for (const action of ["create_booking_request", "send_whatsapp", "", "DROP TABLE"]) {
      const result = await executeAssistantAction({ ...baseParams(), action });
      expect(result.status, `for "${action}"`).toBe("failed");
      expect(result.action, `for "${action}"`).toBe("none");
    }
  });

  it("fails rather than executing when required data is missing", async () => {
    const result = await executeAssistantAction({
      ...baseParams(),
      action: "escalate_to_human",
      conversationId: "does-not-exist"
    });

    expect(result.status).toBe("failed");
    expect(result.message).not.toContain("prisma");
  });

  it("never returns 'completed' for anything this prototype cannot actually complete", async () => {
    const actions = ["none", "show_booking_form", "escalate_to_human"];
    for (const action of actions) {
      const result = await executeAssistantAction({ ...baseParams(), action });
      expect(result.status, `for ${action}`).not.toBe("completed");
    }
  });
});
