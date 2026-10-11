import type { CallSession } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { handleReceptionTurn } from "../reception/turn.js";
import { spokenForm } from "./speech.js";
import {
  type AudioFormat,
  type MediaTransport,
  type StreamingSpeechToTextProvider,
  type StreamingTextToSpeechProvider,
  type SttStream,
  type TtsStream
} from "./types.js";

/**
 * A live call, once audio is flowing.
 *
 * This is the part that only exists for voice, and it is deliberately the only
 * part: it moves audio between the carrier and the speech providers, decides
 * when the caller has finished speaking, and stops talking when interrupted.
 * What Veyra *says* is still decided entirely by `handleReceptionTurn` — the
 * same pipeline the chat endpoint uses.
 *
 * Nothing here knows about Twilio, Deepgram or ElevenLabs. Those live behind
 * MediaTransport, StreamingSpeechToTextProvider and
 * StreamingTextToSpeechProvider, so the orchestration can be tested with fakes
 * and a vendor can be swapped without touching this file.
 */

export interface LiveCallDeps {
  transport: MediaTransport;
  stt: StreamingSpeechToTextProvider;
  tts: StreamingTextToSpeechProvider;
  session: CallSession;
  language: string;
  voiceProfile: string;
  /** Spoken as soon as the audio path is up. */
  greeting: string;
  /** Hard ceiling on the whole call. */
  maxCallSeconds: number;
  now?: () => number;
}

/** What a turn cost, in milliseconds, end to end inside Veyra. */
export interface TurnTiming {
  sttFinalMs: number | null;
  responderMs: number;
  actionMs: number;
  ttsFirstChunkMs: number | null;
  /** Caller stopped speaking → first audio chunk handed to the carrier. */
  speechEndToFirstAudioMs: number | null;
  totalMs: number;
}

export class LiveCall {
  private sttStream: SttStream | null = null;
  private speaking: TtsStream | null = null;
  private turnInProgress = false;
  /** Set when the caller talks over Veyra, so the turn is recorded as interrupted. */
  private interrupted = false;
  private closed = false;
  private lastSpeechStartedAt: number | null = null;
  private lastSpeechEndedAt: number | null = null;
  private readonly startedAt: number;
  private timeout: NodeJS.Timeout | null = null;

  constructor(private readonly deps: LiveCallDeps) {
    this.startedAt = this.now();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  async start(): Promise<void> {
    const { transport, stt, session, language } = this.deps;

    this.sttStream = await stt.openStream({
      format: transport.format,
      language,
      externalCallId: session.externalCallId
    });

    // Barge-in. The caller starting to speak is enough to stop Veyra — waiting
    // for a transcript would mean talking over them for another second.
    this.sttStream.onSpeechStarted(() => {
      this.lastSpeechStartedAt = this.now();
      if (this.speaking) void this.stopSpeaking();
    });

    this.sttStream.onFinal((transcript) => {
      this.lastSpeechEndedAt = this.now();
      void this.handleUtterance(transcript.text, transcript.confidence);
    });

    this.sttStream.onError((error) => {
      // Recognition failing is not a reason to drop a caller: say so and keep
      // the line open so they can try again.
      console.error("[veyra:voice] recognition error on a live call:", error.message);
      void this.say("Sorry — I'm having trouble hearing you. Could you say that again?");
    });

    transport.onAudio((chunk) => this.sttStream?.write(chunk));
    transport.onClosed((reason) => void this.finish(reason));

    // A stuck call must not run forever.
    this.timeout = setTimeout(
      () => {
        void this.say("I need to end the call here, but the team can pick this up. Thanks for calling.").then(() =>
          this.deps.transport.close("timeout")
        );
      },
      Math.max(60, this.deps.maxCallSeconds) * 1000
    );

    await this.say(this.deps.greeting);
  }

  /** Speaks text, streaming the audio out as it arrives. */
  private async say(text: string): Promise<{ firstChunkMs: number | null; firstAudioAt: number | null }> {
    const { tts, transport, voiceProfile, language } = this.deps;
    let firstAudioAt: number | null = null;

    try {
      const stream = await tts.stream({ text: spokenForm(text), voiceProfile, language, format: transport.format });
      this.speaking = stream;
      for await (const chunk of stream.chunks) {
        if (this.speaking !== stream) break; // cancelled by barge-in
        if (firstAudioAt === null) firstAudioAt = this.now();
        transport.send(chunk);
      }
      const firstChunkMs = stream.firstChunkMs();
      if (this.speaking === stream) this.speaking = null;
      return { firstChunkMs, firstAudioAt };
    } catch (error) {
      // Synthesis failing must not end the call silently. The turn is still
      // recorded, and the operator sees it in the call detail.
      console.error("[veyra:voice] speech synthesis failed:", error instanceof Error ? error.message : error);
      this.speaking = null;
      return { firstChunkMs: null, firstAudioAt: null };
    }
  }

  private async stopSpeaking(): Promise<void> {
    const stream = this.speaking;
    if (!stream) return;
    this.speaking = null;
    this.interrupted = true;
    // Both halves matter: stop the provider generating, and drop what the
    // carrier has already buffered. Without the second, the caller keeps
    // hearing the old sentence for seconds after interrupting.
    this.deps.transport.clearQueuedAudio();
    await stream.cancel().catch(() => undefined);
  }

  /**
   * One caller utterance: straight into the shared Reception pipeline, then
   * spoken back. No voice-specific answer logic exists anywhere in here.
   */
  private async handleUtterance(text: string, confidence: number | null): Promise<void> {
    if (this.closed) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    // Utterances that arrive while a turn is still running are queued by the
    // provider's own finalisation; processing two at once would double-book.
    if (this.turnInProgress) return;
    this.turnInProgress = true;
    const wasInterrupted = this.interrupted;
    this.interrupted = false;

    const turnStartedAt = this.now();
    const speechEndedAt = this.lastSpeechEndedAt ?? turnStartedAt;

    try {
      const turn = await handleReceptionTurn({
        conversationId: this.deps.session.conversationId!,
        callerText: trimmed
      });

      const spoken = await this.say(turn.receptionistMessage.text);

      const timing: TurnTiming = {
        sttFinalMs: this.lastSpeechStartedAt !== null ? speechEndedAt - this.lastSpeechStartedAt : null,
        responderMs: turn.timings.responderMs,
        actionMs: turn.timings.actionMs,
        ttsFirstChunkMs: spoken.firstChunkMs,
        speechEndToFirstAudioMs: spoken.firstAudioAt !== null ? spoken.firstAudioAt - speechEndedAt : null,
        totalMs: this.now() - turnStartedAt
      };

      await prisma.callTurn
        .create({
          data: {
            callSessionId: this.deps.session.id,
            messageId: turn.receptionistMessage.id,
            sttMs: timing.sttFinalMs,
            responderMs: timing.responderMs,
            actionMs: timing.actionMs,
            ttsMs: timing.ttsFirstChunkMs,
            totalMs: timing.speechEndToFirstAudioMs ?? timing.totalMs,
            interrupted: wasInterrupted
          }
        })
        .catch((error) => console.error("[veyra:voice] could not record a call turn", error));

      // Transcript confidence is the provider's own number, recorded for
      // operators and never used to decide anything.
      if (confidence !== null && confidence < 0.4) {
        console.warn("[veyra:voice] low recognition confidence on a turn (%s)", confidence.toFixed(2));
      }
    } catch (error) {
      console.error("[veyra:voice] a live turn failed:", error instanceof Error ? error.message : error);
      await this.say("Sorry — something went wrong on my side. Let me pass this to the team.");
    } finally {
      this.turnInProgress = false;
    }
  }

  /** The call ended, from either side. */
  async finish(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timeout) clearTimeout(this.timeout);
    await this.stopSpeaking();
    await this.sttStream?.close().catch(() => undefined);
    console.log("[veyra:voice] live call finished (%s) after %ds", reason, Math.round((this.now() - this.startedAt) / 1000));
  }
}

/** Exposed for the media bridge, which needs the same format the transport negotiated. */
export function audioFormatOf(transport: MediaTransport): AudioFormat {
  return transport.format;
}
