import type { ConsentState, MessagingChannel } from "@veyra/shared";
import { prisma } from "../../db/client.js";
import { toE164 } from "./phone.js";

/**
 * Messaging consent.
 *
 * Two rules do the real work here:
 *
 *  - a number existing in Veyra is not consent. Someone leaving a callback
 *    number so a human can ring them has not agreed to automated messages, so
 *    the default state is "unknown" and there is no code path that infers
 *    "granted" from the presence of a row;
 *  - SMS consent is not WhatsApp consent. They are separate rows keyed by
 *    channel, because they are separate permissions under separate rules, and
 *    a customer who texts a shop has not invited it onto WhatsApp.
 *
 * Transactional replies to a conversation the customer started are handled by
 * the session window, not by this table — see canSendToCustomer.
 */

/** Words a customer can send to stop messages. Matched on the whole message. */
const STOP_KEYWORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "optout", "opt-out"]);
const START_KEYWORDS = new Set(["start", "unstop", "resume", "subscribe", "optin", "opt-in"]);

export function isStopKeyword(text: string): boolean {
  return STOP_KEYWORDS.has(text.trim().toLowerCase().replace(/[.!]$/, ""));
}

export function isStartKeyword(text: string): boolean {
  return START_KEYWORDS.has(text.trim().toLowerCase().replace(/[.!]$/, ""));
}

export async function consentStateFor(params: {
  businessId: string;
  channel: MessagingChannel;
  phone: string;
}): Promise<ConsentState> {
  const phoneE164 = toE164(params.phone);
  const row = await prisma.messagingConsent.findUnique({
    where: {
      businessId_channel_phoneE164: {
        businessId: params.businessId,
        channel: params.channel,
        phoneE164
      }
    }
  });
  return (row?.state as ConsentState | undefined) ?? "unknown";
}

export async function recordConsent(params: {
  businessId: string;
  channel: MessagingChannel;
  phone: string;
  state: ConsentState;
  source: "inbound_message" | "operator" | "stop_keyword" | "import";
}): Promise<void> {
  const phoneE164 = toE164(params.phone);
  await prisma.messagingConsent.upsert({
    where: {
      businessId_channel_phoneE164: {
        businessId: params.businessId,
        channel: params.channel,
        phoneE164
      }
    },
    create: {
      businessId: params.businessId,
      channel: params.channel,
      phoneE164,
      state: params.state,
      source: params.source
    },
    update: { state: params.state, source: params.source }
  });
}

export interface SendPermission {
  allowed: boolean;
  /** Safe to show an operator and to store as a failure reason. */
  reason: string;
  consent: ConsentState;
}

/**
 * Whether Veyra may message this customer right now.
 *
 * "revoked" is absolute: an explicit opt-out stops everything on that
 * channel, including transactional messages, because a customer who said stop
 * did not carve out exceptions. "unknown" still allows a transactional
 * message — a booking they just made, confirmed back to them — but never
 * anything else, which is the line this phase stays on.
 */
export async function canSendToCustomer(params: {
  businessId: string;
  channel: MessagingChannel;
  phone: string;
  transactional: boolean;
}): Promise<SendPermission> {
  const consent = await consentStateFor(params);

  if (consent === "revoked") {
    return {
      allowed: false,
      reason: "The recipient has opted out of messages on this channel.",
      consent
    };
  }
  if (consent === "granted") return { allowed: true, reason: "Consent granted.", consent };

  return params.transactional
    ? { allowed: true, reason: "Transactional message to a customer who has not opted out.", consent }
    : {
        allowed: false,
        reason: "This recipient has not opted in, and only transactional messages are allowed without consent.",
        consent
      };
}
