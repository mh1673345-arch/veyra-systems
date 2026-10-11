import type { DomainEventType } from "@veyra/shared";
import { prisma } from "../../db/client.js";
import { queueCustomerMessage } from "../messaging/outbound.js";
import { resolveConfirmationDestinations } from "./destinations.js";

/**
 * Telling a customer about their own booking.
 *
 * The destination is resolved through the contact layer rather than by each
 * caller reaching for whichever field it happens to know about — that is the
 * whole point of this phase. What a caller gets back is an honest account of
 * what happened, including the case that matters most: there was nowhere to
 * send it.
 *
 * "No destination" is a real, common outcome — a web booking from someone who
 * gave no contact details, a customer who opted out — and it is reported as
 * such. Nothing is faked, and nothing is queued that would fail later.
 */

export type ConfirmationOutcome =
  | { sent: true; channel: "sms" | "whatsapp" | "email"; notificationId: string; to: string }
  | { sent: false; reason: string; blocked: { channel: string; reason: string }[] };

export async function sendBookingConfirmation(params: {
  businessId: string;
  conversationId: string;
  appointmentId: string;
  subject: string;
  body: string;
  type?: DomainEventType;
}): Promise<ConfirmationOutcome> {
  const { available, blocked } = await resolveConfirmationDestinations({
    businessId: params.businessId,
    conversationId: params.conversationId
  });

  if (available.length === 0) {
    return {
      sent: false,
      reason:
        blocked.length > 0
          ? "No usable way to reach this customer."
          : "This customer has no contact details on file.",
      blocked
    };
  }

  // The first available destination is the one the resolver ranked highest
  // for this conversation's context; it is not a global preference.
  const destination = available[0];
  const conversation = await prisma.conversation.findFirstOrThrow({
    where: { id: params.conversationId, businessId: params.businessId },
    include: { customerContact: true }
  });

  if (destination.channel === "email") {
    const email = conversation.customerContact?.email;
    if (!email) {
      return { sent: false, reason: "The email destination disappeared before sending.", blocked };
    }
    const notificationId = await queueCustomerEmail({
      businessId: params.businessId,
      email,
      subject: params.subject,
      body: params.body,
      appointmentId: params.appointmentId,
      type: params.type ?? "messaging.customer_notified"
    });
    return { sent: true, channel: "email", notificationId, to: destination.to };
  }

  const phone = conversation.customerContact?.phoneE164 ?? conversation.customerRef;
  if (!phone) {
    return { sent: false, reason: "The phone destination disappeared before sending.", blocked };
  }

  const { notificationId } = await queueCustomerMessage({
    businessId: params.businessId,
    channel: destination.channel,
    type: params.type ?? "messaging.customer_notified",
    toPhone: phone,
    subject: params.subject,
    body: params.body,
    linkEntity: "booking",
    linkEntityId: params.appointmentId
  });

  return { sent: true, channel: destination.channel, notificationId, to: destination.to };
}

/**
 * A customer-facing email, which is a different recipient type from the
 * operator alerts that already exist: it goes to someone who is not a member
 * of the workspace, so it uses recipientEmail and no member fan-out.
 */
async function queueCustomerEmail(params: {
  businessId: string;
  email: string;
  subject: string;
  body: string;
  appointmentId: string;
  type: DomainEventType;
}): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const event = await tx.domainEvent.create({
      data: {
        businessId: params.businessId,
        type: params.type,
        entityType: "system",
        entityId: params.appointmentId,
        payload: JSON.stringify({}),
        processedAt: new Date()
      }
    });
    const notification = await tx.notification.create({
      data: {
        businessId: params.businessId,
        userId: null,
        recipientEmail: params.email,
        eventId: event.id,
        channel: "email",
        subject: params.subject,
        body: params.body,
        linkEntity: "booking",
        linkEntityId: params.appointmentId,
        nextAttemptAt: new Date()
      }
    });
    return notification.id;
  });
}
