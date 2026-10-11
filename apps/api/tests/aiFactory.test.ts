import { afterEach, describe, expect, it, vi } from "vitest";
import type { BusinessContext } from "../src/services/ai/types.js";

const context: BusinessContext = {
  name: "SmileCare Dental",
  description: "A friendly dental practice.",
  hours: "Mon-Fri 8am-6pm",
  location: "245 Maple Street",
  contactPhone: null,
  contactEmail: null,
  bookingRules: "Reviewed by staff.",
  escalationRules: "Escalate anything not on file.",
  capabilities: {
    booking_requests: true,
    calendar_booking: false,
    human_escalation: true,
    whatsapp: false,
    sms: false,
    email_notifications: false
  },
  services: [{ name: "Teeth whitening", description: "In-office.", priceLabel: "$250" }],
  faqs: []
};

describe("createAiResponder", () => {
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.resetModules();
  });

  it("answers via the deterministic responder when ANTHROPIC_API_KEY is not set", async () => {
    vi.resetModules();
    const { createAiResponder } = await import("../src/services/ai/index.js");
    // Importing the module graph above transitively loads @prisma/client, which
    // reloads .env as a side effect and can silently resurrect a real key from
    // a developer's local apps/api/.env — strip it again right before the call.
    delete process.env.ANTHROPIC_API_KEY;

    const { trace } = await createAiResponder().respondTraced({
      callerText: "How much is whitening?",
      history: [],
      context
    });

    expect(trace).toEqual({ responder: "rule-based", fallbackReason: "no_api_key" });
  });

  it("wires up the Anthropic responder as primary when ANTHROPIC_API_KEY is set", async () => {
    vi.resetModules();
    const { createAiResponder } = await import("../src/services/ai/index.js");
    process.env.ANTHROPIC_API_KEY = "test-key";

    // Constructing the client makes no network call; name reflects the primary.
    expect(createAiResponder().name).toBe("anthropic");
  });
});
