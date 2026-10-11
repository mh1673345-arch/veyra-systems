import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type CallInstruction,
  type VoiceEvent,
  type VoiceProvider,
  VoiceProviderError,
  VoiceWebhookVerificationError
} from "../types.js";

/**
 * Twilio, over its REST API with fetch — no SDK, so no Twilio object shape
 * escapes this file.
 *
 * NOT VERIFIED against Twilio: no Twilio credentials have been configured, so
 * this adapter has never placed or answered a real call. Signature
 * verification follows Twilio's documented scheme (HMAC-SHA1 over the full URL
 * with POST parameters appended in sorted order, base64) and is unit-tested
 * against a known secret; everything else is written from the documented API
 * and should be treated as unproven until a real test call is made.
 */

const API = "https://api.twilio.com/2010-04-01";

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
}

export function twilioConfig(env: NodeJS.ProcessEnv = process.env): TwilioConfig | null {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return null;
  return { accountSid, authToken };
}

/**
 * Verifies an X-Twilio-Signature. Exported for tests.
 *
 * Twilio signs the exact request URL with the POST body's parameters appended
 * as sorted key/value pairs, so the URL Veyra reconstructs has to match the
 * one configured at Twilio — including scheme and host.
 */
export function verifyTwilioSignature(params: {
  url: string;
  form: Record<string, string>;
  signature: string | undefined;
  authToken: string;
}): void {
  if (!params.signature) throw new VoiceWebhookVerificationError("Missing X-Twilio-Signature header.");

  const payload =
    params.url +
    Object.keys(params.form)
      .sort()
      .map((key) => `${key}${params.form[key]}`)
      .join("");
  const expected = Buffer.from(createHmac("sha1", params.authToken).update(payload, "utf8").digest("base64"));
  const provided = Buffer.from(params.signature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw new VoiceWebhookVerificationError("X-Twilio-Signature does not match.");
  }
}

/** Twilio posts form-encoded bodies; the raw bytes are needed for the signature. */
function parseForm(rawBody: Buffer): Record<string, string> {
  const params = new URLSearchParams(rawBody.toString("utf8"));
  const form: Record<string, string> = {};
  for (const [key, value] of params.entries()) form[key] = value;
  return form;
}

const STATUS_EVENTS: Record<string, VoiceEvent["type"]> = {
  initiated: "call.ringing",
  ringing: "call.ringing",
  "in-progress": "call.answered",
  answered: "call.answered",
  completed: "call.completed",
  busy: "call.failed",
  failed: "call.failed",
  "no-answer": "call.failed",
  canceled: "call.completed"
};

export class TwilioVoiceProvider implements VoiceProvider {
  readonly name = "twilio" as const;
  /** Twilio can bridge a live call to another number. */
  readonly supportsTransfer = true;

  constructor(private readonly config: TwilioConfig) {}

  private async call(method: "POST" | "GET", path: string, form?: Record<string, string>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(`${API}/Accounts/${this.config.accountSid}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: form ? new URLSearchParams(form) : undefined,
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw new VoiceProviderError("unavailable", "Could not reach Twilio.");
    }
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const message = (json.message as string | undefined) ?? `Twilio returned ${response.status}.`;
      throw new VoiceProviderError(
        response.status >= 500 ? "unavailable" : response.status === 404 ? "not_found" : "rejected",
        message
      );
    }
    return json;
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.call("GET", ".json");
      return { ok: true, detail: "Twilio account reachable." };
    } catch (err) {
      return { ok: false, detail: err instanceof VoiceProviderError ? err.message : "Twilio could not be reached." };
    }
  }

  /**
   * TwiML for the next step of the call. Text is XML-escaped, so nothing a
   * caller or a business setting contains can inject markup into the line.
   */
  private twiml(instruction: CallInstruction): string {
    const escape = escapeXml;

    if (instruction.kind === "say") {
      const next = instruction.then === "listen" ? "<Gather input='speech' speechTimeout='auto'/>" : "<Hangup/>";
      return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escape(instruction.text)}</Say>${next}</Response>`;
    }
    if (instruction.kind === "transfer") {
      const preamble = instruction.sayFirst ? `<Say>${escape(instruction.sayFirst)}</Say>` : "";
      return `<?xml version="1.0" encoding="UTF-8"?><Response>${preamble}<Dial>${escape(instruction.to)}</Dial></Response>`;
    }
    const preamble = instruction.sayFirst ? `<Say>${escape(instruction.sayFirst)}</Say>` : "";
    return `<?xml version="1.0" encoding="UTF-8"?><Response>${preamble}<Hangup/></Response>`;
  }

  /** Exposed so the webhook route can answer Twilio inline with the next step. */
  instructionMarkup(instruction: CallInstruction): string {
    return this.twiml(instruction);
  }

  /**
   * TwiML that hands the call's audio to Veyra over a WebSocket.
   *
   * With <Connect><Stream> the media stream *is* the call: Veyra recognises
   * speech and speaks back over the socket, which is what makes streaming
   * recognition and barge-in possible at all. Twilio's own <Say>/<Gather>
   * would be simpler but cannot be interrupted mid-sentence.
   */
  mediaStreamMarkup(params: { websocketUrl: string; callSid: string }): string {
    return (
      '<?xml version="1.0" encoding="UTF-8"?>' +
      "<Response>" +
      `<Connect><Stream url="${escapeXml(params.websocketUrl)}">` +
      `<Parameter name="callSid" value="${escapeXml(params.callSid)}"/>` +
      "</Stream></Connect>" +
      "</Response>"
    );
  }

  /** An empty instruction set: acknowledges a status callback without changing the call. */
  noopMarkup(): string {
    return '<?xml version="1.0" encoding="UTF-8"?><Response/>';
  }

  async perform(params: { externalCallId: string; instruction: CallInstruction }): Promise<void> {
    // Redirecting a live call to fresh TwiML is how mid-call changes are made.
    await this.call("POST", `/Calls/${encodeURIComponent(params.externalCallId)}.json`, {
      Twiml: this.twiml(params.instruction)
    });
  }

  async cancelSpeech(externalCallId: string): Promise<void> {
    // Replacing the current TwiML stops whatever is being spoken; the caller's
    // new utterance is then gathered normally.
    await this.call("POST", `/Calls/${encodeURIComponent(externalCallId)}.json`, {
      Twiml: `<?xml version="1.0" encoding="UTF-8"?><Response><Gather input='speech' speechTimeout='auto'/></Response>`
    });
  }

  async transfer(params: { externalCallId: string; to: string }): Promise<void> {
    await this.perform({ externalCallId: params.externalCallId, instruction: { kind: "transfer", to: params.to } });
  }

  async hangup(params: { externalCallId: string }): Promise<void> {
    await this.call("POST", `/Calls/${encodeURIComponent(params.externalCallId)}.json`, { Status: "completed" });
  }

  async startOutboundCall(params: { to: string; from: string; businessId: string }): Promise<{ externalCallId: string }> {
    const statusCallback = process.env.VEYRA_PUBLIC_API_URL
      ? `${process.env.VEYRA_PUBLIC_API_URL}/api/voice/webhooks/twilio`
      : undefined;
    const created = await this.call("POST", "/Calls.json", {
      To: params.to,
      From: params.from,
      Twiml: `<?xml version="1.0" encoding="UTF-8"?><Response><Gather input='speech' speechTimeout='auto'/></Response>`,
      ...(statusCallback ? { StatusCallback: statusCallback, StatusCallbackMethod: "POST" } : {})
    });
    return { externalCallId: String(created.sid) };
  }

  verifyWebhook(params: {
    rawBody: Buffer;
    headers: Record<string, string | string[] | undefined>;
    url: string;
  }): VoiceEvent {
    const header = params.headers["x-twilio-signature"];
    const form = parseForm(params.rawBody);
    verifyTwilioSignature({
      url: params.url,
      form,
      signature: Array.isArray(header) ? header[0] : header,
      authToken: this.config.authToken
    });

    const callSid = form.CallSid ?? "";
    const callStatus = form.CallStatus ?? "";
    const speech = form.SpeechResult;

    // Twilio does not send an event id, so one is derived from the pieces that
    // make a delivery unique. A retry of the same event produces the same id,
    // which is exactly what the idempotency check needs.
    const derivedId = `twilio:${callSid}:${speech ? `speech:${form.SequenceNumber ?? hash(speech)}` : callStatus}`;

    // The first webhook of an inbound call is the call arriving. Twilio says
    // "ringing" for both that and later status callbacks, so the distinction is
    // made here: an inbound voice request with no StreamSid and no speech is
    // the carrier asking Veyra what to do with a new call.
    //
    // This is the bug that would have stopped the very first real call: without
    // it nothing ever emitted call.incoming, so no CallSession was created and
    // every later transcript was dropped as "unknown call".
    const inbound = form.Direction !== "outbound-api" && form.Direction !== "outbound-dial";
    const isNewInboundCall = inbound && !speech && !form.StreamSid && (callStatus === "ringing" || callStatus === "initiated" || callStatus === "");

    const type: VoiceEvent["type"] = isNewInboundCall
      ? "call.incoming"
      : speech
        ? "transcript.final"
        : (STATUS_EVENTS[callStatus] ?? "other");

    return {
      id: derivedId,
      type,
      providerType: speech ? "speech" : callStatus || "unknown",
      externalCallId: callSid,
      occurredAt: new Date(),
      direction: form.Direction === "outbound-api" ? "outbound" : "inbound",
      from: form.From ?? null,
      to: form.To ?? null,
      transcript: speech,
      transcriptConfidence: form.Confidence ? Number(form.Confidence) : null,
      durationSeconds: form.CallDuration ? Number(form.CallDuration) : null,
      hangupCause: callStatus === "completed" ? "caller_hangup" : callStatus || null
    };
  }
}

/** Nothing a caller or a business setting contains may become markup. */
export function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

function hash(value: string): string {
  return createHmac("sha256", "veyra-event-id").update(value).digest("hex").slice(0, 16);
}
