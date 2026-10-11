import { WebSocket } from "ws";
import {
  SUPPORTED_VOICE_PROFILES,
  type AudioFormat,
  type StreamingTextToSpeechProvider,
  type SynthesizedSpeech,
  type TtsStream
} from "../types.js";

/**
 * ElevenLabs streaming speech synthesis.
 *
 * NOT VERIFIED: no ElevenLabs credentials exist, so this adapter has never
 * produced a second of audio. It is written from the documented streaming
 * WebSocket API (/v1/text-to-speech/{voice}/stream-input, `xi-api-key` auth,
 * text messages in and base64 audio chunks out) and, like the recognition
 * adapter, every endpoint, model, voice id and output format is overridable
 * from the environment.
 *
 * Chosen for low first-byte latency and because it can emit 8kHz μ-law
 * directly, which is what Twilio wants — no resampling in the middle.
 *
 * Business voice choice stays a fixed list (neutral / warm / bright) mapped to
 * voice ids here. A business can never supply a raw voice id or any other free
 * text that reaches the vendor, so voice settings cannot become an injection
 * channel.
 */

export interface ElevenLabsConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Veyra's fixed voice profiles → the vendor's voice ids. */
  voiceIds: Record<string, string>;
}

const DEFAULT_VOICE_IDS: Record<string, string> = {
  // Publicly documented stock voices. Overridable, because voice choice is a
  // matter of taste and these ids can change.
  neutral: "21m00Tcm4TlvDq8ikWAM",
  warm: "EXAVITQu4vr4xnSDxMaL",
  bright: "AZnzlk1XvdvUeBnXmlld"
};

export function elevenLabsConfig(env: NodeJS.ProcessEnv = process.env): ElevenLabsConfig | null {
  const apiKey = env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: env.ELEVENLABS_TTS_URL ?? "wss://api.elevenlabs.io/v1/text-to-speech",
    model: env.ELEVENLABS_MODEL ?? "eleven_flash_v2_5",
    voiceIds: {
      ...DEFAULT_VOICE_IDS,
      ...(env.ELEVENLABS_VOICE_NEUTRAL ? { neutral: env.ELEVENLABS_VOICE_NEUTRAL } : {}),
      ...(env.ELEVENLABS_VOICE_WARM ? { warm: env.ELEVENLABS_VOICE_WARM } : {}),
      ...(env.ELEVENLABS_VOICE_BRIGHT ? { bright: env.ELEVENLABS_VOICE_BRIGHT } : {})
    }
  };
}

/** Veyra's format → the vendor's output_format parameter. */
function outputFormat(format: AudioFormat): string {
  if (format.encoding === "mulaw" && format.sampleRate === 8000) return "ulaw_8000";
  if (format.encoding === "linear16") return `pcm_${format.sampleRate}`;
  return "ulaw_8000";
}

class ElevenLabsStream implements TtsStream {
  private readonly queue: Buffer[] = [];
  /**
   * A reader waiting for the next chunk. Both halves are kept: a failure has
   * to *reject* a pending read, not resolve it as a clean end — otherwise a
   * refused synthesis is indistinguishable from silence, and on a real call
   * Veyra would simply stop talking with nothing in the log to explain it.
   */
  private waiting: { resolve: (value: IteratorResult<Buffer>) => void; reject: (error: Error) => void } | null = null;
  private done = false;
  private failure: Error | null = null;
  private cancelled = false;
  private firstChunkAt: number | null = null;
  private readonly startedAt = Date.now();

  constructor(private readonly socket: WebSocket) {
    socket.on("message", (data: unknown) => {
      let message: { audio?: string; isFinal?: boolean; error?: string; message?: string };
      try {
        message = JSON.parse(String(data)) as typeof message;
      } catch {
        return;
      }
      if (message.error || (message.message && !message.audio)) {
        this.fail(new Error(`ElevenLabs reported: ${message.error ?? message.message}`));
        return;
      }
      if (message.audio) {
        if (this.firstChunkAt === null) this.firstChunkAt = Date.now();
        this.push(Buffer.from(message.audio, "base64"));
      }
      if (message.isFinal) this.finish();
    });

    socket.on("error", (err: Error) => this.fail(new Error(`ElevenLabs stream error: ${err.message}`)));

    socket.on("close", (code: number, reason: Buffer) => {
      // A close that arrives before any audio is a refusal, not the end of a
      // sentence. The provider's own words are the most useful thing an
      // operator can be told here — "Free users cannot use library voices",
      // say — so they are passed through. They never contain the key.
      if (this.firstChunkAt === null && !this.cancelled) {
        const detail = reason?.toString().trim();
        this.fail(
          new Error(
            `ElevenLabs closed the stream before sending any audio (code ${code})${detail ? `: ${detail}` : ""}`
          )
        );
        return;
      }
      this.finish();
    });
  }

  private push(chunk: Buffer): void {
    if (this.waiting) {
      const { resolve } = this.waiting;
      this.waiting = null;
      resolve({ value: chunk, done: false });
      return;
    }
    this.queue.push(chunk);
  }

  private finish(): void {
    this.done = true;
    if (this.waiting) {
      const { resolve, reject } = this.waiting;
      this.waiting = null;
      if (this.failure) reject(this.failure);
      else resolve({ value: undefined as unknown as Buffer, done: true });
    }
  }

  private fail(error: Error): void {
    // Set before finishing, so a reader already waiting is rejected rather
    // than told the audio simply ended.
    this.failure = error;
    this.finish();
  }

  get chunks(): AsyncIterable<Buffer> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<Buffer> {
        return {
          async next(): Promise<IteratorResult<Buffer>> {
            if (self.failure) throw self.failure;
            const buffered = self.queue.shift();
            if (buffered) return { value: buffered, done: false };
            if (self.done || self.cancelled) return { value: undefined as unknown as Buffer, done: true };
            return new Promise<IteratorResult<Buffer>>((resolve, reject) => {
              self.waiting = { resolve, reject };
            });
          }
        };
      }
    };
  }

  firstChunkMs(): number | null {
    return this.firstChunkAt === null ? null : this.firstChunkAt - this.startedAt;
  }

  async cancel(): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    this.queue.length = 0;
    this.finish();
    try {
      this.socket.close();
    } catch {
      // Already gone.
    }
  }
}

export class ElevenLabsTextToSpeechProvider implements StreamingTextToSpeechProvider {
  readonly name = "elevenlabs" as const;
  readonly voices = SUPPORTED_VOICE_PROFILES;

  constructor(private readonly config: ElevenLabsConfig) {}

  private voiceId(profile: string): string {
    return this.config.voiceIds[profile] ?? this.config.voiceIds.neutral;
  }

  async stream(params: {
    text: string;
    voiceProfile: string;
    language: string;
    format: AudioFormat;
  }): Promise<TtsStream> {
    const query = new URLSearchParams({
      model_id: this.config.model,
      output_format: outputFormat(params.format)
    });
    const socket = new WebSocket(`${this.config.baseUrl}/${this.voiceId(params.voiceProfile)}/stream-input?${query}`, {
      headers: { "xi-api-key": this.config.apiKey }
    });

    const stream = new ElevenLabsStream(socket);

    socket.on("open", () => {
      // Documented protocol: an opening message, the text, then an empty
      // string to flush. The text is whatever the Reception pipeline produced
      // — this adapter never writes words of its own.
      socket.send(JSON.stringify({ text: " ", voice_settings: { stability: 0.5, similarity_boost: 0.8 } }));
      socket.send(JSON.stringify({ text: params.text, try_trigger_generation: true }));
      socket.send(JSON.stringify({ text: "" }));
    });

    return stream;
  }

  /** Non-streaming synthesis, kept so the interface stays usable off a live call. */
  async synthesize(params: { text: string; voiceProfile: string; language: string }): Promise<SynthesizedSpeech> {
    const startedAt = Date.now();
    const stream = await this.stream({ ...params, format: { encoding: "mulaw", sampleRate: 8000 } });
    const parts: Buffer[] = [];
    for await (const chunk of stream.chunks) parts.push(chunk);
    const audio = Buffer.concat(parts);
    return {
      // A reference, not the audio: Veyra does not store what it said as sound.
      reference: `elevenlabs:${audio.length}bytes`,
      // μ-law 8kHz is one byte per sample.
      durationMs: audio.length > 0 ? Math.round((audio.length / 8000) * 1000) : Date.now() - startedAt,
      voiceProfile: params.voiceProfile
    };
  }

  /**
   * Reachability, without spending synthesis quota on every Console load.
   *
   * A real key taught this the difference that matters: an ElevenLabs key can
   * be scoped so narrowly that it authenticates fine for speech but cannot
   * read the account at all. Reporting that as "rejected the API key" sends an
   * operator hunting for a bad credential that isn't bad — so the two cases
   * are now told apart, and a permissions-limited key is reported as
   * unconfirmed rather than wrong.
   */
  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const response = await fetch("https://api.elevenlabs.io/v1/models", {
        headers: { "xi-api-key": this.config.apiKey },
        signal: AbortSignal.timeout(8000)
      });
      if (response.ok) return { ok: true, detail: "ElevenLabs reachable." };

      if (response.status === 401) {
        const body = await response.text().catch(() => "");
        // The provider's own status word; never the body wholesale, which can
        // echo request details back.
        const missingPermissions = body.includes("missing_permissions");
        return missingPermissions
          ? {
              ok: false,
              detail:
                "The ElevenLabs key authenticates but has no permission to read the account, so synthesis could not be confirmed. Give the key voices/models read access, or check it can synthesise."
            }
          : { ok: false, detail: "ElevenLabs rejected the API key." };
      }
      return { ok: false, detail: `ElevenLabs returned ${response.status}.` };
    } catch {
      return { ok: false, detail: "ElevenLabs could not be reached." };
    }
  }
}
