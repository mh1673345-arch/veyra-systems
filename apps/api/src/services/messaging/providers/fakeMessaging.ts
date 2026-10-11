import { randomUUID } from "node:crypto";
import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  DeliveryReceiptEvent,
  InboundMessageEvent,
  MessagingResult,
  MessagingWebhookAdapter,
  OutboundSms,
  OutboundWhatsApp,
  SmsProvider,
  WhatsAppProvider
} from "../types.js";

/**
 * Development messaging providers.
 *
 * They capture messages in memory and say so — `simulated` is true and the
 * name is "fake", so no status surface can report them as live. They exist to
 * make the orchestration deterministic in tests, and to let the failure paths
 * be exercised without a vendor account: a number can be made to fail
 * permanently, transiently, or as opted-out.
 *
 * Production must never select these; the registry refuses to.
 */

/** Numbers that make the fake provider behave badly, on purpose. */
export const FAKE_INVALID_NUMBER = "+10000000001";
export const FAKE_TRANSIENT_FAILURE_NUMBER = "+10000000002";
export const FAKE_OPTED_OUT_NUMBER = "+10000000003";

export interface CapturedMessage {
  channel: "sms" | "whatsapp";
  to: string;
  from: string;
  body: string;
  /** Set only for a WhatsApp template send. */
  templateName?: string;
  templateLanguage?: string;
  templateVariables?: string[];
  providerMessageId: string;
  idempotencyKey?: string;
  sentAt: Date;
}

const captured: CapturedMessage[] = [];
/** Keys the provider has already accepted, so a retry is collapsed like a real vendor's. */
const acceptedKeys = new Map<string, string>();

export function capturedMessages(): CapturedMessage[] {
  return [...captured];
}

export function resetFakeMessaging(): void {
  captured.length = 0;
  acceptedKeys.clear();
}

function result(overrides: Partial<MessagingResult> & { detail: string }): MessagingResult {
  return {
    accepted: false,
    providerMessageId: null,
    status: "failed",
    retryable: false,
    timestamp: new Date(),
    ...overrides
  };
}

/** The behaviour both fake adapters share, so SMS and WhatsApp cannot drift. */
function simulate(
  channel: "sms" | "whatsapp",
  message: { to: string; from: string; body: string; idempotencyKey?: string },
  extra: Partial<CapturedMessage> = {}
): MessagingResult {
  if (message.idempotencyKey) {
    const existing = acceptedKeys.get(message.idempotencyKey);
    if (existing) {
      return result({
        accepted: true,
        providerMessageId: existing,
        status: "accepted",
        detail: "duplicate suppressed by idempotency key; no second message was sent",
        retryable: false
      });
    }
  }

  if (message.to === FAKE_INVALID_NUMBER) {
    return result({ detail: "The destination number is not a valid mobile number.", status: "failed", retryable: false });
  }
  if (message.to === FAKE_OPTED_OUT_NUMBER) {
    return result({ detail: "The recipient has opted out of messages from this sender.", status: "failed", retryable: false });
  }
  if (message.to === FAKE_TRANSIENT_FAILURE_NUMBER) {
    return result({ detail: "The provider is rate limiting this sender (429).", status: "failed", retryable: true });
  }

  const providerMessageId = `fake_${channel}_${randomUUID().slice(0, 12)}`;
  if (message.idempotencyKey) acceptedKeys.set(message.idempotencyKey, providerMessageId);
  captured.push({
    channel,
    to: message.to,
    from: message.from,
    body: message.body,
    providerMessageId,
    idempotencyKey: message.idempotencyKey,
    sentAt: new Date(),
    ...extra
  });

  // "accepted", never "delivered": a real provider only knows it took the
  // message. Delivery arrives later, as a receipt.
  return result({
    accepted: true,
    providerMessageId,
    status: "accepted",
    detail: "captured by the development messaging provider; no message was sent",
    retryable: false
  });
}

export class FakeSmsProvider implements SmsProvider {
  readonly name = "fake";
  readonly channel = "sms" as const;
  readonly simulated = true;

  async sendSms(message: OutboundSms): Promise<MessagingResult> {
    return simulate("sms", message);
  }

  async health() {
    return { ok: true, detail: "Development SMS provider — no messages are sent." };
  }
}

export class FakeWhatsAppProvider implements WhatsAppProvider {
  readonly name = "fake";
  readonly channel = "whatsapp" as const;
  readonly simulated = true;

  async sendWhatsAppMessage(message: OutboundWhatsApp): Promise<MessagingResult> {
    if (message.kind === "template") {
      return simulate("whatsapp", message, {
        templateName: message.templateName,
        templateLanguage: message.templateLanguage,
        templateVariables: message.templateVariables
      });
    }
    return simulate("whatsapp", message);
  }

  async health() {
    return { ok: true, detail: "Development WhatsApp provider — no messages are sent." };
  }
}

/* ------------------------------------------------------------------ *
 * Webhooks
 * ------------------------------------------------------------------ */

/**
 * The development webhook adapter still verifies a signature.
 *
 * It would be easy to let this one through unsigned "because it's only the
 * fake" — and then the verification path would be exercised by nothing until
 * a real provider arrived. So it signs with a dev secret and rejects anything
 * that does not match, including a replayed timestamp.
 */
export const FAKE_SIGNATURE_HEADER = "x-veyra-signature";
export const FAKE_TIMESTAMP_HEADER = "x-veyra-timestamp";
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

export function fakeMessagingSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.VEYRA_FAKE_MESSAGING_WEBHOOK_SECRET?.trim() || null;
}

export function signFakeMessagingWebhook(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

interface FakeWebhookPayload {
  eventId: string;
  channel: "sms" | "whatsapp";
  type: "inbound_message" | "delivery_receipt";
  from?: string;
  to?: string;
  text?: string;
  providerMessageId?: string;
  status?: DeliveryReceiptEvent["status"];
  detail?: string;
  occurredAt?: string;
}

export class FakeMessagingWebhookAdapter implements MessagingWebhookAdapter {
  readonly provider = "fake";

  constructor(private readonly secret: string) {}

  async verifyAndParse(request: {
    rawBody: Buffer;
    headers: Record<string, string | string[] | undefined>;
  }): Promise<(InboundMessageEvent | DeliveryReceiptEvent)[] | null> {
    const body = request.rawBody.toString("utf8");
    const header = (name: string) => {
      const value = request.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };

    const signature = header(FAKE_SIGNATURE_HEADER);
    const timestamp = header(FAKE_TIMESTAMP_HEADER);
    if (!signature || !timestamp) return null;

    const age = Date.now() - Number(timestamp);
    if (!Number.isFinite(age) || Math.abs(age) > REPLAY_WINDOW_MS) return null;

    const expected = signFakeMessagingWebhook(this.secret, timestamp, body);
    const given = Buffer.from(signature, "utf8");
    const want = Buffer.from(expected, "utf8");
    if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

    let payload: FakeWebhookPayload;
    try {
      payload = JSON.parse(body) as FakeWebhookPayload;
    } catch {
      return null;
    }

    const occurredAt = payload.occurredAt ? new Date(payload.occurredAt) : new Date();

    if (payload.type === "delivery_receipt") {
      if (!payload.providerMessageId || !payload.status) return null;
      return [
        {
          provider: this.provider,
          channel: payload.channel,
          externalEventId: payload.eventId,
          providerMessageId: payload.providerMessageId,
          status: payload.status,
          detail: payload.detail ?? null,
          occurredAt
        }
      ];
    }

    if (!payload.from || !payload.to) return null;
    return [
      {
        provider: this.provider,
        channel: payload.channel,
        externalEventId: payload.eventId,
        providerMessageId: payload.providerMessageId ?? null,
        from: payload.from,
        to: payload.to,
        text: payload.text ?? "",
        receivedAt: occurredAt
      }
    ];
  }
}
