import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { prisma } from "../../../db/client.js";
import { currentEnvironment } from "../../../config/database.js";
import { LiveCall } from "../liveCall.js";
import { speechToTextProvider, textToSpeechProvider } from "../registry.js";
import { isStreamingStt, isStreamingTts } from "../types.js";
import { TwilioMediaTransport } from "./twilioMedia.js";

/**
 * The media bridge: where a carrier's audio socket becomes a live Veyra call.
 *
 * Mounted on the HTTP server rather than inside Express, because a WebSocket
 * upgrade is not a request/response. Exactly one path is accepted; anything
 * else is refused, so opening this port does not widen the surface of the API.
 *
 * NOT VERIFIED: no carrier has ever connected to this. It is written against
 * Twilio's documented Media Streams protocol and exercised only through the
 * in-memory transport in tests.
 */

export const MEDIA_STREAM_PATH = "/api/voice/media/twilio";

export function mediaStreamUrl(publicApiUrl: string): string {
  // Twilio needs wss:// — the public URL is https:// in every real setup.
  return `${publicApiUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:")}${MEDIA_STREAM_PATH}`;
}

export interface MediaBridge {
  close(): Promise<void>;
  /** Live calls, by the provider's call id. Used for shutdown and for tests. */
  readonly active: Map<string, LiveCall>;
}

export function attachMediaBridge(server: Server): MediaBridge {
  const wss = new WebSocketServer({ noServer: true });
  const active = new Map<string, LiveCall>();

  server.on("upgrade", (request, socket, head) => {
    const path = (request.url ?? "").split("?")[0];
    if (path !== MEDIA_STREAM_PATH) {
      // Not ours: refuse rather than leaving the socket hanging.
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  wss.on("connection", (socket: WebSocket) => {
    void handleConnection(socket, active);
  });

  return {
    active,
    async close() {
      for (const call of active.values()) await call.finish("server_shutdown").catch(() => undefined);
      active.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  };
}

async function handleConnection(socket: WebSocket, active: Map<string, LiveCall>): Promise<void> {
  let transport: TwilioMediaTransport;
  try {
    transport = await TwilioMediaTransport.accept(socket);
  } catch (error) {
    console.warn("[veyra:voice] a media socket never identified its call: %s", error instanceof Error ? error.message : error);
    socket.close();
    return;
  }

  // The call must already exist: it was created by the inbound webhook, which
  // is where the plan, configuration and provider were checked. A socket that
  // does not match a known call is refused rather than trusted.
  const session = await prisma.callSession.findFirst({
    where: { externalCallId: transport.externalCallId },
    orderBy: { startedAt: "desc" }
  });
  if (!session || !session.conversationId) {
    console.warn("[veyra:voice] refused a media socket for an unknown call");
    transport.close("unknown_call");
    return;
  }
  if (session.status === "completed" || session.status === "failed" || session.status === "missed") {
    transport.close("call_already_ended");
    return;
  }

  const stt = speechToTextProvider();
  const tts = textToSpeechProvider();
  if (!isStreamingStt(stt) || !isStreamingTts(tts)) {
    // Without streaming speech there is no live call to run. Ending the socket
    // is honest; the caller hears the carrier's own failure handling.
    console.error("[veyra:voice] no streaming speech providers are configured; dropping the media socket");
    transport.close("speech_unavailable");
    return;
  }

  const [settings, business] = await Promise.all([
    prisma.voiceSettings.findUnique({ where: { businessId: session.businessId } }),
    prisma.business.findUnique({ where: { id: session.businessId }, select: { greeting: true } })
  ]);

  // The greeting the inbound webhook already decided on and recorded.
  const greetingMessage = await prisma.message.findFirst({
    where: { conversationId: session.conversationId, sender: "receptionist" },
    orderBy: { createdAt: "asc" }
  });

  const call = new LiveCall({
    transport,
    stt,
    tts,
    session,
    language: settings?.language ?? "en-US",
    voiceProfile: settings?.voiceProfile ?? "neutral",
    greeting: greetingMessage?.text ?? settings?.greeting ?? business?.greeting ?? "Hello, how can I help?",
    maxCallSeconds: settings?.maxCallSeconds ?? 600
  });

  active.set(transport.externalCallId, call);
  transport.onClosed(() => {
    active.delete(transport.externalCallId);
  });

  try {
    await call.start();
  } catch (error) {
    console.error("[veyra:voice] a live call failed to start:", error instanceof Error ? error.message : error);
    await call.finish("start_failed");
    transport.close("start_failed");
    active.delete(transport.externalCallId);
  }
}

/**
 * Whether the media bridge should run at all. In production it needs a public
 * HTTPS URL to hand to the carrier; without one, nothing could connect anyway.
 */
export function mediaBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (currentEnvironment(env.NODE_ENV) !== "production") return true;
  return Boolean(env.VEYRA_PUBLIC_API_URL?.startsWith("https://"));
}
