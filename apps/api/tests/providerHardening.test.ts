import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BusinessContext } from "../src/services/ai/types.js";

const createMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: createMock } }))
}));

const { AnthropicResponder } = await import("../src/services/ai/anthropicResponder.js");
const {
  MAX_CALLER_TEXT_CHARS,
  MAX_CONTEXT_FAQS,
  MAX_CONTEXT_SERVICES,
  MAX_HISTORY_TURNS,
  MAX_OUTPUT_TOKENS,
  MAX_PROVIDER_ATTEMPTS,
  MAX_TURN_CHARS,
  PROMPT_VERSION
} = await import("../src/services/ai/providerLimits.js");
const { providerHealthSnapshot, resetProviderHealth } = await import(
  "../src/services/ai/telemetry.js"
);
const { validateStartupConfig, ConfigurationError } = await import("../src/config/startup.js");

function contextWith(overrides: Partial<BusinessContext> = {}): BusinessContext {
  return {
    name: "SmileCare Dental",
    description: "A dental practice.",
    hours: "Mon-Fri 8am-6pm",
    location: "245 Maple Street",
    contactPhone: "(555) 018-2345",
    contactEmail: "hello@smilecare.example",
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
    faqs: [{ question: "Do you accept insurance?", answer: "Most major plans." }],
    ...overrides
  };
}

const validReply = {
  message: "Whitening is $250.",
  intent: "pricing",
  confidence: 0.9,
  action: "none",
  requiresClarification: false
};

function toolUse(input: Record<string, unknown> = validReply, usage?: Record<string, number>) {
  return {
    content: [{ type: "tool_use", id: "t1", name: "submit_receptionist_reply", input }],
    usage: usage ?? { input_tokens: 800, output_tokens: 40 },
    model: "claude-sonnet-5"
  };
}

/** Rejects the way the SDK does when an AbortSignal fires. */
function abortError() {
  const err = new Error("Request was aborted.");
  err.name = "AbortError";
  return err;
}

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

beforeEach(() => {
  createMock.mockReset();
  resetProviderHealth();
});

afterEach(() => {
  // Restore only the console spies. vi.restoreAllMocks() would also reset the
  // @anthropic-ai/sdk module mock, leaving the client undefined for every
  // subsequent test in this file.
  for (const method of ["log", "warn", "error"] as const) {
    (console[method] as unknown as { mockRestore?: () => void }).mockRestore?.();
  }
});

describe("cost controls", () => {
  it("caps output tokens on every request", async () => {
    createMock.mockResolvedValueOnce(toolUse());
    await new AnthropicResponder("k").attempt({
      callerText: "How much is whitening?",
      history: [],
      context: contextWith()
    });

    expect(createMock.mock.calls[0][0].max_tokens).toBe(MAX_OUTPUT_TOKENS);
  });

  it("caps how much conversation history is sent", async () => {
    createMock.mockResolvedValueOnce(toolUse());
    const history = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? ("caller" as const) : ("receptionist" as const),
      text: `turn ${i}`
    }));

    await new AnthropicResponder("k").attempt({
      callerText: "and now?",
      history,
      context: contextWith()
    });

    const messages = createMock.mock.calls[0][0].messages;
    // Bounded history plus the current message.
    expect(messages).toHaveLength(MAX_HISTORY_TURNS + 1);
    // The most recent turns are the ones kept.
    expect(messages[messages.length - 2].content).toBe("turn 39");
  });

  it("caps a single pathologically long turn", async () => {
    createMock.mockResolvedValueOnce(toolUse());
    await new AnthropicResponder("k").attempt({
      callerText: "x".repeat(MAX_TURN_CHARS + 500),
      history: [],
      context: contextWith()
    });

    const content = createMock.mock.calls[0][0].messages[0].content as string;
    expect(content.length).toBeLessThanOrEqual(MAX_TURN_CHARS + 1);
  });

  it("rejects an oversized message without paying for a provider call", async () => {
    const outcome = await new AnthropicResponder("k").attempt({
      callerText: "x".repeat(MAX_CALLER_TEXT_CHARS + 1),
      history: [],
      context: contextWith()
    });

    expect(outcome).toEqual({ ok: false, reason: "invalid_output" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("does not silently truncate the grounding a normal business needs", async () => {
    createMock.mockResolvedValueOnce(toolUse());
    const services = Array.from({ length: 20 }, (_, i) => ({
      name: `Service ${i}`,
      description: "",
      priceLabel: `$${i}`
    }));

    await new AnthropicResponder("k").attempt({
      callerText: "what do you offer?",
      history: [],
      context: contextWith({ services })
    });

    const system = createMock.mock.calls[0][0].system as string;
    // Every service is still in the prompt — the cap sits well above this.
    expect(services.length).toBeLessThanOrEqual(MAX_CONTEXT_SERVICES);
    for (const service of services) {
      expect(system).toContain(service.name);
    }
  });

  it("warns rather than silently dropping grounding when the cap does bite", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createMock.mockResolvedValueOnce(toolUse());

    await new AnthropicResponder("k").attempt({
      callerText: "what do you offer?",
      history: [],
      context: contextWith({
        services: Array.from({ length: MAX_CONTEXT_SERVICES + 5 }, (_, i) => ({
          name: `Service ${i}`,
          description: "",
          priceLabel: "$1"
        })),
        faqs: Array.from({ length: MAX_CONTEXT_FAQS + 3 }, (_, i) => ({
          question: `Q${i}`,
          answer: `A${i}`
        }))
      })
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Business context capped"),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });
});

describe("timeouts", () => {
  it("falls back with provider_timeout when the call is aborted", async () => {
    createMock.mockRejectedValueOnce(abortError());

    const outcome = await new AnthropicResponder("k").attempt({
      callerText: "How much is whitening?",
      history: [],
      context: contextWith()
    });

    expect(outcome).toEqual({ ok: false, reason: "provider_timeout" });
  });

  it("passes an abort signal so a hung call is actually cancelled", async () => {
    createMock.mockResolvedValueOnce(toolUse());
    await new AnthropicResponder("k").attempt({
      callerText: "hi",
      history: [],
      context: contextWith()
    });

    const options = createMock.mock.calls[0][1];
    expect(options?.signal).toBeDefined();
  });

  it("never retries after a timeout, because the outcome is ambiguous", async () => {
    createMock.mockRejectedValue(abortError());

    await new AnthropicResponder("k").attempt({
      callerText: "hi",
      history: [],
      context: contextWith()
    });

    // One attempt only: a repeat could produce a different action.
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

describe("retry policy", () => {
  it("retries once for a transient 429 that never reached the model", async () => {
    createMock.mockRejectedValueOnce(httpError(429)).mockResolvedValueOnce(toolUse());

    const outcome = await new AnthropicResponder("k").attempt({
      callerText: "How much is whitening?",
      history: [],
      context: contextWith()
    });

    expect(outcome.ok).toBe(true);
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 5xx but stops at the bounded attempt limit", async () => {
    createMock.mockRejectedValue(httpError(503));

    const outcome = await new AnthropicResponder("k").attempt({
      callerText: "hi",
      history: [],
      context: contextWith()
    });

    expect(outcome).toEqual({ ok: false, reason: "provider_error" });
    expect(createMock).toHaveBeenCalledTimes(MAX_PROVIDER_ATTEMPTS);
  });

  it("does not retry a 400, which the model already answered or refused", async () => {
    createMock.mockRejectedValue(httpError(400));

    await new AnthropicResponder("k").attempt({
      callerText: "hi",
      history: [],
      context: contextWith()
    });

    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a malformed but successful response", async () => {
    createMock.mockResolvedValueOnce(toolUse({ message: "", intent: "nonsense" }));

    const outcome = await new AnthropicResponder("k").attempt({
      callerText: "hi",
      history: [],
      context: contextWith()
    });

    // Re-asking could yield a different action; prefer the deterministic answer.
    expect(outcome).toEqual({ ok: false, reason: "invalid_output" });
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

describe("observability", () => {
  it("logs model, prompt version, duration, tokens, intent and action on success", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    createMock.mockResolvedValueOnce(toolUse(validReply, { input_tokens: 812, output_tokens: 44 }));

    await new AnthropicResponder("k").attempt({
      callerText: "How much is whitening?",
      history: [],
      context: contextWith()
    });

    const line = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(line).toContain("responder=anthropic");
    expect(line).toContain("model=claude-sonnet-5");
    expect(line).toContain(`promptVersion=${PROMPT_VERSION}`);
    expect(line).toContain("outcome=success");
    expect(line).toContain("intent=pricing");
    expect(line).toContain("inputTokens=812");
    expect(line).toContain("outputTokens=44");
    expect(line).toContain("durationMs=");
  });

  it("never logs the system prompt, the caller's message or the API key", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    createMock.mockResolvedValueOnce(toolUse());

    await new AnthropicResponder("sk-ant-secret-value").attempt({
      callerText: "my private medical question",
      history: [],
      context: contextWith()
    });

    const output = [...log.mock.calls, ...error.mock.calls].map((c) => c.join(" ")).join("\n");
    expect(output).not.toContain("sk-ant-secret-value");
    expect(output).not.toContain("my private medical question");
    expect(output).not.toContain("You are Veyra");
  });

  it("tracks degradation after repeated fallbacks without affecting the caller", async () => {
    createMock.mockRejectedValue(httpError(400));
    const responder = new AnthropicResponder("k");

    for (let i = 0; i < 3; i += 1) {
      await responder.attempt({ callerText: "hi", history: [], context: contextWith() });
    }

    const health = providerHealthSnapshot();
    expect(health.degraded).toBe(true);
    expect(health.lastOutcome).toBe("fallback");
    expect(health.consecutiveFailures).toBeGreaterThanOrEqual(3);
  });

  it("clears degradation once a call succeeds", async () => {
    createMock.mockRejectedValueOnce(httpError(400)).mockResolvedValueOnce(toolUse());
    const responder = new AnthropicResponder("k");

    await responder.attempt({ callerText: "hi", history: [], context: contextWith() });
    await responder.attempt({ callerText: "hi", history: [], context: contextWith() });

    expect(providerHealthSnapshot().consecutiveFailures).toBe(0);
    expect(providerHealthSnapshot().degraded).toBe(false);
  });
});

describe("startup configuration validation", () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it("accepts the development configuration and reports optional integrations", () => {
    process.env.NODE_ENV = "development";
    process.env.DATABASE_URL = "postgresql://veyra:pw@127.0.0.1:5434/veyra_dev";
    process.env.VEYRA_API_KEY = "dev-local-key";
    delete process.env.ANTHROPIC_API_KEY;

    const report = validateStartupConfig();
    expect(report.environment).toBe("development");
    // Missing optional integrations are reported, not fatal.
    expect(report.anthropic).toBe("disabled");
    expect(report.warnings.join(" ")).toContain("ANTHROPIC_API_KEY is not set");
  });

  it("refuses production without a pinned web origin", () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgresql://user:pass@db/veyra";
    process.env.VEYRA_API_KEY = "k";
    delete process.env.VEYRA_WEB_ORIGIN;

    expect(() => validateStartupConfig()).toThrow(ConfigurationError);
  });

  it("refuses an http origin in production, because Secure cookies won't be sent", () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgresql://user:pass@db/veyra";
    process.env.VEYRA_API_KEY = "k";
    process.env.VEYRA_WEB_ORIGIN = "http://app.example.com";

    expect(() => validateStartupConfig()).toThrow(/https/);
  });

  it("refuses a SQLite database in production", () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "file:./prod.db";
    process.env.VEYRA_API_KEY = "k";
    process.env.VEYRA_WEB_ORIGIN = "https://app.example.com";

    expect(() => validateStartupConfig()).toThrow(/SQLite/);
  });

  it("refuses the local test and development Postgres databases in production", () => {
    process.env.NODE_ENV = "production";
    process.env.VEYRA_API_KEY = "k";
    process.env.VEYRA_WEB_ORIGIN = "https://app.example.com";

    process.env.DATABASE_URL = "postgresql://veyra:pw@db:5432/veyra_test";
    expect(() => validateStartupConfig()).toThrow(/test database/);

    process.env.DATABASE_URL = "postgresql://veyra:pw@db:5432/veyra_dev";
    expect(() => validateStartupConfig()).toThrow(/development database/);
  });

  it("accepts a well-formed production configuration", () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgresql://user:pass@db/veyra";
    process.env.VEYRA_API_KEY = "k";
    process.env.VEYRA_WEB_ORIGIN = "https://app.example.com";

    const report = validateStartupConfig();
    expect(report.environment).toBe("production");
    // Production with nothing configured says so instead of pretending.
    expect(report.email).toBe("unconfigured");
  });
});
