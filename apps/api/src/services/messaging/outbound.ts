import type { DomainEventType, MessagingChannel } from "@veyra/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { hasEntitlement } from "../access/accessService.js";
import { canSendToCustomer } from "./consent.js";
import { formatForChannel } from "./format.js";
import { InvalidPhoneNumberError, toE164 } from "./phone.js";
import { outboundModeFor } from "./templates.js";

/**
 * Creating an outbound customer message.
 *
 * There is no separate messaging pipeline. A message is a Notification on an
 * sms or whatsapp channel, so it inherits the worker, the claim lease, the
 * retry schedule, the idempotency key and the audit trail that email already
 * uses. The only thing this file adds is the set of questions that have to be
 * answered before a message may exist at all.
 *
 * Those questions, in order, and none of them skippable:
 *   1. does the plan include this channel?        (AccessService)
 *   2. has the business switched it on?           (MessagingSettings)
 *   3. is customer messaging on, not just team?   (MessagingSettings)
 *   4. is the number real and unambiguous?        (phone.ts)
 *   5. has the customer opted out?                (consent.ts)
 *   6. is free-form allowed, or is a template needed?  (templates.ts)
 *
 * A business setting can never answer question 1. That ordering is the whole
 * point: configuration cannot buy an entitlement.
 */

export type MessagingBlockReason =
  | "not_entitled"
  | "channel_disabled"
  | "customer_messaging_disabled"
  | "no_sender"
  | "invalid_number"
  | "opted_out"
  | "consent_required"
  | "template_required";

export interface MessagingPreflight {
  allowed: boolean;
  reason: string;
  code: MessagingBlockReason | null;
  /** Present only when allowed. */
  send: {
    channel: MessagingChannel;
    provider: string;
    sender: string;
    to: string;
    /** "session" means free-form is permitted; "template" means it is not. */
    mode: "session" | "template";
  } | null;
}

function blocked(code: MessagingBlockReason, reason: string): MessagingPreflight {
  return { allowed: false, reason, code, send: null };
}

/**
 * Everything that must be true before Veyra may message a customer.
 *
 * Returns a reason rather than throwing, because most callers are event
 * handlers that must not fail the business action that triggered them — a
 * booking is still a booking if the confirmation text cannot be sent.
 */
export async function messagingPreflight(params: {
  businessId: string;
  channel: MessagingChannel;
  toPhone: string;
  /** A direct reply to something the customer did, as opposed to outreach. */
  transactional: boolean;
}): Promise<MessagingPreflight> {
  const entitlement = params.channel === "sms" ? "sms" : "whatsapp";
  if (!(await hasEntitlement(params.businessId, entitlement))) {
    return blocked(
      "not_entitled",
      `${label(params.channel)} is not included in this plan.`
    );
  }

  const settings = await prisma.messagingSettings.findUnique({ where: { businessId: params.businessId } });
  const enabled = params.channel === "sms" ? settings?.smsEnabled : settings?.whatsappEnabled;
  if (!settings || !enabled) {
    return blocked("channel_disabled", `${label(params.channel)} is switched off for this business.`);
  }
  if (!settings.customerMessagingEnabled) {
    return blocked(
      "customer_messaging_disabled",
      "Messaging customers is switched off for this business; only the team is messaged."
    );
  }

  const provider = params.channel === "sms" ? settings.smsProvider : settings.whatsappProvider;
  const sender = params.channel === "sms" ? settings.smsSender : settings.whatsappSender;
  if (!provider || !sender) {
    return blocked("no_sender", `No ${label(params.channel)} sender is configured for this business.`);
  }

  let to: string;
  try {
    to = toE164(params.toPhone, { defaultCountry: settings.defaultCountry });
  } catch (error) {
    return blocked(
      "invalid_number",
      error instanceof InvalidPhoneNumberError ? error.message : "That is not a usable phone number."
    );
  }

  const permission = await canSendToCustomer({
    businessId: params.businessId,
    channel: params.channel,
    phone: to,
    transactional: params.transactional
  });
  if (!permission.allowed) {
    return blocked(permission.consent === "revoked" ? "opted_out" : "consent_required", permission.reason);
  }

  const mode = await outboundModeFor({
    businessId: params.businessId,
    channel: params.channel,
    customerRef: to
  });
  if (mode.mode === "blocked") return blocked("template_required", mode.reason);

  return {
    allowed: true,
    reason: mode.reason,
    code: null,
    send: { channel: params.channel, provider, sender, to, mode: mode.mode }
  };
}

export interface QueuedMessage {
  eventId: string;
  notificationId: string;
}

/**
 * Records a message as a pending Notification. It is not sent here: the
 * worker owns delivery, so a provider outage can never roll back the booking
 * that prompted the message.
 *
 * The caller must have run messagingPreflight and be acting on its answer.
 * The database still has the last word — the CHECK constraint refuses a
 * phone-channel row with no number.
 */
export async function queueCustomerMessage(params: {
  businessId: string;
  channel: MessagingChannel;
  type: DomainEventType;
  toPhone: string;
  subject: string;
  body: string;
  linkEntity?: "booking" | "escalation" | null;
  linkEntityId?: string | null;
  /** Reuse an existing event instead of raising one, for fan-out. */
  eventId?: string;
  tx?: Prisma.TransactionClient;
}): Promise<QueuedMessage> {
  const to = toE164(params.toPhone);
  const body = formatForChannel(params.channel, params.body);

  const run = async (tx: Prisma.TransactionClient): Promise<QueuedMessage> => {
    const eventId =
      params.eventId ??
      (
        await tx.domainEvent.create({
          data: {
            businessId: params.businessId,
            type: params.type,
            entityType: "system",
            entityId: params.linkEntityId ?? params.businessId,
            payload: JSON.stringify({}),
            processedAt: new Date()
          }
        })
      ).id;

    const notification = await tx.notification.create({
      data: {
        businessId: params.businessId,
        userId: null,
        recipientPhone: to,
        eventId,
        channel: params.channel,
        subject: params.subject,
        body,
        linkEntity: params.linkEntity ?? null,
        linkEntityId: params.linkEntityId ?? null,
        nextAttemptAt: new Date()
      }
    });

    return { eventId, notificationId: notification.id };
  };

  // An existing transaction is joined rather than nested: the caller may be
  // mid-way through recording the thing this message is about.
  return params.tx ? run(params.tx) : prisma.$transaction(run);
}

function label(channel: MessagingChannel): string {
  return channel === "sms" ? "SMS" : "WhatsApp";
}
