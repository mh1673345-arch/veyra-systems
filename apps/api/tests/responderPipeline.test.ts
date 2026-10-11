import { describe, expect, it, vi } from "vitest";
import { ReceptionistResponder } from "../src/services/ai/index.js";
import { RuleBasedResponder } from "../src/services/ai/ruleBasedResponder.js";
import type {
  BusinessContext,
  FallbackReason,
  PrimaryResponder,
  ResponderOutcome
} from "../src/services/ai/types.js";

const context: BusinessContext = {
  name: "SmileCare Dental",
  description: "A friendly dental practice.",
  hours: "Mon-Fri 8am-6pm",
  location: "245 Maple Street",
  contactPhone: "(555) 018-2345",
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

function stubPrimary(outcome: ResponderOutcome): PrimaryResponder {
  return { name: "anthropic", attempt: vi.fn().mockResolvedValue(outcome) };
}

const params = { callerText: "How much is whitening?", history: [], context };

describe("ReceptionistResponder pipeline", () => {
  it("uses the Anthropic result when the provider succeeds", async () => {
    const primary = stubPrimary({
      ok: true,
      result: {
        intent: "pricing",
        message: "Whitening is $250 and takes about an hour.",
        confidence: 0.92,
        action: "none",
        requiresClarification: false
      }
    });

    const pipeline = new ReceptionistResponder(primary);
    const { result, trace } = await pipeline.respondTraced(params);

    expect(trace).toEqual({ responder: "anthropic", fallbackReason: null });
    expect(result.message).toContain("takes about an hour");
  });

  it("falls back to the deterministic responder for every decline reason", async () => {
    const reasons: FallbackReason[] = [
      "provider_error",
      "invalid_output",
      "low_confidence",
      "unsupported_action"
    ];

    for (const reason of reasons) {
      const pipeline = new ReceptionistResponder(stubPrimary({ ok: false, reason }));
      const { result, trace } = await pipeline.respondTraced(params);

      expect(trace, `for ${reason}`).toEqual({ responder: "rule-based", fallbackReason: reason });
      // The deterministic answer, grounded in the seeded price.
      expect(result.message, `for ${reason}`).toContain("$250");
      expect(result.intent, `for ${reason}`).toBe("pricing");
    }
  });

  it("uses the deterministic responder with a no_api_key reason when unconfigured", async () => {
    const pipeline = new ReceptionistResponder(null);
    const { result, trace } = await pipeline.respondTraced(params);

    expect(trace).toEqual({ responder: "rule-based", fallbackReason: "no_api_key" });
    expect(result.message).toContain("$250");
  });

  it("never surfaces a provider failure as a customer-facing error message", async () => {
    const pipeline = new ReceptionistResponder(stubPrimary({ ok: false, reason: "provider_error" }));
    const { result } = await pipeline.respondTraced(params);

    const lower = result.message.toLowerCase();
    expect(lower).not.toContain("error");
    expect(lower).not.toContain("having trouble");
    expect(lower).not.toContain("api");
  });

  it("keeps the deterministic responder available as a standalone implementation", async () => {
    const rules = new RuleBasedResponder();
    const result = await rules.respond(params);
    expect(result.message).toContain("$250");
  });
});
