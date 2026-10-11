import { WebSocket } from "ws";
import type {
  AudioFormat,
  SttStream,
  StreamingSpeechToTextProvider,
  Transcript
} from "../types.js";

/**
 * Deepgram streaming speech recognition.
 *
 * NOT VERIFIED: no Deepgram credentials exist, so this adapter has never
 * transcribed a real word. It is written from Deepgram's documented streaming
 * API — a WebSocket to /v1/listen with the audio format as query parameters,
 * token auth, JSON results carrying `is_final` / `speech_final` and
 * `channel.alternatives[0]` — and every endpoint, model and tuning value is
 * overridable from the environment, so a change at the vendor's end can be
 * corrected without a code change.
 *
 * Chosen for this phase because it takes 8kHz μ-law directly (exactly what a
 * carrier sends, so nothing has to be resampled in the middle), does its own
 * endpointing, and reports speech starting — which is what makes barge-in
 * possible.
 *
 * No key, URL or audio ever reaches a log.
 */

export interface DeepgramConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Silence in ms before Deepgram finalises an utterance. */
  endpointingMs: number;
  utteranceEndMs: number;
}

export function deepgramConfig(env: NodeJS.ProcessEnv = process.env): DeepgramConfig | null {
  const apiKey = env.DEEPGRAM_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: env.DEEPGRAM_STT_URL ?? "wss://api.deepgram.com/v1/listen",
    model: env.DEEPGRAM_MODEL ?? "nova-2-phonecall",
    endpointingMs: Number(env.DEEPGRAM_ENDPOINTING_MS ?? 300),
    utteranceEndMs: Number(env.DEEPGRAM_UTTERANCE_END_MS ?? 1000)
  };
}

interface DeepgramResult {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: { transcript?: string; confidence?: number }[] };
}

class DeepgramSttStream implements SttStream {
  private speechStarted: (() => void) | null = null;
  private final: ((transcript: Transcript) => void) | null = null;
  private error: ((error: Error) => void) | null = null;
  private readonly pending: Buffer[] = [];
  private open = false;
  private closed = false;
  /** Interim text accumulates until the provider says the utterance ended. */
  private buffered = "";
  private bufferedConfidence: number | null = null;
  private speaking = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly language: string
  ) {
    socket.on("open", () => {
      this.open = true;
      for (const chunk of this.pending) socket.send(chunk);
      this.pending.length = 0;
    });

    socket.on("message", (data: unknown) => this.handle(String(data)));

    socket.on("error", (err: Error) => {
      // The message is safe to log; the URL (which carries the key in some
      // configurations) is never included.
      this.error?.(new Error(`Deepgram stream error: ${err.message}`));
    });

    socket.on("close", () => {
      this.open = false;
      if (!this.closed) this.error?.(new Error("Deepgram closed the stream unexpectedly."));
    });
  }

  private handle(raw: string): void {
    let message: DeepgramResult;
    try {
      message = JSON.parse(raw) as DeepgramResult;
    } catch {
      return;
    }

    // Deepgram reports the caller starting to talk before any words exist.
    // That is the barge-in trigger.
    if (message.type === "SpeechStarted") {
      this.speaking = true;
      this.speechStarted?.();
      return;
    }

    const alternative = message.channel?.alternatives?.[0];
    const text = alternative?.transcript?.trim() ?? "";

    if (message.type === "UtteranceEnd") {
      this.flush();
      return;
    }

    if (!text) return;

    if (!this.speaking) {
      this.speaking = true;
      this.speechStarted?.();
    }

    if (message.is_final) {
      this.buffered = `${this.buffered} ${text}`.trim();
      this.bufferedConfidence = alternative?.confidence ?? this.bufferedConfidence;
      // speech_final means Deepgram's endpointing decided the caller stopped.
      if (message.speech_final) this.flush();
    }
  }

  private flush(): void {
    const text = this.buffered.trim();
    this.buffered = "";
    this.speaking = false;
    const confidence = this.bufferedConfidence;
    this.bufferedConfidence = null;
    if (!text) return;
    this.final?.({ text, confidence, language: this.language, isFinal: true });
  }

  write(chunk: Buffer): void {
    if (this.closed) return;
    if (!this.open) {
      // Audio that arrives before the socket is up is held rather than dropped,
      // so the first thing a caller says is not lost.
      if (this.pending.length < 200) this.pending.push(chunk);
      return;
    }
    this.socket.send(chunk);
  }

  onSpeechStarted(handler: () => void): void {
    this.speechStarted = handler;
  }

  onFinal(handler: (transcript: Transcript) => void): void {
    this.final = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.error = handler;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.flush();
    try {
      if (this.socket.readyState === this.socket.OPEN) {
        // Documented "finish up" message, then close.
        this.socket.send(JSON.stringify({ type: "CloseStream" }));
      }
      this.socket.close();
    } catch {
      // Already gone.
    }
  }
}

export class DeepgramSpeechToTextProvider implements StreamingSpeechToTextProvider {
  readonly name = "deepgram" as const;

  constructor(private readonly config: DeepgramConfig) {}

  async openStream(params: { format: AudioFormat; language: string; externalCallId: string }): Promise<SttStream> {
    const query = new URLSearchParams({
      model: this.config.model,
      language: params.language,
      encoding: params.format.encoding,
      sample_rate: String(params.format.sampleRate),
      channels: "1",
      interim_results: "true",
      vad_events: "true",
      endpointing: String(this.config.endpointingMs),
      utterance_end_ms: String(this.config.utteranceEndMs),
      punctuate: "true",
      smart_format: "true"
    });

    const socket = new WebSocket(`${this.config.baseUrl}?${query.toString()}`, {
      headers: { Authorization: `Token ${this.config.apiKey}` }
    });
    return new DeepgramSttStream(socket, params.language);
  }

  /**
   * Batch recognition, for anything that is not a live call. The streaming
   * path above is what a phone call uses.
   */
  async transcribe(params: { audio: Buffer; language: string }): Promise<Transcript> {
    const query = new URLSearchParams({ model: this.config.model, language: params.language, punctuate: "true" });
    const httpUrl = this.config.baseUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");

    const response = await fetch(`${httpUrl}?${query.toString()}`, {
      method: "POST",
      headers: { Authorization: `Token ${this.config.apiKey}`, "Content-Type": "audio/*" },
      body: new Uint8Array(params.audio),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`Deepgram returned ${response.status}.`);

    const body = (await response.json()) as {
      results?: { channels?: { alternatives?: { transcript?: string; confidence?: number }[] }[] };
    };
    const alternative = body.results?.channels?.[0]?.alternatives?.[0];
    return {
      text: alternative?.transcript?.trim() ?? "",
      confidence: alternative?.confidence ?? null,
      language: params.language,
      isFinal: true
    };
  }

  /** A cheap reachability check for the Console's provider panel. No audio sent. */
  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const response = await fetch("https://api.deepgram.com/v1/projects", {
        headers: { Authorization: `Token ${this.config.apiKey}` },
        signal: AbortSignal.timeout(8000)
      });
      if (response.ok) return { ok: true, detail: "Deepgram reachable." };
      return {
        ok: false,
        // Status only — never the response body, which can echo request details.
        detail: response.status === 401 ? "Deepgram rejected the API key." : `Deepgram returned ${response.status}.`
      };
    } catch {
      return { ok: false, detail: "Deepgram could not be reached." };
    }
  }
}
