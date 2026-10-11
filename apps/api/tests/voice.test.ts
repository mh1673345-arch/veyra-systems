import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { CSRF_COOKIE, hashPassword } from "../src/services/auth/sessions.js";
import { changePlan } from "../src/services/access/accessService.js";
import { processVoiceWebhook } from "../src/services/voice/session.js";
import { canTransitionCall } from "../src/services/voice/callState.js";
import { fakeTtsProvider, fakeVoiceProvider } from "../src/services/voice/registry.js";
import { fakeVoiceWebhookSecret, signVoiceEvent } from "../src/services/voice/providers/fakeVoice.js";
import { verifyTwilioSignature } from "../src/services/voice/providers/twilioVoice.js";
import { VoiceWebhookVerificationError } from "../src/services/voice/types.js";
import { createCalendarBusiness, fakeCalendarProvider, resetFakeCalendar } from "./helpers/calendarFixtures.js";

/**
 * Voice — the Max channel.
 *
 * The claim these tests exist to check is not "audio works" (no audio exists
 * here) but "a phone call is the same Veyra": the same entitlements, the same
 * grounded answers, the same booking confirmation rules, the same escalation,
 * the same records. Plus the things that are genuinely telephony's problem —
 * signature verification, retried events, and a call state machine.
 */

const app = createApp();
const PASSWORD = "harbour-quay-lantern-5520";

interface Session {
  cookie: string;
  csrf: string;
}
const authed = (r: request.Test, session: Session) => r.set({ Cookie: session.cookie, "x-csrf-token": session.csrf });
const base = (businessId: string) => `/api/ops/businesses/${businessId}`;

let passwordHash: string;
let counter = 0;
const savedEnv = { ...process.env };

async function member(businessId: string, role: string): Promise<Session> {
  counter += 1;
  const user = await prisma.user.create({
    data: { email: `${role.toLowerCase()}-${counter}-${Date.now()}@voice.test`, name: role, passwordHash }
  });
  await prisma.businessMembership.create({ data: { userId: user.id, businessId, role } });
  const res = await request(app).post("/api/auth/login").send({ email: user.email, password: PASSWORD });
  const cookies = res.headers["set-cookie"] as unknown as string[];
  return {
    cookie: cookies.map((cookie) => cookie.split(";")[0]).join("; "),
    csrf: cookies.find((cookie) => cookie.startsWith(CSRF_COOKIE))!.split(";")[0].split("=")[1]
  };
}

let phoneCounter = 0;
// Unique per business AND per run: the test database keeps rows between runs,
// and a phone number is unique across businesses by design.
const runToken = String(Date.now()).slice(-5);
function nextNumber(): string {
  phoneCounter += 1;
  return `+1${runToken}${String(phoneCounter).padStart(5, "0")}`;
}

/** A Max business with voice switched on and a number to answer. */
async function voiceBusiness(
  options: { plan?: "STARTER" | "PRO" | "MAX"; enabled?: boolean; calendarBooking?: boolean; handoffNumber?: string | null } = {}
) {
  const fixture = await createCalendarBusiness({
    plan: options.plan ?? "MAX",
    calendarBooking: options.calendarBooking ?? false,
    namePrefix: "Voice"
  });
  await prisma.business.update({
    where: { id: fixture.businessId },
    data: { receptionStatus: "active", escalationPhone: "+15550009999", contactPhone: "+15550009999" }
  });
  const number = nextNumber();
  await prisma.voiceSettings.create({
    data: {
      businessId: fixture.businessId,
      enabled: options.enabled ?? true,
      businessPhoneNumber: number,
      handoffNumber: options.handoffNumber === undefined ? "+15550008888" : options.handoffNumber
    }
  });
  const owner = await member(fixture.businessId, "OWNER");
  return { ...fixture, number, owner };
}

/** Delivers whatever the fake carrier has queued, through the real webhook route. */
async function deliverVoiceEvents() {
  const results = [];
  for (const event of fakeVoiceProvider.drainSignedEvents()) {
    const res = await request(app).post("/api/voice/webhooks/fake").set(event.headers).send(event.rawBody);
    results.push({ eventId: event.eventId, status: res.status, outcome: res.body?.outcome as string });
  }
  return results;
}

/** A whole inbound call: ring, answer, and whatever Veyra said. */
async function placeCall(to: string, from = "+15557654321") {
  const { externalCallId } = fakeVoiceProvider.simulateInboundCall({ from, to });
  await deliverVoiceEvents();
  fakeVoiceProvider.simulateAnswered(externalCallId);
  await deliverVoiceEvents();
  return externalCallId;
}

async function callerSays(externalCallId: string, text: string) {
  fakeVoiceProvider.simulateCallerSpeech(externalCallId, text);
  await deliverVoiceEvents();
  return fakeVoiceProvider.spokenOn(externalCallId).map((line) => line.text);
}

const lastSpoken = (externalCallId: string) => fakeVoiceProvider.spokenOn(externalCallId).at(-1)?.text ?? "";

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
}, 60_000);

beforeEach(() => {
  process.env.VEYRA_VOICE_PROVIDER = "fake";
  fakeVoiceProvider.reset();
  fakeTtsProvider.reset();
  resetFakeCalendar();
});

afterEach(() => {
  if (savedEnv.VEYRA_VOICE_PROVIDER === undefined) delete process.env.VEYRA_VOICE_PROVIDER;
  else process.env.VEYRA_VOICE_PROVIDER = savedEnv.VEYRA_VOICE_PROVIDER;
});

afterAll(async () => {
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */

describe("entitlements", () => {
  it("refuses voice APIs to Starter and Pro, whatever the Console shows", async () => {
    for (const plan of ["STARTER", "PRO"] as const) {
      const fixture = await voiceBusiness({ plan });
      const overview = await authed(request(app).get(`${base(fixture.businessId)}/voice`), fixture.owner);
      expect(overview.status).toBe(200);
      expect(overview.body.entitled, plan).toBe(false);
      expect(overview.body.live, plan).toBe(false);
      expect(overview.body.blockedReason, plan).toMatch(/part of Max/i);

      // The backend is the boundary: an outbound call is refused outright.
      const outbound = await authed(request(app).post(`${base(fixture.businessId)}/calls`), fixture.owner).send({
        to: "+15551112222"
      });
      expect(outbound.status, plan).toBe(403);
      expect(outbound.body.code, plan).toBe("ENTITLEMENT_REQUIRED");
    }
  }, 90_000);

  it("does not answer an inbound call for a business without the plan", async () => {
    const fixture = await voiceBusiness({ plan: "PRO" });
    const externalCallId = await placeCall(fixture.number);

    const session = await prisma.callSession.findFirstOrThrow({ where: { businessId: fixture.businessId } });
    expect(session.status).toBe("missed");
    expect(session.hangupReason).toBe("voice_unavailable:entitlement");
    // No Reception automation started: no conversation, no transcript.
    expect(session.conversationId).toBeNull();
    expect(await prisma.conversation.count({ where: { businessId: fixture.businessId } })).toBe(1); // only the fixture's own
    // The caller hears something neutral — never anything about plans.
    expect(lastSpoken(externalCallId)).toMatch(/can't take automated calls/i);
    expect(lastSpoken(externalCallId)).not.toMatch(/plan|max|upgrade|subscription/i);
  }, 60_000);

  it("does not answer when the business has voice switched off", async () => {
    const fixture = await voiceBusiness({ enabled: false });
    await placeCall(fixture.number);
    const session = await prisma.callSession.findFirstOrThrow({ where: { businessId: fixture.businessId } });
    expect(session.status).toBe("missed");
    expect(session.hangupReason).toBe("voice_unavailable:not_configured");
  }, 60_000);

  it("answers for Max with voice configured", async () => {
    const fixture = await voiceBusiness();
    const externalCallId = await placeCall(fixture.number);
    const session = await prisma.callSession.findFirstOrThrow({
      where: { businessId: fixture.businessId, externalCallId }
    });
    expect(session.status).toBe("active");
    expect(session.conversationId).not.toBeNull();
    expect(lastSpoken(externalCallId)).toBeTruthy();
  }, 60_000);
});

/* ------------------------------------------------------------------ */

describe("a call uses the same Veyra", () => {
  it("answers a pricing question from the business's own services", async () => {
    const fixture = await voiceBusiness();
    const externalCallId = await placeCall(fixture.number);

    await callerSays(externalCallId, "how much is teeth whitening");
    // The same grounded answer the text channel gives — no voice-specific
    // pricing logic exists to disagree with it.
    expect(lastSpoken(externalCallId)).toMatch(/\$250/);

    const session = await prisma.callSession.findFirstOrThrow({ where: { externalCallId } });
    const messages = await prisma.message.findMany({
      where: { conversationId: session.conversationId! },
      orderBy: { createdAt: "asc" }
    });
    // The transcript is ordinary conversation history, with the same telemetry.
    expect(messages.map((m) => m.sender)).toEqual(["receptionist", "caller", "receptionist"]);
    expect(messages.at(-1)!.intent).toBe("pricing");
    expect(messages.at(-1)!.responder).toBe("rule_based");
  }, 60_000);

  it("records where each turn's time went", async () => {
    const fixture = await voiceBusiness();
    const externalCallId = await placeCall(fixture.number);
    await callerSays(externalCallId, "what are your opening hours");

    const session = await prisma.callSession.findFirstOrThrow({ where: { externalCallId } });
    const turn = await prisma.callTurn.findFirstOrThrow({ where: { callSessionId: session.id } });
    expect(turn.totalMs).toBeGreaterThanOrEqual(0);
    expect(turn.responderMs).not.toBeNull();
    expect(turn.ttsMs).not.toBeNull();
  }, 60_000);

  it("asks the caller to repeat when recognition produced nothing", async () => {
    const fixture = await voiceBusiness();
    const externalCallId = await placeCall(fixture.number);
    fakeVoiceProvider.simulateCallerSpeech(externalCallId, "   ");
    await deliverVoiceEvents();
    expect(lastSpoken(externalCallId)).toMatch(/didn't catch that/i);
  }, 60_000);

  it("keeps talking when speech synthesis fails", async () => {
    const fixture = await voiceBusiness();
    const externalCallId = await placeCall(fixture.number);
    fakeTtsProvider.failNext = new Error("tts is down");

    await callerSays(externalCallId, "how much is teeth whitening");
    // The caller still gets the answer; only the timing is missing.
    expect(lastSpoken(externalCallId)).toMatch(/\$250/);
    const session = await prisma.callSession.findFirstOrThrow({ where: { externalCallId } });
    const turn = await prisma.callTurn.findFirstOrThrow({ where: { callSessionId: session.id } });
    expect(turn.ttsMs).toBeNull();
  }, 60_000);

  it("stops speaking when the caller interrupts", async () => {
    const fixture = await voiceBusiness();
    const externalCallId = await placeCall(fixture.number);
    await callerSays(externalCallId, "what are your opening hours");

    fakeVoiceProvider.simulateInterruption(externalCallId);
    await deliverVoiceEvents();

    const spoken = fakeVoiceProvider.spokenOn(externalCallId);
    expect(spoken.at(-1)!.cancelled).toBe(true);
    const session = await prisma.callSession.findFirstOrThrow({ where: { externalCallId } });
    expect((await prisma.callTurn.findFirstOrThrow({ where: { callSessionId: session.id } })).interrupted).toBe(true);
  }, 60_000);
});

/* ------------------------------------------------------------------ */

describe("booking by phone", () => {
  it("offers a slot and books only after the caller says yes", async () => {
    const fixture = await voiceBusiness({ calendarBooking: true });
    const externalCallId = await placeCall(fixture.number);

    const proposal = await callerSays(externalCallId, "can I book a teeth whitening for tomorrow at 2pm");
    const offer = proposal.at(-1)!;
    // Availability was checked and offered — nothing booked from the first utterance.
    expect(offer).toMatch(/available|isn't free|can't take a booking|not open/i);
    expect(await prisma.appointment.count({ where: { businessId: fixture.businessId, status: "confirmed" } })).toBe(0);

    if (/available/i.test(offer)) {
      await callerSays(externalCallId, "yes please");
      const confirmed = await prisma.appointment.findFirst({
        where: { businessId: fixture.businessId, status: "confirmed" }
      });
      expect(confirmed).not.toBeNull();
      expect(fakeCalendarProvider.listEvents()).toHaveLength(1);

      // A second yes must not book twice.
      await callerSays(externalCallId, "yes");
      expect(await prisma.appointment.count({ where: { businessId: fixture.businessId, status: "confirmed" } })).toBe(1);
      expect(fakeCalendarProvider.listEvents()).toHaveLength(1);
    }
  }, 90_000);

  it("falls back to a request when the calendar cannot be reached", async () => {
    const fixture = await voiceBusiness({ calendarBooking: true });
    const externalCallId = await placeCall(fixture.number);
    fakeCalendarProvider.setFailure("unavailable");

    await callerSays(externalCallId, "can I book for tomorrow at 2pm");
    // Never silence, never a pretend booking.
    expect(lastSpoken(externalCallId)).toBeTruthy();
    expect(await prisma.appointment.count({ where: { businessId: fixture.businessId, status: "confirmed" } })).toBe(0);
    fakeCalendarProvider.setFailure(null);
  }, 60_000);
});

/* ------------------------------------------------------------------ */

describe("handoff", () => {
  it("transfers the call when a transfer number is configured", async () => {
    const fixture = await voiceBusiness();
    const externalCallId = await placeCall(fixture.number);

    await callerSays(externalCallId, "can I speak to a real person");
    const call = fakeVoiceProvider.callInfo(externalCallId)!;
    expect(call.status).toBe("transferring");
    expect(call.transferredTo).toBe("+15550008888");

    const session = await prisma.callSession.findFirstOrThrow({ where: { externalCallId } });
    expect(session.handoffOccurred).toBe(true);
    // The escalation is the ordinary one, created by the same action executor.
    expect(await prisma.escalation.count({ where: { businessId: fixture.businessId } })).toBe(1);
  }, 60_000);

  it("never pretends to transfer when it cannot, and still raises the escalation", async () => {
    const fixture = await voiceBusiness({ handoffNumber: null });
    const externalCallId = await placeCall(fixture.number);

    await callerSays(externalCallId, "can I speak to a real person");
    expect(fakeVoiceProvider.callInfo(externalCallId)!.status).toBe("active");
    expect(await prisma.escalation.count({ where: { businessId: fixture.businessId } })).toBe(1);
    // What the caller hears is the honest handoff message, not a transfer claim.
    expect(lastSpoken(externalCallId)).toMatch(/pass this to someone|follow up/i);
    expect(lastSpoken(externalCallId)).not.toMatch(/putting you through|transferring/i);
  }, 60_000);
});

/* ------------------------------------------------------------------ */

describe("webhooks", () => {
  it("rejects a forged event, a wrong secret and a stale one", async () => {
    const fixture = await voiceBusiness();
    fakeVoiceProvider.simulateInboundCall({ from: "+15557654321", to: fixture.number });
    const [event] = fakeVoiceProvider.drainSignedEvents();

    const tampered = event.rawBody.replace(fixture.number, "+15550000000");
    expect((await request(app).post("/api/voice/webhooks/fake").set(event.headers).send(tampered)).status).toBe(400);
    expect((await request(app).post("/api/voice/webhooks/fake").send(event.rawBody)).status).toBe(400);

    const parsed = JSON.parse(event.rawBody);
    const stale = signVoiceEvent(parsed, fakeVoiceWebhookSecret(), Math.floor(Date.now() / 1000) - 3600);
    expect((await request(app).post("/api/voice/webhooks/fake").set(stale.headers).send(stale.rawBody)).status).toBe(400);

    // Nothing was recorded by any of them.
    expect(await prisma.callSession.count({ where: { businessId: fixture.businessId } })).toBe(0);
  }, 60_000);

  it("handles a retried event once", async () => {
    const fixture = await voiceBusiness();
    fakeVoiceProvider.simulateInboundCall({ from: "+15557654321", to: fixture.number });
    const [event] = fakeVoiceProvider.drainSignedEvents();

    const outcomes = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).post("/api/voice/webhooks/fake").set(event.headers).send(event.rawBody);
      expect(res.status).toBe(200);
      outcomes.push(res.body.outcome);
    }
    expect(outcomes).toEqual(["processed", "duplicate", "duplicate"]);
    expect(await prisma.callSession.count({ where: { businessId: fixture.businessId } })).toBe(1);
    expect(await prisma.voiceWebhookEvent.count({ where: { externalEventId: event.eventId } })).toBe(1);
  }, 60_000);

  it("does not double-count minutes when a hangup is delivered twice", async () => {
    const fixture = await voiceBusiness();
    const externalCallId = await placeCall(fixture.number);
    fakeVoiceProvider.simulateCallerHangup(externalCallId);
    const [hangup] = fakeVoiceProvider.drainSignedEvents();

    await request(app).post("/api/voice/webhooks/fake").set(hangup.headers).send(hangup.rawBody);
    const after = await prisma.callSession.findFirstOrThrow({ where: { externalCallId } });

    // A carrier resending the same hangup with a different id must still not
    // change the recorded duration.
    const replay = signVoiceEvent({ ...JSON.parse(hangup.rawBody), id: `${hangup.eventId}-again` });
    const second = await request(app).post("/api/voice/webhooks/fake").set(replay.headers).send(replay.rawBody);
    expect(second.body.outcome).toBe("ignored");

    const final = await prisma.callSession.findFirstOrThrow({ where: { externalCallId } });
    expect(final.durationSeconds).toBe(after.durationSeconds);
    expect(final.status).toBe("completed");
  }, 60_000);

  it("ignores an event for a number no business answers", async () => {
    fakeVoiceProvider.simulateInboundCall({ from: "+15557654321", to: "+15559999999" });
    const results = await deliverVoiceEvents();
    expect(results[0].outcome).toBe("ignored");
  }, 60_000);

  it("refuses an unknown provider", async () => {
    expect((await request(app).post("/api/voice/webhooks/carrier-pigeon").send("{}")).status).toBe(404);
  });

  it("verifies Twilio's documented signature scheme (unit — no Twilio account)", () => {
    const authToken = "unit-test-auth-token";
    const url = "https://veyra.example/api/voice/webhooks/twilio";
    const form = { CallSid: "CA123", CallStatus: "completed", From: "+15551110000" };
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    const payload = url + Object.keys(form).sort().map((key) => `${key}${form[key as keyof typeof form]}`).join("");
    const signature = createHmac("sha1", authToken).update(payload, "utf8").digest("base64");

    expect(() => verifyTwilioSignature({ url, form, signature, authToken })).not.toThrow();
    expect(() => verifyTwilioSignature({ url, form, signature, authToken: "wrong" })).toThrow(VoiceWebhookVerificationError);
    expect(() => verifyTwilioSignature({ url, form: { ...form, CallStatus: "busy" }, signature, authToken })).toThrow(
      VoiceWebhookVerificationError
    );
    expect(() => verifyTwilioSignature({ url, form, signature: undefined, authToken })).toThrow(VoiceWebhookVerificationError);
  });
});

/* ------------------------------------------------------------------ */

describe("call state machine", () => {
  it("allows the real lifecycle and refuses the impossible", () => {
    expect(canTransitionCall("initiated", "ringing")).toBe(true);
    expect(canTransitionCall("ringing", "active")).toBe(true);
    expect(canTransitionCall("active", "transferring")).toBe(true);
    expect(canTransitionCall("transferring", "completed")).toBe(true);
    expect(canTransitionCall("ringing", "missed")).toBe(true);

    expect(canTransitionCall("completed", "active")).toBe(false);
    expect(canTransitionCall("missed", "active")).toBe(false);
    expect(canTransitionCall("failed", "completed")).toBe(false);
  });

  it("ignores a transcript that arrives after the call ended", async () => {
    const fixture = await voiceBusiness();
    const externalCallId = await placeCall(fixture.number);
    fakeVoiceProvider.simulateCallerHangup(externalCallId);
    await deliverVoiceEvents();

    const late = signVoiceEvent({
      id: `late-${Date.now()}`,
      type: "transcript.final",
      at: Date.now(),
      data: { externalCallId, transcript: "are you still there" }
    });
    const res = await request(app).post("/api/voice/webhooks/fake").set(late.headers).send(late.rawBody);
    expect(res.body.outcome).toBe("ignored");
  }, 60_000);
});

/* ------------------------------------------------------------------ */

describe("metering and limits", () => {
  it("counts completed call minutes into the plan's usage", async () => {
    const fixture = await voiceBusiness();
    const externalCallId = await placeCall(fixture.number);
    await callerSays(externalCallId, "how much is teeth whitening");
    fakeVoiceProvider.simulateCallerHangup(externalCallId);
    await deliverVoiceEvents();

    const { limitUsage } = await import("../src/services/access/accessService.js");
    const usage = await limitUsage(fixture.businessId);
    const minutes = usage.find((row) => row.key === "monthly_voice_minutes")!;
    expect(minutes.used).toBeGreaterThanOrEqual(1);
    expect(minutes.enforcement).toBe("enforced");
  }, 60_000);

  it("blocks a new call over the allowance, and never cuts off a live one", async () => {
    const fixture = await voiceBusiness();
    // A month of calls already used up Max's development allowance.
    await prisma.callSession.create({
      data: {
        businessId: fixture.businessId,
        provider: "fake",
        externalCallId: `historic-${Date.now()}`,
        direction: "inbound",
        status: "completed",
        durationSeconds: 1000 * 60,
        startedAt: new Date()
      }
    });

    const liveCallId = await placeCall(fixture.number);
    const session = await prisma.callSession.findFirstOrThrow({ where: { externalCallId: liveCallId } });
    expect(session.status).toBe("missed");
    expect(session.hangupReason).toBe("voice_unavailable:limit");

    // A call already in progress is untouched by the allowance.
    const other = await voiceBusiness();
    const ongoing = await placeCall(other.number);
    await prisma.callSession.create({
      data: {
        businessId: other.businessId,
        provider: "fake",
        externalCallId: `historic-2-${Date.now()}`,
        direction: "inbound",
        status: "completed",
        durationSeconds: 1000 * 60,
        startedAt: new Date()
      }
    });
    const spoken = await callerSays(ongoing, "how much is teeth whitening");
    expect(spoken.at(-1)).toMatch(/\$250/);
  }, 90_000);
});

/* ------------------------------------------------------------------ */

describe("console, privacy and tenancy", () => {
  it("shows calls with masked numbers and links to what they produced", async () => {
    const fixture = await voiceBusiness();
    const externalCallId = await placeCall(fixture.number, "+15557654321");
    await callerSays(externalCallId, "can I speak to a real person");
    fakeVoiceProvider.simulateCallerHangup(externalCallId);
    await deliverVoiceEvents();

    const list = await authed(request(app).get(`${base(fixture.businessId)}/calls`), fixture.owner);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].callerNumber).not.toBe("+15557654321");
    expect(list.body[0].callerNumber).toMatch(/…4321$/);
    expect(list.body[0].outcome).toBe("handoff");

    const detail = await authed(request(app).get(`${base(fixture.businessId)}/calls/${list.body[0].id}`), fixture.owner);
    expect(detail.status).toBe(200);
    expect(detail.body.escalationId).not.toBeNull();
    expect(detail.body.conversationId).not.toBeNull();
    expect(detail.body.recordingEnabled).toBe(false);
    // Operator-facing diagnostics only: no prompt, no reasoning, no provider payload.
    const serialised = JSON.stringify(detail.body);
    expect(serialised).not.toMatch(/systemPrompt|chain_of_thought|reasoning|authToken|accountSid/i);
    expect(detail.body.turns.some((turn: { latency: unknown }) => turn.latency !== null)).toBe(true);
  }, 60_000);

  it("keeps metadata only when the business asks for that", async () => {
    const fixture = await voiceBusiness();
    await prisma.voiceSettings.update({
      where: { businessId: fixture.businessId },
      data: { transcriptPolicy: "metadata_only" }
    });

    const externalCallId = await placeCall(fixture.number);
    await callerSays(externalCallId, "how much is teeth whitening");
    fakeVoiceProvider.simulateCallerHangup(externalCallId);
    await deliverVoiceEvents();

    const session = await prisma.callSession.findFirstOrThrow({ where: { externalCallId } });
    const messages = await prisma.message.findMany({ where: { conversationId: session.conversationId! } });
    expect(messages.every((message) => message.text.startsWith("[not stored"))).toBe(true);
    // The intents and actions survive, so measurement still works.
    expect(messages.some((message) => message.intent === "pricing")).toBe(true);

    const detail = await authed(request(app).get(`${base(fixture.businessId)}/calls/${session.id}`), fixture.owner);
    expect(detail.body.transcriptStored).toBe(false);
  }, 60_000);

  it("hides another business's calls", async () => {
    const mine = await voiceBusiness();
    const theirs = await voiceBusiness();
    const externalCallId = await placeCall(theirs.number);
    const session = await prisma.callSession.findFirstOrThrow({ where: { externalCallId } });

    expect((await authed(request(app).get(`${base(theirs.businessId)}/calls`), mine.owner)).status).toBe(404);
    expect((await authed(request(app).get(`${base(mine.businessId)}/calls/${session.id}`), mine.owner)).status).toBe(404);
  }, 90_000);

  it("refuses the fake provider and the simulator in production", async () => {
    const { voiceProviderByName, configuredVoiceProviderName } = await import("../src/services/voice/registry.js");
    expect(configuredVoiceProviderName({ VEYRA_VOICE_PROVIDER: "fake", NODE_ENV: "production" })).toBeNull();
    expect(voiceProviderByName("fake", { NODE_ENV: "production" })).toBeNull();

    const fixture = await voiceBusiness();
    process.env.NODE_ENV = "production";
    try {
      const simulate = await authed(
        request(app).post(`${base(fixture.businessId)}/voice/simulate/call`),
        fixture.owner
      ).send({});
      expect(simulate.status).toBe(404);
      expect((await request(app).post("/api/voice/webhooks/fake").send("{}")).status).toBe(404);
    } finally {
      process.env.NODE_ENV = "test";
    }
  }, 60_000);
});

/* ------------------------------------------------------------------ */

describe("pilot metrics", () => {
  it("counts calls, phone bookings and phone handoffs in the existing pilot metrics", async () => {
    const fixture = await voiceBusiness();
    const externalCallId = await placeCall(fixture.number);
    await callerSays(externalCallId, "can I speak to a real person");
    fakeVoiceProvider.simulateCallerHangup(externalCallId);
    await deliverVoiceEvents();

    const { pilotMetrics } = await import("../src/services/pilot/metrics.js");
    const { resolveRange } = await import("../src/services/pilot/range.js");
    const metrics = await pilotMetrics(fixture.businessId, resolveRange({ key: "last_7_days", timezone: "UTC" }));

    expect(metrics.raw.voiceCalls).toBe(1);
    expect(metrics.raw.voiceHandoffs).toBeGreaterThanOrEqual(1);
    const voiceCalls = metrics.activity.find((item) => item.key === "voice_calls");
    expect(voiceCalls?.value).toBe(1);
  }, 60_000);

  it("shows no voice metrics for a business that has never had a call", async () => {
    const fixture = await createCalendarBusiness({ plan: "PRO", namePrefix: "NoVoice" });
    const { pilotMetrics } = await import("../src/services/pilot/metrics.js");
    const { resolveRange } = await import("../src/services/pilot/range.js");
    const metrics = await pilotMetrics(fixture.businessId, resolveRange({ key: "last_7_days", timezone: "UTC" }));
    // Five permanent zeroes would be noise, not information.
    expect(metrics.activity.find((item) => item.key === "voice_calls")).toBeUndefined();
  }, 60_000);
});

/* ------------------------------------------------------------------ */

describe("outbound", () => {
  it("places a single operator-initiated call, and refuses without the plan", async () => {
    const fixture = await voiceBusiness();
    const placed = await authed(request(app).post(`${base(fixture.businessId)}/calls`), fixture.owner).send({
      to: "+15551234567"
    });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    expect(placed.body.direction).toBe("outbound");
    expect(placed.body.status).toBe("initiated");

    await changePlan({ businessId: fixture.businessId, plan: "PRO", actorType: "admin_script" });
    const refused = await authed(request(app).post(`${base(fixture.businessId)}/calls`), fixture.owner).send({
      to: "+15551234567"
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("ENTITLEMENT_REQUIRED");
  }, 60_000);

  it("rejects a malformed number before reaching the provider", async () => {
    const fixture = await voiceBusiness();
    const res = await authed(request(app).post(`${base(fixture.businessId)}/calls`), fixture.owner).send({ to: "not a number" });
    expect(res.status).toBe(400);
  }, 60_000);
});

/* ------------------------------------------------------------------ */

describe("failure handling", () => {
  it("returns 500 and releases the event claim so the provider's retry works", async () => {
    const fixture = await voiceBusiness();
    fakeVoiceProvider.simulateInboundCall({ from: "+15557654321", to: fixture.number });
    const [event] = fakeVoiceProvider.drainSignedEvents();

    // The original is restored by re-installing it rather than with
    // mockRestore(): Prisma's delegates are proxies, and restoring one removes
    // the method instead of putting it back.
    const { vi } = await import("vitest");
    const original = prisma.callSession.create.bind(prisma.callSession) as typeof prisma.callSession.create;
    const spy = vi.spyOn(prisma.callSession, "create");
    spy.mockImplementationOnce(
      () => Promise.reject(new Error("database unavailable")) as ReturnType<typeof prisma.callSession.create>
    );
    spy.mockImplementation(original);

    const failed = await request(app).post("/api/voice/webhooks/fake").set(event.headers).send(event.rawBody);
    expect(failed.status).toBe(500);
    // The claim is gone, so the retry is treated as a fresh delivery.
    expect(await prisma.voiceWebhookEvent.count({ where: { externalEventId: event.eventId } })).toBe(0);

    const retried = await request(app).post("/api/voice/webhooks/fake").set(event.headers).send(event.rawBody);
    expect(retried.status).toBe(200);
    expect(retried.body.outcome).toBe("processed");
  }, 60_000);

  it("reports the provider as unavailable without affecting other channels", async () => {
    const fixture = await voiceBusiness();
    fakeVoiceProvider.setHealthy(false);

    const overview = await authed(request(app).get(`${base(fixture.businessId)}/voice`), fixture.owner);
    expect(overview.body.live).toBe(false);
    expect(overview.body.blockedReason).toMatch(/not available/i);

    // The text channel is untouched.
    const conversation = await prisma.conversation.create({ data: { businessId: fixture.businessId } });
    const reply = await request(app)
      .post(`/api/conversations/${conversation.id}/messages`)
      .set("x-api-key", process.env.VEYRA_API_KEY as string)
      .send({ text: "how much is teeth whitening" });
    expect(reply.status).toBe(201);
    expect(reply.body.receptionistMessage.text).toMatch(/\$250/);
  }, 60_000);
});
