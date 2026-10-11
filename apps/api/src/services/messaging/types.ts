import type { MessageDeliveryStatus, MessagingChannel } from "@veyra/shared";

/**
 * The messaging provider boundary.
 *
 * SMS and WhatsApp are different products with different rules — a carrier
 * will send any text to any number, while WhatsApp only allows a
 * business-initiated message through an approved template — so they get
 * separate interfaces rather than one lowest-common-denominator `send()`.
 * What they share is the result shape, because the notification worker has to
 * treat every outcome the same way.
 *
 * Nothing vendor-shaped crosses this boundary: no SDK object, no raw payload,
 * no provider status string. Adapters translate, and the domain never learns
 * which vendor answered.
 */

/** A phone number in E.164. The type is a marker; phone.ts does the proving. */
export type E164 = string;

export interface OutboundSms {
  to: E164;
  from: E164;
  body: string;
  /**
   * Stable for the lifetime of one notification — identical on every retry —
   * so a provider that supports idempotency keys can collapse a resend of a
   * message it already accepted.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/**
 * WhatsApp's two shapes, kept explicit so a caller cannot accidentally send
 * free-form text into a conversation that does not allow it.
 *
 *  - "session": the customer messaged first and the window is still open, so
 *    free-form text is permitted;
 *  - "template": business-initiated, which Meta only allows through an
 *    approved template with its variables filled in.
 *
 * The adapter is responsible for the wire format; the caller is responsible
 * for knowing which of the two it is entitled to send.
 */
export type OutboundWhatsApp =
  | {
      kind: "session";
      to: E164;
      from: E164;
      body: string;
      idempotencyKey?: string;
      signal?: AbortSignal;
    }
  | {
      kind: "template";
      to: E164;
      from: E164;
      templateName: string;
      templateLanguage: string;
      /** Positional, in the order the approved template declares them. */
      templateVariables: string[];
      /** What the template renders to, for Veyra's own record and the Console. */
      body: string;
      idempotencyKey?: string;
      signal?: AbortSignal;
    };

/**
 * One normalized outcome for every provider and both channels.
 *
 * `accepted` answers only "did the provider take it?". Whether a handset ever
 * received it is `status`, and later a delivery receipt — conflating the two
 * is how a product ends up claiming deliveries it cannot evidence.
 */
export interface MessagingResult {
  accepted: boolean;
  providerMessageId: string | null;
  status: MessageDeliveryStatus;
  detail: string;
  /**
   * Whether trying again could plausibly work. An invalid number, a rejected
   * template or an opted-out recipient never will, and retrying them just
   * burns the backoff schedule and the provider's goodwill.
   */
  retryable: boolean;
  timestamp: Date;
}

export interface MessagingProviderHealth {
  ok: boolean;
  detail: string;
}

interface BaseMessagingProvider {
  readonly name: string;
  /** True for development stand-ins, so nothing can be reported as live. */
  readonly simulated: boolean;
  health(): Promise<MessagingProviderHealth>;
}

export interface SmsProvider extends BaseMessagingProvider {
  readonly channel: "sms";
  sendSms(message: OutboundSms): Promise<MessagingResult>;
}

export interface WhatsAppProvider extends BaseMessagingProvider {
  readonly channel: "whatsapp";
  sendWhatsAppMessage(message: OutboundWhatsApp): Promise<MessagingResult>;
}

export type MessagingProvider = SmsProvider | WhatsAppProvider;

/* ------------------------------------------------------------------ *
 * Inbound
 * ------------------------------------------------------------------ */

/**
 * A message from a customer, normalized. `to` is what routes it to a
 * business: the number it arrived on. `from` never routes anything — a sender
 * is a claim, not an identity.
 */
export interface InboundMessageEvent {
  provider: string;
  channel: MessagingChannel;
  /** The provider's id for this event, used for webhook idempotency. */
  externalEventId: string;
  /** The provider's id for the message itself, where it differs. */
  providerMessageId: string | null;
  from: E164;
  to: E164;
  /**
   * The provider's own id for the destination, where it has one — Meta's
   * phone_number_id, for instance. Preferred over the number for routing,
   * because it is the identifier the provider actually guarantees.
   */
  toProviderId?: string | null;
  text: string;
  receivedAt: Date;
}

/** A delivery receipt, normalized to Veyra's own status vocabulary. */
export interface DeliveryReceiptEvent {
  provider: string;
  channel: MessagingChannel;
  externalEventId: string;
  providerMessageId: string;
  status: MessageDeliveryStatus;
  detail: string | null;
  occurredAt: Date;
}

/**
 * What an adapter must be able to do with a raw webhook request before Veyra
 * will act on it. Verification is the adapter's job because only it knows the
 * vendor's signing scheme; refusing unverified input is this layer's job.
 */
export interface MessagingWebhookAdapter {
  readonly provider: string;
  /**
   * Throws or returns null when the request is not provably from the
   * provider. Never "assume valid in development" — a webhook that skips
   * verification locally is a webhook nobody verifies in production either.
   */
  verifyAndParse(request: {
    /**
     * The exact bytes received. A signature is over bytes, not over
     * re-serialised JSON, so this is deliberately not a parsed object and
     * deliberately not a string.
     */
    rawBody: Buffer;
    headers: Record<string, string | string[] | undefined>;
  }): Promise<(InboundMessageEvent | DeliveryReceiptEvent)[] | null>;
}

export function isDeliveryReceipt(
  event: InboundMessageEvent | DeliveryReceiptEvent
): event is DeliveryReceiptEvent {
  return "status" in event;
}
