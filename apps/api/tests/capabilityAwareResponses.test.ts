import { describe, expect, it } from "vitest";
import type { BusinessCapabilities } from "@veyra/shared";
import { RuleBasedResponder } from "../src/services/ai/ruleBasedResponder.js";
import { formatBusinessContextForPrompt } from "../src/services/businessContext.js";
import type { BusinessContext } from "../src/services/ai/types.js";

const smileCareCapabilities: BusinessCapabilities = {
  booking_requests: true,
  calendar_booking: false,
  human_escalation: true,
  whatsapp: false,
  sms: false,
  email_notifications: false
};

function contextWith(capabilities: Partial<BusinessCapabilities>): BusinessContext {
  return {
    name: "SmileCare Dental",
    description: "A friendly dental practice.",
    hours: "Mon-Fri 8am-6pm",
    location: "245 Maple Street",
    contactPhone: "(555) 018-2345",
    contactEmail: "hello@smilecaredental.example",
    bookingRules: "Reviewed by staff.",
    escalationRules: "Escalate anything not on file.",
    capabilities: { ...smileCareCapabilities, ...capabilities },
    services: [{ name: "Routine cleaning", description: "Standard cleaning.", priceLabel: "$120" }],
    faqs: []
  };
}

const responder = new RuleBasedResponder();
const ask = (callerText: string, context: BusinessContext) =>
  responder.respond({ callerText, history: [], context });

describe("capability-aware responses", () => {
  it("offers to submit a request but not confirm a time when calendar_booking is off", async () => {
    const reply = await ask("Book me tomorrow at 3.", contextWith({}));

    expect(reply.intent).toBe("booking");
    expect(reply.action).toBe("show_booking_form");
    expect(reply.message).toContain("can't confirm live availability");
    expect(reply.message.toLowerCase()).not.toContain("you're booked");
    expect(reply.message.toLowerCase()).not.toContain("is confirmed");
  });

  it("does not hedge about live availability when calendar_booking is on", async () => {
    const reply = await ask("Book me tomorrow at 3.", contextWith({ calendar_booking: true }));
    expect(reply.action).toBe("show_booking_form");
    expect(reply.message).not.toContain("can't confirm live availability");
  });

  it("does not offer booking at all when booking_requests is off", async () => {
    const reply = await ask("I want an appointment tomorrow.", contextWith({ booking_requests: false }));

    expect(reply.action).toBe("none");
    expect(reply.message).toContain("not able to take appointment requests");
    // Still gives the caller a real way to get help.
    expect(reply.message).toContain("(555) 018-2345");
  });

  it("returns the escalation action when human_escalation is on", async () => {
    const reply = await ask("I want to speak to a person.", contextWith({}));
    expect(reply.intent).toBe("escalation");
    expect(reply.action).toBe("escalate_to_human");
  });

  it("does not promise a human when human_escalation is off", async () => {
    const reply = await ask("I want to speak to a person.", contextWith({ human_escalation: false }));

    expect(reply.action).toBe("none");
    expect(reply.message).toContain("not able to put you through");
    expect(reply.message).toContain("(555) 018-2345");
  });

  it("declines WhatsApp follow-up when the channel is off", async () => {
    const reply = await ask("Send the confirmation on WhatsApp.", contextWith({}));

    expect(reply.message).toContain("don't offer WhatsApp");
    expect(reply.action).toBe("none");
  });

  it("offers WhatsApp only when the channel is genuinely enabled", async () => {
    const reply = await ask("Send the confirmation on WhatsApp.", contextWith({ whatsapp: true }));
    expect(reply.message).toContain("we can follow up by WhatsApp");
  });

  it("declines SMS and email follow-up when those channels are off", async () => {
    const sms = await ask("Can you text me the details?", contextWith({}));
    expect(sms.message).toContain("don't offer text message");

    const email = await ask("Can you email me the details?", contextWith({}));
    expect(email.message).toContain("don't offer email");
  });

  it("tells the model which capabilities are unavailable", () => {
    const prompt = formatBusinessContextForPrompt(contextWith({}));

    expect(prompt).toContain("Capabilities");
    expect(prompt).toMatch(/WhatsApp follow-up: NOT AVAILABLE/);
    expect(prompt).toMatch(/live calendar: NOT AVAILABLE/);
    expect(prompt).toMatch(/human staff member: AVAILABLE/);
  });
});
