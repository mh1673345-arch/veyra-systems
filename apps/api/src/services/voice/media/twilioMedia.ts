import type { WebSocket } from "ws";
import { TELEPHONY_AUDIO, type AudioFormat, type MediaTransport } from "../types.js";

/**
 * Twilio Media Streams, as a MediaTransport.
 *
 * Everything Twilio-shaped about live audio is in this file: the JSON envelope,
 * base64 μ-law payloads, stream ids, and the `clear` message that drops audio
 * the carrier has buffered but not yet played.
 *
 * NOT VERIFIED against Twilio: no Twilio credentials exist, so no real call has
 * ever connected to this. The protocol here follows Twilio's documented
 * bidirectional Media Streams messages (`connected`, `start`, `media`, `stop`
 * inbound; `media`, `mark`, `clear` outbound). Treat every detail as unproven
 * until a real call has run through it.
 */

interface TwilioStartMessage {
  event: "start";
  start: {
    streamSid: string;
    callSid: string;
    mediaFormat?: { encoding?: string; sampleRate?: number; channels?: number };
    customParameters?: Record<string, string>;
  };
}

interface TwilioMediaMessage {
  event: "media";
  media: { payload: string; track?: string };
}

type TwilioInbound =
  | TwilioStartMessage
  | TwilioMediaMessage
  | { event: "connected" }
  | { event: "stop"; stop?: { callSid?: string } }
  | { event: "mark"; mark?: { name?: string } }
  | { event: string };

export class TwilioMediaTransport implements MediaTransport {
  readonly format: AudioFormat = TELEPHONY_AUDIO;
  private audioHandler: ((chunk: Buffer) => void) | null = null;
  private closedHandler: ((reason: string) => void) | null = null;
  private streamSid: string | null = null;
  private closed = false;

  private constructor(
    private readonly socket: WebSocket,
    readonly externalCallId: string
  ) {}

  /**
   * Waits for Twilio's `start` message, which is the first point at which the
   * call this socket belongs to is known.
   */
  static async accept(socket: WebSocket, timeoutMs = 10_000): Promise<TwilioMediaTransport> {
    const start = await new Promise<TwilioStartMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Twilio did not send a start message in time.")), timeoutMs);

      const onMessage = (data: unknown) => {
        let parsed: TwilioInbound;
        try {
          parsed = JSON.parse(String(data)) as TwilioInbound;
        } catch {
          return;
        }
        if (parsed.event === "start") {
          clearTimeout(timer);
          socket.off("message", onMessage);
          resolve(parsed as TwilioStartMessage);
        }
      };

      socket.on("message", onMessage);
      socket.once("close", () => {
        clearTimeout(timer);
        reject(new Error("The media socket closed before the call started."));
      });
    });

    const transport = new TwilioMediaTransport(socket, start.start.callSid);
    transport.streamSid = start.start.streamSid;
    transport.listen();
    return transport;
  }

  private listen(): void {
    this.socket.on("message", (data: unknown) => {
      let parsed: TwilioInbound;
      try {
        parsed = JSON.parse(String(data)) as TwilioInbound;
      } catch {
        return;
      }
      if (parsed.event === "media") {
        const payload = (parsed as TwilioMediaMessage).media?.payload;
        // Caller audio only; Twilio can echo the outbound track back.
        const track = (parsed as TwilioMediaMessage).media?.track;
        if (payload && (!track || track === "inbound")) {
          this.audioHandler?.(Buffer.from(payload, "base64"));
        }
        return;
      }
      if (parsed.event === "stop") {
        this.markClosed("carrier_stop");
      }
    });

    this.socket.on("close", () => this.markClosed("socket_closed"));
    this.socket.on("error", (error: Error) => {
      console.error("[veyra:voice] media socket error:", error.message);
      this.markClosed("socket_error");
    });
  }

  private markClosed(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closedHandler?.(reason);
  }

  onAudio(handler: (chunk: Buffer) => void): void {
    this.audioHandler = handler;
  }

  onClosed(handler: (reason: string) => void): void {
    this.closedHandler = handler;
  }

  send(chunk: Buffer): void {
    if (this.closed || !this.streamSid || this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(
      JSON.stringify({
        event: "media",
        streamSid: this.streamSid,
        media: { payload: chunk.toString("base64") }
      })
    );
  }

  /**
   * Drops audio Twilio has queued but not yet played. This is what makes
   * barge-in feel immediate rather than arriving a sentence late.
   */
  clearQueuedAudio(): void {
    if (this.closed || !this.streamSid || this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(JSON.stringify({ event: "clear", streamSid: this.streamSid }));
  }

  close(reason: string): void {
    this.markClosed(reason);
    try {
      this.socket.close();
    } catch {
      // Already gone.
    }
  }
}
