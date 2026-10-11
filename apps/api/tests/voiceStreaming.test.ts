import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client.js";
import { LiveCall } from "../src/services/voice/liveCall.js";
import { spokenForm, isLongForSpeech } from "../src/services/voice/speech.js";
import {
  FakeMediaTransport,
  FakeStreamingSpeechToTextProvider,
  FakeStreamingTextToSpeechProvider
} from "../src/services/voice/providers/fakeVoice.js";
import { TwilioVoiceProvider } from "../src/services/voice/providers/twilioVoice.js";
import { mediaStreamUrl, MEDIA_STREAM_PATH } from "../src/services/voice/media/bridge.js";
import { createCalendarBusiness, resetFakeCalendar } from "./helpers/calendarFixtures.js";

/**
 * The streaming voice path, exercised with in-memory transports.
 *
 * What this can honestly prove: the orchestration. Audio reaches recognition,
 * a finished utterance goes through the shared Reception pipeline, the reply
 * is streamed back, barge-in stops speech and drops buffered audio, latency is
 * recorded, and failures degrade instead of dropping the caller.
 *
 * What it cannot prove, and does not pretend to: that Twilio, Deepgram or
 * ElevenLabs behave as documented. No real call, no real audio, no vendor is
 * contacted anywhere in this file. That is Phase 14's real acceptance, and it
 * is BLOCKED on credentials.
 */

let transport: FakeMediaTransport;
let stt: FakeStreamingSpeechToTextProvider;
let tts: FakeStreamingTextToSpeechProvider;

/** A Max business with an open call, ready for audio. */
async function liveCallFixture(options: { greeting?: string; maxCallSeconds?: number } = {}) {
  const fixture = await createCalendarBusiness({ plan: "MAX", calendarBooking: false, namePrefix: "Stream" });
  await prisma.business.update({
    where: { id: fixture.businessId },
    data: { receptionStatus: "active", escalationPhone: "+15550001111" }
  });

  const externalCallId = `call_stream_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const session = await prisma.callSession.create({
    data: {
      businessId: fixture.businessId,
      conversationId: fixture.conversationId,
      provider: "fake",
      externalCallId,
      direction: "inbound",
      status: "active",
      callerNumber: "+15557654321",
      startedAt: new Date()
    }
  });

  transport = new FakeMediaTransport(externalCallId);
  const call = new LiveCall({
    transport,
    stt,
    tts,
    session,
    language: "en-US",
    voiceProfile: "neutral",
    greeting: options.greeting ?? "Thanks for calling. How can I help?",
    maxCallSeconds: options.maxCallSeconds ?? 600
  });

  return { fixture, session, call, externalCallId };
}

/** Lets queued promises settle — the orchestrator is event-driven. */
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(() => {
  stt = new FakeStreamingSpeechToTextProvider();
  tts = new FakeStreamingTextToSpeechProvider();
});

beforeEach(() => {
  stt.resetStreams();
  tts.resetStreams();
  resetFakeCalendar();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("a live streaming call", () => {
  it("speaks the greeting and sends it as audio", async () => {
    const { call } = await liveCallFixture({ greeting: "Thanks for calling Bright Smile." });
    await call.start();

    expect(tts.spoken[0]).toBe("Thanks for calling Bright Smile.");
    expect(transport.spokenText()).toContain("Thanks for calling Bright Smile.");
    await call.finish("test");
  }, 60_000);

  it("passes caller audio to recognition and answers from the shared pipeline", async () => {
    const { call, session } = await liveCallFixture();
    await call.start();

    transport.callerAudio(Buffer.from("audio-frame-1"));
    transport.callerAudio(Buffer.from("audio-frame-2"));
    expect(stt.liveStream!.received).toHaveLength(2);

    stt.liveStream!.speechStarted();
    stt.liveStream!.finalUtterance("how much is teeth whitening");
    await settle(120);

    // The same grounded answer the text channel gives: no voice pricing logic.
    expect(tts.spoken.at(-1)).toMatch(/\$250/);
    const messages = await prisma.message.findMany({
      where: { conversationId: session.conversationId! },
      orderBy: { createdAt: "asc" }
    });
    expect(messages.at(-1)!.intent).toBe("pricing");
    await call.finish("test");
  }, 60_000);

  it("records where a turn's time went", async () => {
    const { call, session } = await liveCallFixture();
    await call.start();

    stt.liveStream!.speechStarted();
    await settle(10);
    stt.liveStream!.finalUtterance("what are your opening hours");
    await settle(120);

    const turn = await prisma.callTurn.findFirstOrThrow({ where: { callSessionId: session.id } });
    expect(turn.responderMs).not.toBeNull();
    expect(turn.ttsMs).not.toBeNull();
    expect(turn.totalMs).not.toBeNull();
    await call.finish("test");
  }, 60_000);
});

describe("barge-in", () => {
  it("stops speaking and drops buffered audio the moment the caller talks", async () => {
    // Many chunks with a gap between them, so the caller can interrupt
    // part-way through — as they would over a real stream.
    tts.chunkCount = 40;
    tts.chunkDelayMs = 4;
    const { call, session } = await liveCallFixture({
      greeting: "This is a deliberately long greeting that the caller is going to talk straight over before it finishes."
    });
    // Deliberately not awaited: the caller interrupts while Veyra is speaking.
    const speaking = call.start();
    await settle(30);
    const spokenBefore = transport.spokenText().length;
    expect(spokenBefore).toBeGreaterThan(0);

    stt.liveStream!.speechStarted();
    await settle(30);
    await speaking;

    // Both halves of a real barge-in: the carrier is told to drop what it has
    // buffered, and the rest of the sentence is never sent.
    expect(transport.clearCount).toBeGreaterThanOrEqual(1);
    expect(transport.spokenText().length).toBeLessThan(spokenBefore);

    // The slow stream has done its job; let the reply come back promptly.
    tts.chunkDelayMs = 0;
    stt.liveStream!.finalUtterance("actually I just want to book");
    await settle(250);

    // Scoped to this call: other tests in this file create turns too.
    const turn = await prisma.callTurn.findFirstOrThrow({ where: { callSessionId: session.id } });
    expect(turn.interrupted).toBe(true);
    await call.finish("test");
  }, 60_000);

  it("does not process two utterances at once", async () => {
    const { call, session } = await liveCallFixture();
    await call.start();

    stt.liveStream!.finalUtterance("how much is teeth whitening");
    // A second utterance arriving while the first turn is still running must
    // not start a parallel turn — that is how a caller gets double-booked.
    stt.liveStream!.finalUtterance("how much is teeth whitening");
    await settle(200);

    const turns = await prisma.callTurn.count({ where: { callSessionId: session.id } });
    expect(turns).toBe(1);
    await call.finish("test");
  }, 60_000);
});

describe("degrading instead of dropping the caller", () => {
  it("asks the caller to repeat when recognition fails mid-call", async () => {
    const { call } = await liveCallFixture();
    await call.start();

    stt.liveStream!.failWith("deepgram socket closed");
    await settle(80);

    expect(tts.spoken.at(-1)).toMatch(/trouble hearing you/i);
    await call.finish("test");
  }, 60_000);

  it("keeps the call alive when synthesis fails", async () => {
    const { call, session } = await liveCallFixture();
    await call.start();

    tts.streamShouldFail = new Error("elevenlabs unavailable");
    stt.liveStream!.finalUtterance("how much is teeth whitening");
    await settle(150);

    // The turn still happened and is recorded; only the audio is missing.
    const turn = await prisma.callTurn.findFirstOrThrow({ where: { callSessionId: session.id } });
    expect(turn.ttsMs).toBeNull();
    const messages = await prisma.message.findMany({ where: { conversationId: session.conversationId! } });
    expect(messages.some((message) => /\$250/.test(message.text))).toBe(true);
    await call.finish("test");
  }, 60_000);

  it("survives a provider that accepts the request and then refuses mid-stream", async () => {
    // The shape a real ElevenLabs account produced: the socket opens, some or
    // no audio arrives, and then the provider says no. Before this was fixed
    // that looked like a clean end — Veyra went silent with nothing in the log
    // to explain it — so the call must now carry on and the turn be recorded.
    const { call, session } = await liveCallFixture();
    await call.start();

    tts.failAfterChunks = 1;
    stt.liveStream!.finalUtterance("how much is teeth whitening");
    await settle(200);

    const turn = await prisma.callTurn.findFirstOrThrow({ where: { callSessionId: session.id } });
    expect(turn.responderMs).not.toBeNull();
    // The answer still exists in the conversation; only the audio was lost.
    const messages = await prisma.message.findMany({ where: { conversationId: session.conversationId! } });
    expect(messages.some((message) => /\$250/.test(message.text))).toBe(true);

    // And the call is still up: the next utterance is still answered.
    tts.failAfterChunks = null;
    stt.liveStream!.finalUtterance("what are your opening hours");
    await settle(200);
    expect(tts.spoken.at(-1)).toBeTruthy();
    await call.finish("test");
  }, 60_000);

  it("closes recognition when the carrier drops the line", async () => {
    const { call } = await liveCallFixture();
    await call.start();
    const stream = stt.liveStream!;

    transport.close("caller_hangup");
    await settle(60);

    expect(stream.closed).toBe(true);
  }, 60_000);
});

describe("Twilio media stream wiring", () => {
  const provider = new TwilioVoiceProvider({ accountSid: "AC_unit_test", authToken: "unit-test-token" });

  it("treats the first inbound webhook as a new call, not a status update", () => {
    // The Phase 13 defect: nothing ever produced call.incoming, so no real
    // call would have been answered at all.
    const form = new URLSearchParams({
      CallSid: "CA123",
      CallStatus: "ringing",
      Direction: "inbound",
      From: "+15557654321",
      To: "+15551230000"
    });
    const event = verify(provider, form);
    expect(event.type).toBe("call.incoming");
    expect(event.externalCallId).toBe("CA123");
    expect(event.to).toBe("+15551230000");
  });

  it("still treats later status callbacks as status", () => {
    const completed = verify(
      provider,
      new URLSearchParams({ CallSid: "CA123", CallStatus: "completed", Direction: "inbound", CallDuration: "42" })
    );
    expect(completed.type).toBe("call.completed");
    expect(completed.durationSeconds).toBe(42);

    const answered = verify(
      provider,
      new URLSearchParams({ CallSid: "CA123", CallStatus: "in-progress", Direction: "inbound", StreamSid: "MZ1" })
    );
    expect(answered.type).toBe("call.answered");
  });

  it("builds media-stream TwiML that points at the one accepted path", () => {
    const markup = provider.mediaStreamMarkup({
      websocketUrl: mediaStreamUrl("https://veyra.example"),
      callSid: "CA123"
    });
    expect(markup).toContain(`wss://veyra.example${MEDIA_STREAM_PATH}`);
    expect(markup).toContain("<Connect><Stream");
    expect(markup).toContain('value="CA123"');
  });

  it("escapes anything a business typed into TwiML", () => {
    const markup = provider.instructionMarkup({
      kind: "say",
      text: `Bright & Smile <script>alert("x")</script>`,
      then: "listen"
    });
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&amp;");
    expect(markup).toContain("&lt;script&gt;");
  });

  it("answers a status callback with empty TwiML rather than JSON", () => {
    // Answering Twilio with JSON makes the caller hear an error message.
    expect(provider.noopMarkup()).toMatch(/^<\?xml/);
    expect(provider.noopMarkup()).toContain("<Response/>");
  });
});

/** Signs a form the way Twilio does, then runs it through verification. */
function verify(provider: TwilioVoiceProvider, form: URLSearchParams) {
  const url = "https://veyra.example/api/voice/webhooks/twilio";
  const entries: Record<string, string> = {};
  for (const [key, value] of form.entries()) entries[key] = value;
  const { createHmac } = require("node:crypto") as typeof import("node:crypto");
  const payload = url + Object.keys(entries).sort().map((key) => `${key}${entries[key]}`).join("");
  const signature = createHmac("sha1", "unit-test-token").update(payload, "utf8").digest("base64");

  return provider.verifyWebhook({
    rawBody: Buffer.from(form.toString()),
    headers: { "x-twilio-signature": signature },
    url
  });
}

describe("speakable text", () => {
  it("turns layout into sentences without changing a single fact", () => {
    const written = "We offer:\n- Teeth whitening — $250\n- Routine cleaning — $120";
    const spoken = spokenForm(written);

    expect(spoken).not.toContain("\n");
    expect(spoken).not.toMatch(/^\s*-/m);
    // Every price and service name survives exactly.
    expect(spoken).toContain("$250");
    expect(spoken).toContain("$120");
    expect(spoken).toContain("Teeth whitening");
  });

  it("leaves an ordinary sentence alone", () => {
    expect(spokenForm("Teeth whitening is $250.")).toBe("Teeth whitening is $250.");
  });

  it("flags a reply that is long for speech without truncating it", () => {
    const long = "word ".repeat(100);
    expect(isLongForSpeech(long)).toBe(true);
    expect(spokenForm(long)).toContain("word");
  });
});
