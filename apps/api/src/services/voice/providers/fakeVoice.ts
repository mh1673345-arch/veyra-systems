import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  TELEPHONY_AUDIO,
  type AudioFormat,
  type CallInstruction,
  type MediaTransport,
  type StreamingSpeechToTextProvider,
  type StreamingTextToSpeechProvider,
  type SttStream,
  type TtsStream,
  type SpeechToTextProvider,
  type SynthesizedSpeech,
  type TextToSpeechProvider,
  type Transcript,
  type VoiceEvent,
  type VoiceProvider,
  VoiceProviderError,
  VoiceWebhookVerificationError
} from "../types.js";

/**
 * DEVELOPMENT VOICE PROVIDER — NOT A REAL PHONE LINE.
 *
 * A deterministic, in-memory stand-in for telephony, speech recognition and
 * speech synthesis, so the whole voice path — inbound call, transcript,
 * Reception turn, spoken reply, booking, handoff, hangup — can be exercised
 * without a carrier account. No call is placed and no audio exists.
 *
 * It behaves like a real provider in the ways that matter for correctness:
 *   - every webhook is signed and must pass verification
 *   - events carry ids, so retries and duplicates can be tested
 *   - calls can fail, lag, and be interrupted mid-sentence
 *
 * The registry refuses it in production.
 */

export const FAKE_VOICE_SIGNATURE_HEADER = "veyra-fake-voice-signature";
const SIGNATURE_TOLERANCE_SECONDS = 300;

export function fakeVoiceWebhookSecret(env: NodeJS.ProcessEnv = process.env): string {
  return env.VEYRA_FAKE_VOICE_WEBHOOK_SECRET ?? "whsec_veyra_fake_voice_dev_only";
}

export interface SpokenLine {
  externalCallId: string;
  text: string;
  then: "listen" | "hangup";
  /** Set when the caller talked over this line and it was cut short. */
  cancelled?: boolean;
}

interface FakeCall {
  externalCallId: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  status: "ringing" | "active" | "transferring" | "completed" | "failed";
  startedAt: number;
  transferredTo?: string;
}

export interface SignedVoiceWebhook {
  eventId: string;
  rawBody: string;
  headers: Record<string, string>;
}

export class FakeVoiceProvider implements VoiceProvider {
  readonly name = "fake" as const;
  /** The fake line can transfer, so the happy path is testable end to end. */
  supportsTransfer = true;

  private counter = 0;
  private readonly run = randomBytes(3).toString("hex");
  private clock = 0;
  private readonly calls = new Map<string, FakeCall>();
  private spoken: SpokenLine[] = [];
  private queue: { id: string; type: string; at: number; data: Record<string, unknown> }[] = [];
  private failNext: VoiceProviderError | null = null;
  private healthy = true;
  /** Simulated provider latency, so latency plumbing can be tested deterministically. */
  latencyMs = { stt: 0, tts: 0 };

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_fake_${this.run}_${this.counter}`;
  }

  private tick(): number {
    this.clock = Math.max(Date.now(), this.clock + 1);
    return this.clock;
  }

  private emit(type: string, data: Record<string, unknown>): string {
    const id = this.nextId("vevt");
    this.queue.push({ id, type, at: this.tick(), data });
    return id;
  }

  private guard(): void {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
  }

  private call(externalCallId: string): FakeCall {
    const call = this.calls.get(externalCallId);
    if (!call) throw new VoiceProviderError("not_found", "No such call.");
    return call;
  }

  /* ----------------------------- the contract ----------------------------- */

  async health(): Promise<{ ok: boolean; detail: string }> {
    return this.healthy
      ? { ok: true, detail: "Development voice provider — no real calls are placed." }
      : { ok: false, detail: "Development voice provider is simulating an outage." };
  }

  async perform(params: { externalCallId: string; instruction: CallInstruction }): Promise<void> {
    this.guard();
    const call = this.call(params.externalCallId);
    const instruction = params.instruction;

    if (instruction.kind === "say") {
      this.spoken.push({ externalCallId: call.externalCallId, text: instruction.text, then: instruction.then });
      if (instruction.then === "hangup") await this.hangup({ externalCallId: call.externalCallId, reason: "veyra_hangup" });
      return;
    }
    if (instruction.kind === "transfer") {
      if (instruction.sayFirst) {
        this.spoken.push({ externalCallId: call.externalCallId, text: instruction.sayFirst, then: "listen" });
      }
      await this.transfer({ externalCallId: call.externalCallId, to: instruction.to });
      return;
    }
    if (instruction.sayFirst) {
      this.spoken.push({ externalCallId: call.externalCallId, text: instruction.sayFirst, then: "hangup" });
    }
    await this.hangup({ externalCallId: call.externalCallId, reason: "veyra_hangup" });
  }

  async cancelSpeech(externalCallId: string): Promise<void> {
    const last = [...this.spoken].reverse().find((line) => line.externalCallId === externalCallId && !line.cancelled);
    if (last) last.cancelled = true;
  }

  async transfer(params: { externalCallId: string; to: string }): Promise<void> {
    this.guard();
    const call = this.call(params.externalCallId);
    call.status = "transferring";
    call.transferredTo = params.to;
    this.emit("call.transferred", { externalCallId: call.externalCallId, to: params.to });
  }

  async hangup(params: { externalCallId: string; reason?: string }): Promise<void> {
    const call = this.call(params.externalCallId);
    if (call.status === "completed") return;
    call.status = "completed";
    this.emit("call.completed", {
      externalCallId: call.externalCallId,
      durationSeconds: Math.max(1, Math.round((Date.now() - call.startedAt) / 1000)),
      hangupCause: params.reason ?? "veyra_hangup"
    });
  }

  async startOutboundCall(params: { to: string; from: string }): Promise<{ externalCallId: string }> {
    this.guard();
    const externalCallId = this.nextId("call");
    this.calls.set(externalCallId, {
      externalCallId,
      direction: "outbound",
      from: params.from,
      to: params.to,
      status: "ringing",
      startedAt: Date.now()
    });
    this.emit("call.ringing", { externalCallId, direction: "outbound", from: params.from, to: params.to });
    return { externalCallId };
  }

  verifyWebhook(params: { rawBody: Buffer; headers: Record<string, string | string[] | undefined> }): VoiceEvent {
    const header = params.headers[FAKE_VOICE_SIGNATURE_HEADER];
    const value = Array.isArray(header) ? header[0] : header;
    if (!value) throw new VoiceWebhookVerificationError("Missing signature.");

    const parts = Object.fromEntries(value.split(",").map((part) => part.split("=") as [string, string]));
    const timestamp = Number(parts.t);
    const signature = parts.v1;
    if (!Number.isFinite(timestamp) || !signature) throw new VoiceWebhookVerificationError("Malformed signature.");
    if (Math.abs(Date.now() / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
      throw new VoiceWebhookVerificationError("Signature timestamp outside the tolerance window.");
    }

    const expected = Buffer.from(signVoice(`${timestamp}.${params.rawBody.toString("utf8")}`), "hex");
    const provided = Buffer.from(signature, "hex");
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      throw new VoiceWebhookVerificationError("Signature mismatch.");
    }

    const payload = JSON.parse(params.rawBody.toString("utf8")) as {
      id: string;
      type: string;
      at: number;
      data: Record<string, unknown>;
    };
    const data = payload.data;

    const known: Record<string, VoiceEvent["type"]> = {
      "call.incoming": "call.incoming",
      "call.ringing": "call.ringing",
      "call.answered": "call.answered",
      "transcript.final": "transcript.final",
      "speech.interrupted": "speech.interrupted",
      "call.transferred": "call.transferred",
      "call.completed": "call.completed",
      "call.failed": "call.failed"
    };

    return {
      id: payload.id,
      type: known[payload.type] ?? "other",
      providerType: payload.type,
      externalCallId: String(data.externalCallId ?? ""),
      occurredAt: new Date(payload.at),
      direction: (data.direction as "inbound" | "outbound" | undefined) ?? undefined,
      from: (data.from as string | undefined) ?? null,
      to: (data.to as string | undefined) ?? null,
      transcript: data.transcript as string | undefined,
      transcriptConfidence: (data.confidence as number | undefined) ?? null,
      durationSeconds: (data.durationSeconds as number | undefined) ?? null,
      hangupCause: (data.hangupCause as string | undefined) ?? null
    };
  }

  /* ----------------------- simulation controls (dev/test) ----------------------- */

  /** A caller dials the business. Queues the event a real carrier would send. */
  simulateInboundCall(params: { from: string; to: string }): { externalCallId: string; eventId: string } {
    const externalCallId = this.nextId("call");
    this.calls.set(externalCallId, {
      externalCallId,
      direction: "inbound",
      from: params.from,
      to: params.to,
      status: "ringing",
      startedAt: Date.now()
    });
    const eventId = this.emit("call.incoming", {
      externalCallId,
      direction: "inbound",
      from: params.from,
      to: params.to
    });
    return { externalCallId, eventId };
  }

  /** The line comes up. */
  simulateAnswered(externalCallId: string): string {
    const call = this.call(externalCallId);
    call.status = "active";
    return this.emit("call.answered", { externalCallId });
  }

  /** The caller finishes saying something. */
  simulateCallerSpeech(externalCallId: string, transcript: string, confidence = 0.92): string {
    this.call(externalCallId);
    return this.emit("transcript.final", { externalCallId, transcript, confidence });
  }

  /** The caller talks over Veyra. */
  simulateInterruption(externalCallId: string): string {
    this.call(externalCallId);
    return this.emit("speech.interrupted", { externalCallId });
  }

  simulateCallerHangup(externalCallId: string): string {
    const call = this.call(externalCallId);
    call.status = "completed";
    return this.emit("call.completed", {
      externalCallId,
      durationSeconds: Math.max(1, Math.round((Date.now() - call.startedAt) / 1000)),
      hangupCause: "caller_hangup"
    });
  }

  simulateFailure(externalCallId: string, cause = "carrier_error"): string {
    const call = this.call(externalCallId);
    call.status = "failed";
    return this.emit("call.failed", { externalCallId, hangupCause: cause });
  }

  /** Makes the next provider call throw, to test error handling. */
  failNextCall(error: VoiceProviderError): void {
    this.failNext = error;
  }

  setHealthy(healthy: boolean): void {
    this.healthy = healthy;
  }

  callInfo(externalCallId: string): FakeCall | null {
    return this.calls.get(externalCallId) ?? null;
  }

  /** Everything Veyra has said on a call, in order. */
  spokenOn(externalCallId: string): SpokenLine[] {
    return this.spoken.filter((line) => line.externalCallId === externalCallId);
  }

  pendingEventCount(): number {
    return this.queue.length;
  }

  /** Signs and removes every queued event, oldest first — ready to POST at the webhook. */
  drainSignedEvents(secret = fakeVoiceWebhookSecret()): SignedVoiceWebhook[] {
    const events = this.queue;
    this.queue = [];
    return events.map((event) => signVoiceEvent(event, secret));
  }

  reset(): void {
    this.calls.clear();
    this.spoken = [];
    this.queue = [];
    this.failNext = null;
    this.healthy = true;
    this.latencyMs = { stt: 0, tts: 0 };
  }
}

function signVoice(payload: string, secret = fakeVoiceWebhookSecret()): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function signVoiceEvent(
  event: { id: string; type: string; at: number; data: Record<string, unknown> },
  secret = fakeVoiceWebhookSecret(),
  timestamp = Math.floor(Date.now() / 1000)
): SignedVoiceWebhook {
  const rawBody = JSON.stringify(event);
  return {
    eventId: event.id,
    rawBody,
    headers: {
      "content-type": "application/json",
      [FAKE_VOICE_SIGNATURE_HEADER]: `t=${timestamp},v1=${signVoice(`${timestamp}.${rawBody}`, secret)}`
    }
  };
}

/* ------------------------------------------------------------------ *
 * Speech, faked
 * ------------------------------------------------------------------ */

/**
 * "Recognition" that simply returns the words the simulation supplied. Real
 * audio never exists in development, so the transcript arrives as text on the
 * event and this exists to keep the seam honest: the session service always
 * goes through a SpeechToTextProvider.
 */
export class FakeSpeechToTextProvider implements SpeechToTextProvider {
  readonly name = "fake" as const;
  failNext: Error | null = null;
  latencyMs = 0;

  async transcribe(params: { audio: Buffer; language: string }): Promise<Transcript> {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    return { text: params.audio.toString("utf8"), confidence: 0.92, language: params.language, isFinal: true };
  }
}

export class FakeTextToSpeechProvider implements TextToSpeechProvider {
  readonly name = "fake" as const;
  readonly voices = ["neutral", "warm", "bright"] as const;
  failNext: Error | null = null;
  latencyMs = 0;
  synthesized: { text: string; voiceProfile: string }[] = [];

  async synthesize(params: { text: string; voiceProfile: string; language: string }): Promise<SynthesizedSpeech> {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    this.synthesized.push({ text: params.text, voiceProfile: params.voiceProfile });
    return {
      // A reference, never audio: nothing here is playable and nothing is stored.
      reference: `fake-audio:${Buffer.from(params.text).toString("base64").slice(0, 24)}`,
      // Roughly 14 characters a second, so duration assertions are stable.
      durationMs: Math.max(400, Math.round((params.text.length / 14) * 1000)),
      voiceProfile: params.voiceProfile
    };
  }

  reset(): void {
    this.synthesized = [];
    this.failNext = null;
    this.latencyMs = 0;
  }
}

/* ------------------------------------------------------------------ *
 * Streaming, faked
 * ------------------------------------------------------------------ */

/**
 * A deterministic streaming recognition session.
 *
 * Tests drive it directly — `speechStarted()` and `finalUtterance()` stand in
 * for a caller opening their mouth and finishing a sentence — so the live-call
 * orchestration, including barge-in, can be exercised with no audio, no
 * network and no timing luck.
 */
export class FakeSttStream implements SttStream {
  private speechStartedHandler: (() => void) | null = null;
  private finalHandler: ((transcript: Transcript) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  /** Everything the "caller" sent, so a test can assert audio really flowed. */
  readonly received: Buffer[] = [];
  closed = false;

  constructor(private readonly language: string) {}

  write(chunk: Buffer): void {
    if (!this.closed) this.received.push(chunk);
  }

  onSpeechStarted(handler: () => void): void {
    this.speechStartedHandler = handler;
  }

  onFinal(handler: (transcript: Transcript) => void): void {
    this.finalHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /* --- test controls --- */

  speechStarted(): void {
    this.speechStartedHandler?.();
  }

  finalUtterance(text: string, confidence = 0.93): void {
    this.finalHandler?.({ text, confidence, language: this.language, isFinal: true });
  }

  failWith(message: string): void {
    this.errorHandler?.(new Error(message));
  }
}

export class FakeStreamingSpeechToTextProvider extends FakeSpeechToTextProvider implements StreamingSpeechToTextProvider {
  /** The streams handed out, newest last, so a test can drive the live one. */
  readonly streams: FakeSttStream[] = [];
  openShouldFail: Error | null = null;

  async openStream(params: { format: AudioFormat; language: string; externalCallId: string }): Promise<SttStream> {
    if (this.openShouldFail) {
      const error = this.openShouldFail;
      this.openShouldFail = null;
      throw error;
    }
    const stream = new FakeSttStream(params.language);
    this.streams.push(stream);
    return stream;
  }

  get liveStream(): FakeSttStream | null {
    return this.streams.at(-1) ?? null;
  }

  resetStreams(): void {
    this.streams.length = 0;
    this.openShouldFail = null;
  }
}

class FakeTtsStream implements TtsStream {
  private cancelled = false;
  private readonly startedAt = Date.now();
  private firstChunkAt: number | null = null;

  constructor(
    private readonly text: string,
    private readonly chunkCount: number,
    /** A real stream yields between chunks; without a gap nothing could interrupt it. */
    private readonly chunkDelayMs: number,
    /**
     * Throws after this many chunks. Real providers refuse mid-stream — an
     * ElevenLabs account without the right plan opens the socket happily and
     * only then says no — so that shape has to be testable.
     */
    private readonly failAfterChunks: number | null
  ) {}

  get chunks(): AsyncIterable<Buffer> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        // Split into several chunks so a test can interrupt mid-sentence.
        const size = Math.max(1, Math.ceil(self.text.length / self.chunkCount));
        let emitted = 0;
        for (let index = 0; index < self.text.length; index += size) {
          if (self.chunkDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, self.chunkDelayMs));
          if (self.cancelled) return;
          if (self.failAfterChunks !== null && emitted >= self.failAfterChunks) {
            throw new Error("synthesis refused mid-stream");
          }
          emitted += 1;
          if (self.firstChunkAt === null) self.firstChunkAt = Date.now();
          // Stand-in audio: the bytes are the text itself, which makes
          // assertions readable and keeps anything resembling audio out of it.
          yield Buffer.from(self.text.slice(index, index + size), "utf8");
        }
      }
    };
  }

  firstChunkMs(): number | null {
    return this.firstChunkAt === null ? null : Math.max(0, this.firstChunkAt - this.startedAt);
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }
}

export class FakeStreamingTextToSpeechProvider
  extends FakeTextToSpeechProvider
  implements StreamingTextToSpeechProvider
{
  /** Every line spoken through the streaming path, in order. */
  readonly spoken: string[] = [];
  streamShouldFail: Error | null = null;
  chunkCount = 4;
  /** Milliseconds between chunks, so barge-in has a window to land in. */
  chunkDelayMs = 0;
  /** Refuse after this many chunks, the way a real provider can. */
  failAfterChunks: number | null = null;

  async stream(params: { text: string; voiceProfile: string; language: string; format: AudioFormat }): Promise<TtsStream> {
    if (this.streamShouldFail) {
      const error = this.streamShouldFail;
      this.streamShouldFail = null;
      throw error;
    }
    this.spoken.push(params.text);
    return new FakeTtsStream(params.text, this.chunkCount, this.chunkDelayMs, this.failAfterChunks);
  }

  resetStreams(): void {
    this.spoken.length = 0;
    this.streamShouldFail = null;
    this.chunkCount = 4;
    this.chunkDelayMs = 0;
    this.failAfterChunks = null;
  }
}

/** An in-memory MediaTransport, so a live call can be tested without a carrier. */
export class FakeMediaTransport implements MediaTransport {
  readonly format: AudioFormat = TELEPHONY_AUDIO;
  readonly sent: Buffer[] = [];
  /** How many times Veyra told the carrier to drop buffered audio (barge-in). */
  clearCount = 0;
  closedReason: string | null = null;
  private audioHandler: ((chunk: Buffer) => void) | null = null;
  private closedHandler: ((reason: string) => void) | null = null;

  constructor(readonly externalCallId: string) {}

  onAudio(handler: (chunk: Buffer) => void): void {
    this.audioHandler = handler;
  }

  onClosed(handler: (reason: string) => void): void {
    this.closedHandler = handler;
  }

  send(chunk: Buffer): void {
    this.sent.push(chunk);
  }

  clearQueuedAudio(): void {
    this.clearCount += 1;
    // What the carrier would drop: anything not yet played.
    this.sent.length = 0;
  }

  close(reason: string): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    this.closedHandler?.(reason);
  }

  /* --- test controls --- */

  /** Caller audio arriving from the carrier. */
  callerAudio(chunk: Buffer): void {
    this.audioHandler?.(chunk);
  }

  /** What Veyra has said since the last barge-in, as text. */
  spokenText(): string {
    return Buffer.concat(this.sent).toString("utf8");
  }
}
