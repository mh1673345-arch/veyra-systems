/**
 * The voice boundary.
 *
 * Three narrow interfaces — telephony, speech-to-text, text-to-speech — and a
 * set of provider-neutral shapes. No vendor SDK object, status string or
 * payload crosses into Veyra: a call is a sequence of `VoiceEvent`s and a
 * response is text plus an instruction about what the line should do next.
 *
 * Voice is a channel. Nothing in this file knows about services, prices,
 * calendars or plans; those decisions belong to the Reception pipeline the
 * voice session drives.
 */

export type VoiceProviderName = "fake" | "twilio";
export type SttProviderName = "fake" | "deepgram";
export type TtsProviderName = "fake" | "elevenlabs";

/* ------------------------------------------------------------------ *
 * Telephony
 * ------------------------------------------------------------------ */

export type VoiceEventType =
  /** A caller dialled the business's number. */
  | "call.incoming"
  | "call.ringing"
  /** The line is up and audio can flow. */
  | "call.answered"
  /** A finished utterance from the caller. */
  | "transcript.final"
  /** The caller started speaking while Veyra was talking. */
  | "speech.interrupted"
  | "call.transferred"
  | "call.completed"
  | "call.failed"
  | "other";

/** A verified provider event, normalised. Never carries the raw payload. */
export interface VoiceEvent {
  /** The provider's event id: the deduplication key. Providers that don't send one get a derived, stable id. */
  id: string;
  type: VoiceEventType;
  /** The provider's call id: how Veyra finds the CallSession. */
  externalCallId: string;
  occurredAt: Date;
  direction?: "inbound" | "outbound";
  /** E.164 where the provider gives it. Personal data — never logged. */
  from?: string | null;
  to?: string | null;
  /** For transcript events. */
  transcript?: string;
  transcriptConfidence?: number | null;
  /** Seconds, on completion events. */
  durationSeconds?: number | null;
  hangupCause?: string | null;
  /** The provider's own type string, kept only for operator-facing logs. */
  providerType: string;
}

/** What Veyra wants the line to do after a turn. */
export type CallInstruction =
  | { kind: "say"; text: string; then: "listen" | "hangup" }
  | { kind: "transfer"; to: string; sayFirst?: string }
  | { kind: "hangup"; sayFirst?: string };

export class VoiceProviderError extends Error {
  constructor(
    readonly kind: "unavailable" | "rejected" | "unsupported" | "not_found",
    message: string
  ) {
    super(message);
    this.name = "VoiceProviderError";
  }
}

export class VoiceWebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceWebhookVerificationError";
  }
}

export interface VoiceProvider {
  readonly name: VoiceProviderName;
  /** Whether the provider can currently carry calls. Reported, never used to gate other channels. */
  health(): Promise<{ ok: boolean; detail: string }>;
  /** Speaks a response on a live call, and says what to do next. */
  perform(params: { externalCallId: string; instruction: CallInstruction }): Promise<void>;
  /** Stops whatever is currently being spoken, for barge-in. */
  cancelSpeech(externalCallId: string): Promise<void>;
  /** True when this provider can transfer a live call to a human. */
  readonly supportsTransfer: boolean;
  transfer(params: { externalCallId: string; to: string }): Promise<void>;
  hangup(params: { externalCallId: string; reason?: string }): Promise<void>;
  /** Places a call. Operator-initiated only; there is no campaign runner. */
  startOutboundCall(params: { to: string; from: string; businessId: string }): Promise<{ externalCallId: string }>;
  /** Verifies the signature over the raw body and returns the normalised event, or throws. */
  verifyWebhook(params: {
    rawBody: Buffer;
    headers: Record<string, string | string[] | undefined>;
    url: string;
  }): VoiceEvent;
}

/* ------------------------------------------------------------------ *
 * Speech
 * ------------------------------------------------------------------ */

export interface Transcript {
  text: string;
  /**
   * The provider's own score, passed through untouched. Providers do not agree
   * on what it means, so Veyra never compares it across providers or treats it
   * as a probability — it is shown to operators and nothing more.
   */
  confidence: number | null;
  language: string;
  /** False for interim results a provider may emit while the caller is still talking. */
  isFinal: boolean;
}

export interface SpeechToTextProvider {
  readonly name: SttProviderName;
  /** Turns a chunk of caller audio into text. */
  transcribe(params: { audio: Buffer; language: string; externalCallId: string }): Promise<Transcript>;
}

/* ------------------------------------------------------------------ *
 * Live audio
 * ------------------------------------------------------------------ */

/**
 * How audio is encoded on the wire. Telephony is 8kHz μ-law; everything here
 * is passed through to the providers rather than resampled by Veyra, because
 * a carrier and a speech vendor that agree on the format sound better than
 * anything a conversion in the middle would produce.
 */
export interface AudioFormat {
  encoding: "mulaw" | "linear16";
  sampleRate: number;
}

export const TELEPHONY_AUDIO: AudioFormat = { encoding: "mulaw", sampleRate: 8000 };

/**
 * A live recognition session for one call.
 *
 * `speechStarted` is what makes barge-in possible: it fires as soon as the
 * caller opens their mouth, before any transcript exists, so Veyra can stop
 * talking immediately rather than after the sentence is understood.
 */
export interface SttStream {
  /** Caller audio, in the format the stream was opened with. */
  write(chunk: Buffer): void;
  onSpeechStarted(handler: () => void): void;
  /** A finished utterance, ready for the Reception pipeline. */
  onFinal(handler: (transcript: Transcript) => void): void;
  onError(handler: (error: Error) => void): void;
  /** Resolves once the provider has flushed anything outstanding. */
  close(): Promise<void>;
}

export interface StreamingSpeechToTextProvider extends SpeechToTextProvider {
  openStream(params: {
    format: AudioFormat;
    language: string;
    externalCallId: string;
  }): Promise<SttStream>;
}

/** Synthesis that arrives in pieces, so the caller hears the first words sooner. */
export interface TtsStream {
  /** Audio chunks in the requested format, first chunk as early as the provider allows. */
  chunks: AsyncIterable<Buffer>;
  /** Milliseconds from request to the first audio chunk — the number that decides how responsive Veyra feels. */
  firstChunkMs(): number | null;
  /** Stops synthesis mid-sentence, for barge-in. */
  cancel(): Promise<void>;
}

export interface StreamingTextToSpeechProvider extends TextToSpeechProvider {
  stream(params: { text: string; voiceProfile: string; language: string; format: AudioFormat }): Promise<TtsStream>;
}

export function isStreamingStt(provider: SpeechToTextProvider | null): provider is StreamingSpeechToTextProvider {
  return typeof (provider as StreamingSpeechToTextProvider | null)?.openStream === "function";
}

export function isStreamingTts(provider: TextToSpeechProvider | null): provider is StreamingTextToSpeechProvider {
  return typeof (provider as StreamingTextToSpeechProvider | null)?.stream === "function";
}

/* ------------------------------------------------------------------ *
 * Media transport
 * ------------------------------------------------------------------ */

/**
 * The carrier's audio connection for one call, as the domain sees it.
 *
 * Twilio's Media Streams framing, its base64 payloads and its stream ids stay
 * behind this: a live call session only knows that audio arrives, audio can be
 * sent, queued audio can be dropped, and the line can be hung up.
 */
export interface MediaTransport {
  readonly externalCallId: string;
  readonly format: AudioFormat;
  onAudio(handler: (chunk: Buffer) => void): void;
  onClosed(handler: (reason: string) => void): void;
  send(chunk: Buffer): void;
  /**
   * Drops audio already handed to the carrier but not yet heard. Without this,
   * "stop talking" would only take effect after everything buffered had played.
   */
  clearQueuedAudio(): void;
  close(reason: string): void;
}

export interface SynthesizedSpeech {
  /** Where the audio is, or the audio itself for providers that return it inline. */
  reference: string;
  durationMs: number | null;
  voiceProfile: string;
}

export interface TextToSpeechProvider {
  readonly name: TtsProviderName;
  /** The voices a business may choose. A business can never supply free-form voice instructions. */
  readonly voices: readonly string[];
  synthesize(params: { text: string; voiceProfile: string; language: string }): Promise<SynthesizedSpeech>;
}

/** The voices any provider must accept, so business configuration is portable. */
export const SUPPORTED_VOICE_PROFILES = ["neutral", "warm", "bright"] as const;
export type VoiceProfile = (typeof SUPPORTED_VOICE_PROFILES)[number];

export function isVoiceProfile(value: string): value is VoiceProfile {
  return (SUPPORTED_VOICE_PROFILES as readonly string[]).includes(value);
}
