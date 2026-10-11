import type { ConfirmationDestination, ConversationChannel } from "@veyra/shared";
import { prisma } from "../../db/client.js";
import { maskPhone } from "../messaging/phone.js";
import { messagingPreflight } from "../messaging/outbound.js";
import { hasEntitlement } from "../access/accessService.js";

/**
 * Where a confirmation for this booking can actually go.
 *
 * There is no global priority list. The order comes from context — the
 * channel the customer used to reach this business comes first, because
 * answering someone where they spoke to you is what a person would do. Only
 * then does anything else get considered.
 *
 * Every candidate is run through the same gates a real send would hit
 * (entitlement, business switch, consent, session window), so a destination
 * that appears here is one Veyra may genuinely use. A destination that is
 * blocked is reported with the reason instead of silently disappearing —
 * "we could not tell them" is information an operator needs.
 */

export interface DestinationResolution {
  available: ConfirmationDestination[];
  /** Why a plausible destination cannot be used. Safe to show an operator. */
  blocked: { channel: "sms" | "whatsapp" | "email"; reason: string }[];
  /**
   * The channel this business would have used first, whether or not it
   * turned out to be usable. A caller that has not been told it may fall
   * back needs to know the difference between "the preferred channel worked"
   * and "a different one did".
   */
  preferred: "sms" | "whatsapp" | "email";
}

export type TransactionalPreference = "origin_channel" | "whatsapp" | "sms" | "email" | "automatic";

type Candidate = "whatsapp" | "sms" | "email";

/**
 * The order channels are considered in. There is no universal priority: the
 * business says what it prefers, and "origin_channel" — the default — means
 * answering someone where they spoke to you, which is what a person would do.
 *
 * A preference only moves a channel to the front. It never forces one: an
 * unusable channel is skipped, because a business preferring WhatsApp does
 * not make WhatsApp work for a customer who has never messaged them.
 */
function candidateOrder(origin: ConversationChannel, preference: TransactionalPreference): Candidate[] {
  const byOrigin: Candidate[] =
    origin === "whatsapp"
      ? ["whatsapp", "sms", "email"]
      : origin === "sms"
        ? ["sms", "whatsapp", "email"]
        : // Web and voice have no messaging channel of their own, so this is
          // simply whatever the customer gave, cheapest to reach first.
          ["sms", "email", "whatsapp"];

  if (preference === "origin_channel" || preference === "automatic") return byOrigin;

  // An explicit preference goes first; the rest keep their contextual order
  // so a fallback is still sensible.
  return [preference, ...byOrigin.filter((channel) => channel !== preference)];
}

export async function resolveConfirmationDestinations(params: {
  businessId: string;
  /** The conversation the booking came from, for its channel and contact. */
  conversationId: string;
}): Promise<DestinationResolution> {
  const [conversation, settings] = await Promise.all([
    prisma.conversation.findFirst({
      where: { id: params.conversationId, businessId: params.businessId },
      include: { customerContact: true }
    }),
    prisma.messagingSettings.findUnique({
      where: { businessId: params.businessId },
      select: { transactionalChannelPreference: true }
    })
  ]);

  const available: ConfirmationDestination[] = [];
  const blocked: DestinationResolution["blocked"] = [];
  if (!conversation) return { available, blocked, preferred: "sms" };

  const contact = conversation.customerContact;
  const origin = conversation.channel as ConversationChannel;
  const preference = (settings?.transactionalChannelPreference ?? "origin_channel") as TransactionalPreference;

  // The number the customer messaged from is usable even before a contact
  // record exists — the provider delivered it, which is the same evidence a
  // contact would carry.
  const channelPhone = origin === "sms" || origin === "whatsapp" ? conversation.customerRef : null;
  const phone = contact?.phoneE164 ?? channelPhone;
  const email = contact?.email ?? null;

  const order = candidateOrder(origin, preference);

  for (const channel of order) {
    if (channel === "email") {
      if (!email) continue;
      if (contact && !contact.emailTransactionalAllowed) {
        blocked.push({ channel, reason: "This customer has asked not to be emailed." });
        continue;
      }
      if (!(await hasEntitlement(params.businessId, "email_notifications"))) {
        blocked.push({ channel, reason: "Email is not included in this plan." });
        continue;
      }
      available.push({
        channel,
        to: maskEmail(email),
        reason: "The customer gave this address."
      });
      continue;
    }

    if (!phone) continue;

    // Exactly the checks a send would make, so nothing is offered that would
    // then be refused.
    const preflight = await messagingPreflight({
      businessId: params.businessId,
      channel,
      toPhone: phone,
      transactional: true
    });
    if (!preflight.allowed) {
      blocked.push({ channel, reason: preflight.reason });
      continue;
    }

    // Outside the WhatsApp session window an approved template is the only
    // way through, so offering the channel without one would be offering a
    // send that is certain to be refused.
    if (preflight.send?.mode === "template") {
      const approved = await prisma.messageTemplate.count({
        where: { businessId: params.businessId, channel: "whatsapp", status: "approved" }
      });
      if (approved === 0) {
        blocked.push({
          channel,
          reason: "WhatsApp needs an approved template to start a conversation, and none is registered."
        });
        continue;
      }
    }
    available.push({
      channel,
      to: maskPhone(phone) ?? "•••",
      reason:
        channel === origin
          ? "The customer contacted this business on this channel."
          : "The customer gave this number."
    });
  }

  return { available, blocked, preferred: order[0] };
}

/** Keeps the first character and the domain: enough to recognise, not to use. */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return "•••";
  const [local, domain] = email.split("@");
  if (!domain) return "•••";
  return `${local.slice(0, 1)}•••@${domain}`;
}
