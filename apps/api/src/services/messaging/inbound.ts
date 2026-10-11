import type { MessageDeliveryStatus, MessagingChannel } from "@veyra/shared";
import { prisma } from "../../db/client.js";
import { handleReceptionTurn } from "../reception/turn.js";
import { hasEntitlement } from "../access/accessService.js";
import { isStartKeyword, isStopKeyword, recordConsent } from "./consent.js";
import { formatForChannel } from "./format.js";
import { isE164, maskPhone } from "./phone.js";
import { queueCustomerMessage } from "./outbound.js";
import { linkContact, resolveOrCreateContact } from "../contacts/contactService.js";
import type { DeliveryReceiptEvent, InboundMessageEvent } from "./types.js";

/**
 * Inbound messaging.
 *
 * A message from a customer becomes a Conversation turn and nothing more
 * exotic than that. It reaches the same handleReceptionTurn as the web chat
 * and the phone line, so a customer asking a price on WhatsApp gets the same
 * grounded answer, from the same business information, through the same
 * action boundary. There is no messaging chatbot; there is one Reception
 * brain with another door into it.
 *
 * Routing is by the number the message arrived ON. The sender is never used
 * to pick a tenant: a sender is a claim, and routing on it would let anyone
 * reach any business from the right handset.
 */

export type InboundOutcome =
  | { outcome: "processed"; conversationId: string; replyQueued: boolean; detail: string }
  | { outcome: "ignored"; detail: string };

/** Resolves the business that owns the number a message arrived on. */
export async function routeInbound(params: {
  provider: string;
  channel: MessagingChannel;
  to: string;
  /** The provider's own id for the destination, where it supplies one. */
  toProviderId?: string | null;
}): Promise<{ businessId: string } | null> {
  // When the provider names the destination itself, that is the identifier
  // to trust — and an id Veyra does not recognise is a miss, not a reason to
  // fall back to matching on a display number. Falling back is how an
  // unmapped sender quietly lands in somebody else's inbox.
  if (params.toProviderId) {
    const byProviderId = await prisma.messagingNumber.findFirst({
      where: {
        channel: params.channel,
        provider: params.provider,
        providerNumberId: params.toProviderId
      },
      select: { businessId: true }
    });
    return byProviderId ?? null;
  }

  if (!isE164(params.to)) return null;
  const mapping = await prisma.messagingNumber.findUnique({
    where: {
      channel_provider_phoneE164: {
        channel: params.channel,
        provider: params.provider,
        phoneE164: params.to
      }
    },
    select: { businessId: true }
  });
  return mapping ? { businessId: mapping.businessId } : null;
}

/**
 * Finds the open conversation for this customer on this channel, or starts
 * one. Threading is per business, channel and number, so the same person
 * texting two businesses gets two conversations, and the Reception brain
 * reads one continuous history for each.
 */
async function conversationFor(params: {
  businessId: string;
  channel: MessagingChannel;
  customerRef: string;
}): Promise<{ id: string }> {
  const existing = await prisma.conversation.findFirst({
    where: {
      businessId: params.businessId,
      channel: params.channel,
      customerRef: params.customerRef,
      status: "open"
    },
    orderBy: { createdAt: "desc" },
    select: { id: true }
  });
  if (existing) return existing;

  return prisma.conversation.create({
    data: {
      businessId: params.businessId,
      channel: params.channel,
      customerRef: params.customerRef,
      // No name is known from a phone number, and inventing one would put a
      // guess in front of an operator as though it were a fact.
      callerName: null
    },
    select: { id: true }
  });
}

export async function handleInboundMessage(event: InboundMessageEvent): Promise<InboundOutcome> {
  const routed = await routeInbound({
    provider: event.provider,
    channel: event.channel,
    to: event.to,
    toProviderId: event.toProviderId ?? null
  });
  if (!routed) {
    // Nothing is created for an unrecognised number: an unrouted message must
    // not be able to conjure tenant data.
    return { outcome: "ignored", detail: "No business is mapped to that number." };
  }
  if (!isE164(event.from)) {
    return { outcome: "ignored", detail: "The sender is not a usable phone number." };
  }

  const entitlement = event.channel === "sms" ? "sms" : "whatsapp";
  if (!(await hasEntitlement(routed.businessId, entitlement))) {
    return { outcome: "ignored", detail: `${event.channel} is not included in this business's plan.` };
  }

  const settings = await prisma.messagingSettings.findUnique({ where: { businessId: routed.businessId } });
  const enabled = event.channel === "sms" ? settings?.smsEnabled : settings?.whatsappEnabled;
  if (!enabled) {
    return { outcome: "ignored", detail: `${event.channel} is switched off for this business.` };
  }

  // Opt-out and opt-in are honoured before anything else looks at the text:
  // a customer texting STOP is not asking Reception a question.
  if (isStopKeyword(event.text)) {
    await recordConsent({
      businessId: routed.businessId,
      channel: event.channel,
      phone: event.from,
      state: "revoked",
      source: "stop_keyword"
    });
    return { outcome: "processed", conversationId: "", replyQueued: false, detail: "Opt-out recorded." };
  }
  if (isStartKeyword(event.text)) {
    await recordConsent({
      businessId: routed.businessId,
      channel: event.channel,
      phone: event.from,
      state: "granted",
      source: "inbound_message"
    });
  } else {
    // Messaging Veyra first opens the door for a reply, and that is the only
    // thing it grants — never marketing, which needs explicit consent.
    const existing = await prisma.messagingConsent.findUnique({
      where: {
        businessId_channel_phoneE164: {
          businessId: routed.businessId,
          channel: event.channel,
          phoneE164: event.from
        }
      }
    });
    if (!existing) {
      await recordConsent({
        businessId: routed.businessId,
        channel: event.channel,
        phone: event.from,
        state: "unknown",
        source: "inbound_message"
      });
    }
  }

  const conversation = await conversationFor({
    businessId: routed.businessId,
    channel: event.channel,
    customerRef: event.from
  });

  // The provider delivered this message from this number, which is stronger
  // evidence than anyone typing it — but it is still only control of the
  // channel, not proof of who the person is, so it stops at
  // "channel_confirmed" and never reaches "verified".
  try {
    const { contact } = await resolveOrCreateContact({
      businessId: routed.businessId,
      phone: event.from,
      source: event.channel,
      phoneState: "channel_confirmed"
    });
    if (conversation.id) {
      await linkContact({ contactId: contact.id, conversationId: conversation.id });
    }
  } catch (error) {
    // Identity is a convenience here; failing to resolve it must never cost
    // the customer their answer.
    console.error(
      "[veyra:messaging] could not resolve a contact for an inbound message:",
      error instanceof Error ? error.message : error
    );
  }

  const turn = await handleReceptionTurn({
    conversationId: conversation.id,
    callerText: event.text
  });

  if (turn.status !== "answered") {
    return {
      outcome: "processed",
      conversationId: conversation.id,
      replyQueued: false,
      detail: "Reception is not active for this business; no reply was sent."
    };
  }

  // The reply goes out as a normal Notification, so it inherits the worker,
  // the retry schedule and the same consent re-check as any other message.
  const { notificationId } = await queueCustomerMessage({
    businessId: routed.businessId,
    channel: event.channel,
    type: "messaging.reply",
    toPhone: event.from,
    subject: "reception_reply",
    body: formatForChannel(event.channel, turn.receptionistMessage.text),
    linkEntity: null,
    linkEntityId: null
  });

  return {
    outcome: "processed",
    conversationId: conversation.id,
    replyQueued: Boolean(notificationId),
    detail: `Reply queued for ${maskPhone(event.from)}.`
  };
}

/* ------------------------------------------------------------------ *
 * Delivery receipts
 * ------------------------------------------------------------------ */

/** Later states never move backwards; a late "sent" cannot undo a "delivered". */
const STATUS_RANK: Record<MessageDeliveryStatus, number> = {
  queued: 0,
  accepted: 1,
  sent: 2,
  delivered: 3,
  undelivered: 3,
  failed: 3
};

export async function handleDeliveryReceipt(
  event: DeliveryReceiptEvent
): Promise<{ outcome: "processed" | "ignored"; detail: string; notificationId?: string }> {
  // Matched on the provider as well as the id: message ids are only unique
  // within a vendor, so without this a receipt from one provider could
  // update a message another one sent.
  const notification = await prisma.notification.findFirst({
    where: {
      providerMessageId: event.providerMessageId,
      channel: event.channel,
      providerName: event.provider
    },
    select: { id: true, businessId: true, deliveryStatus: true }
  });

  if (!notification) {
    // An unknown id is not an error worth alarming anyone about, but it must
    // never cause a row to be created or guessed at.
    return { outcome: "ignored", detail: "No message matches that provider id." };
  }

  const current = (notification.deliveryStatus as MessageDeliveryStatus | null) ?? "queued";
  if (STATUS_RANK[event.status] < STATUS_RANK[current]) {
    return {
      outcome: "ignored",
      detail: `Receipt "${event.status}" is older than the recorded "${current}".`,
      notificationId: notification.id
    };
  }

  await prisma.notification.update({
    where: { id: notification.id },
    data: {
      deliveryStatus: event.status,
      deliveryDetail: event.detail,
      deliveryUpdatedAt: event.occurredAt
    }
  });

  return { outcome: "processed", detail: `Delivery status is now ${event.status}.`, notificationId: notification.id };
}
