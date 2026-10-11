import { afterAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

const respondMock = vi.fn().mockResolvedValue({
  result: {
    intent: "acknowledgement",
    message: "ok",
    confidence: 0.8,
    action: "none",
    requiresClarification: false
  },
  trace: { responder: "rule-based", fallbackReason: null }
});

vi.mock("../src/services/ai/index.js", () => ({
  createAiResponder: () => ({ name: "rule-based", respondTraced: respondMock })
}));

const { createApp } = await import("../src/app.js");
const { prisma } = await import("../src/db/client.js");

const app = createApp();
const apiKey = process.env.VEYRA_API_KEY as string;

describe("conversation memory window", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("bounds the history sent to the AI responder instead of sending the full transcript", async () => {
    const businessRes = await request(app)
      .post("/api/businesses")
      .set("x-api-key", apiKey)
      .send({ name: "History Test Dental" });
    const businessId = businessRes.body.id as string;

    const conversationRes = await request(app)
      .post("/api/conversations")
      .set("x-api-key", apiKey)
      .send({ businessId });
    const conversationId = conversationRes.body.conversation.id as string;

    for (let i = 0; i < 20; i += 1) {
      await request(app)
        .post(`/api/conversations/${conversationId}/messages`)
        .set("x-api-key", apiKey)
        .send({ text: `message number ${i}` });
    }

    expect(respondMock).toHaveBeenCalled();
    const lastCallHistory = respondMock.mock.calls.at(-1)?.[0].history as unknown[];

    expect(lastCallHistory.length).toBeLessThanOrEqual(12);
    expect(lastCallHistory.length).toBeGreaterThan(0);
  });
});
