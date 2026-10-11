import { createHmac, timingSafeEqual } from "node:crypto";
import type { MessageDeliveryStatus } from "@veyra/shared";
import type {
  DeliveryReceiptEvent,
  InboundMessageEvent,
  MessagingWebhookAdapter
} from "../types.js";

/**
 * Meta's WhatsApp webhook: verification, and the one place Graph payloads
 * are understood.
 *
 * Everything Meta-shaped stops here. The domain receives Veyra's own
 * InboundMessageEvent and DeliveryReceiptEvent, so nothing downstream has to
 * know that a status arrives in `entry[].changes[].value.statuses[]` or that
 * Meta writes phone numbers without a leading plus.
 *
 * Two rules the rest of the system depends on:
 *   - a request whose signature does not verify produces no events at all,
 *     so a forged payload cannot create a conversation or a contact;
 *   - every event carries a deterministic id derived from Meta's own
 *     identifiers, never from arrival time, so a redelivery is recognisable
 *     as the same event.
 */

export const META_SIGNATURE_HEADER = "x-hub-signature-256";

export interface MetaWebhookConfig {
  /** The Meta app secret. Signs every POST; never logged. */
  appSecret: string;
  /** Shared string Meta echoes back when verifying the subscription. */
  verifyToken: string;
}

export function missingMetaWebhookConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  const missing: string[] = [];
  if (!env.META_APP_SECRET?.trim()) missing.push("META_APP_SECRET");
  if (!env.META_WHATSAPP_VERIFY_TOKEN?.trim()) missing.push("META_WHATSAPP_VERIFY_TOKEN");
  return missing;
}

export function metaWebhookConfig(env: NodeJS.ProcessEnv = process.env): MetaWebhookConfig | null {
  if (missingMetaWebhookConfig(env).length > 0) return null;
  return {
    appSecret: env.META_APP_SECRET!.trim(),
    verifyToken: env.META_WHATSAPP_VERIFY_TOKEN!.trim()
  };
}

/**
 * The GET handshake Meta performs when a callback URL is saved.
 *
 * Compared in constant time, and the token never appears in the result or in
 * any log line — a verify token that leaks lets someone else claim the
 * subscription.
 */
export function answerVerificationChallenge(
  query: Record<string, unknown>,
  config: MetaWebhookConfig
):
  | { ok: true; challenge: string }
  | {
      ok: false;
      reason: string;
      /**
       * Enough to diagnose a mismatch without revealing either token. A
       * failed handshake is otherwise unexplainable from the outside — the
       * usual cause is that the value in the dashboard and the value in .env
       * are not the same, or that the process was started before .env was
       * last edited, and lengths alone usually settle which.
       */
      diagnostic: string;
    } {
  // Meta's parameter names contain dots. Express's query parser leaves them
  // as literal keys (qs only splits on dots when allowDots is enabled, which
  // it is not), so these are read exactly as Meta sends them.
  const mode = String(query["hub.mode"] ?? "");
  const rawToken = query["hub.verify_token"];
  const token = String(rawToken ?? "");
  const challenge = String(query["hub.challenge"] ?? "");

  const diagnostic =
    `mode=${mode || "(absent)"} ` +
    `token received=${rawToken === undefined ? "no" : "yes"} ` +
    `received length=${token.length} configured length=${config.verifyToken.length} ` +
    `lengths match=${token.length === config.verifyToken.length} ` +
    `challenge present=${challenge ? "yes" : "no"}`;

  if (mode !== "subscribe") {
    return { ok: false, reason: 'hub.mode was not "subscribe".', diagnostic };
  }
  if (!challenge) return { ok: false, reason: "No hub.challenge was supplied.", diagnostic };

  const given = Buffer.from(token, "utf8");
  const expected = Buffer.from(config.verifyToken, "utf8");
  // Length is checked first because timingSafeEqual throws on a mismatch;
  // the length itself is already in the diagnostic.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return {
      ok: false,
      reason:
        token.length === config.verifyToken.length
          ? "The verify token is the right length but does not match."
          : "The verify token did not match, and is a different length from the configured one.",
      diagnostic
    };
  }
  return { ok: true, challenge };
}

/* ------------------------------------------------------------------ *
 * Graph payload shapes — confined to this file
 * ------------------------------------------------------------------ */

interface GraphTextMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
}

interface GraphStatus {
  id?: string;
  status?: string;
  timestamp?: string;
  recipient_id?: string;
  errors?: { code?: number; title?: string; message?: string; error_data?: { details?: string } }[];
}

interface GraphValue {
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  messages?: GraphTextMessage[];
  statuses?: GraphStatus[];
}

interface GraphPayload {
  object?: string;
  entry?: { id?: string; changes?: { field?: string; value?: GraphValue }[] }[];
}

/**
 * Meta's delivery vocabulary, mapped to Veyra's.
 *
 * "read" becomes "delivered": a message that was read was certainly
 * delivered, and Veyra has no separate read state to record. That is a
 * deliberate downgrade to something true, not an upgrade to something
 * flattering.
 */
function mapStatus(status: string | undefined): MessageDeliveryStatus | null {
  switch (status) {
    case "sent":
      return "sent";
    case "delivered":
    case "read":
      return "delivered";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

/** Meta writes numbers without a plus; Veyra stores E.164 everywhere. */
function toE164Loose(value: string | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/[^\d]/g, "");
  return digits ? `+${digits}` : null;
}

function secondsToDate(timestamp: string | undefined): Date {
  const seconds = Number(timestamp);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
}

/** Bounded, and never the provider's raw payload. */
function failureDetail(status: GraphStatus): string | null {
  const error = status.errors?.[0];
  if (!error) return null;
  const parts = [error.title, error.error_data?.details ?? error.message].filter(Boolean);
  return (parts.join(" — ") || `Meta error ${error.code ?? "unknown"}`).slice(0, 240);
}

export class MetaWhatsAppWebhookAdapter implements MessagingWebhookAdapter {
  readonly provider = "meta";

  constructor(private readonly config: MetaWebhookConfig) {}

  /**
   * HMAC-SHA256 over the exact bytes received, compared in constant time.
   * Re-serialising the JSON first would change whitespace and key order and
   * break every signature — which is why the raw Buffer travels this far.
   */
  private signatureMatches(rawBody: Buffer, header: string | undefined): boolean {
    if (!header?.startsWith("sha256=")) return false;
    const given = Buffer.from(header.slice("sha256=".length).trim(), "hex");
    const expected = createHmac("sha256", this.config.appSecret).update(rawBody).digest();
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  async verifyAndParse(request: {
    rawBody: Buffer;
    headers: Record<string, string | string[] | undefined>;
  }): Promise<(InboundMessageEvent | DeliveryReceiptEvent)[] | null> {
    const raw = request.headers[META_SIGNATURE_HEADER];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (!this.signatureMatches(request.rawBody, header)) return null;

    let payload: GraphPayload;
    try {
      payload = JSON.parse(request.rawBody.toString("utf8")) as GraphPayload;
    } catch {
      return null;
    }

    const events: (InboundMessageEvent | DeliveryReceiptEvent)[] = [];

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "messages") continue;
        const value = change.value ?? {};
        const to = toE164Loose(value.metadata?.display_phone_number);
        const toProviderId = value.metadata?.phone_number_id ?? null;

        for (const message of value.messages ?? []) {
          // Only text for now. An image or a location is a real message, but
          // Reception has nothing to do with one yet, and inventing a
          // transcription would put words in the customer's mouth.
          if (message.type !== "text") continue;
          const from = toE164Loose(message.from);
          if (!from || !to || !message.id) continue;

          events.push({
            provider: this.provider,
            channel: "whatsapp",
            // Meta's own message id: stable across a redelivery.
            externalEventId: message.id,
            providerMessageId: message.id,
            from,
            to,
            toProviderId,
            text: message.text?.body ?? "",
            receivedAt: secondsToDate(message.timestamp)
          });
        }

        for (const status of value.statuses ?? []) {
          const mapped = mapStatus(status.status);
          if (!mapped || !status.id) continue;

          events.push({
            provider: this.provider,
            channel: "whatsapp",
            // One wamid produces several status events, so the status is part
            // of the identity. Never the timestamp: Meta resends with the
            // same one, and two different clocks would defeat the claim.
            externalEventId: `${status.id}:${status.status}`,
            providerMessageId: status.id,
            status: mapped,
            detail: failureDetail(status),
            occurredAt: secondsToDate(status.timestamp)
          });
        }
      }
    }

    return events;
  }
}
