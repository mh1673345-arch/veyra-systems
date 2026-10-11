import { z } from "zod";
import type { DomainEventType, MembershipRole } from "@veyra/shared";
import { prisma } from "../../db/client.js";
import { hasEntitlement } from "../access/accessService.js";
import {
  bookingTransitionFor,
  confirmBookingTransition
} from "../contacts/bookingConfirmations.js";

/**
 * The domain event layer.
 *
 * Events are emitted by the application layer *after* a mutation has already
 * succeeded, and recorded in the same database. Nothing here is called from the
 * AI responder: the boundary is
 *   AI → validated action → database mutation → domain event → notifications.
 *
 * Emitting must never undo the business action that caused it, so every entry
 * point swallows its own errors and logs instead of throwing.
 */

export interface EmitEventParams {
  businessId: string;
  type: DomainEventType;
  entityType: "booking" | "escalation" | "system";
  entityId: string;
  /** Small, safe metadata only — no transcripts, no secrets. */
  payload?: Record<string, string | number | null>;
}

/** Roles that receive operational alerts unless a preference says otherwise. */
const OPERATIONAL_ROLES: MembershipRole[] = ["OWNER", "ADMIN", "OPERATOR"];

interface RecipientPreference {
  userId: string;
  email: string;
  name: string;
  role: MembershipRole;
  wantsEmail: boolean;
}

function prefersEmail(
  role: MembershipRole,
  explicit: boolean | null,
  eventType: DomainEventType
): boolean {
  // An explicit preference always wins — including a VIEWER opting in.
  if (explicit !== null) return explicit;
  void eventType;
  // Default: operational roles get operational email, VIEWER does not.
  return OPERATIONAL_ROLES.includes(role);
}

async function resolveRecipients(
  businessId: string,
  eventType: DomainEventType
): Promise<{ recipients: RecipientPreference[]; emailAllowed: boolean }> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { capEmailNotifications: true }
  });
  const emailEntitled = await hasEntitlement(businessId, "email_notifications");

  const memberships = await prisma.businessMembership.findMany({
    where: { business: { id: businessId } },
    include: { user: { select: { id: true, email: true, name: true, disabledAt: true } } }
  });

  const isBooking = eventType.startsWith("booking");

  const recipients = memberships
    // A disabled account is not a working inbox for operational alerts.
    .filter((membership) => membership.user.disabledAt === null)
    .map((membership) => {
      const role = membership.role as MembershipRole;
      const explicit = isBooking
        ? membership.notifyNewBookingEmail
        : membership.notifyNewEscalationEmail;
      return {
        userId: membership.userId,
        email: membership.user.email,
        name: membership.user.name,
        role,
        wantsEmail: prefersEmail(role, explicit ?? null, eventType)
      };
    });

  return { recipients, emailAllowed: (business?.capEmailNotifications ?? false) && emailEntitled };
}

interface NotificationDraft {
  subject: string;
  body: string;
  linkEntity: "booking" | "escalation";
  linkEntityId: string;
}

function draftFor(params: EmitEventParams, businessName: string): NotificationDraft | null {
  const payload = params.payload ?? {};
  const customer = typeof payload.customer === "string" ? payload.customer : null;

  switch (params.type) {
    case "booking_request.created": {
      const service = typeof payload.service === "string" ? payload.service : "an appointment";
      const when = typeof payload.requestedTime === "string" ? payload.requestedTime : null;
      return {
        subject: `New booking request — ${businessName}`,
        body:
          `${customer ?? "A caller"} requested ${service}` +
          (when ? ` for ${when}` : "") +
          ". It's waiting for review in Veyra Console.",
        linkEntity: "booking",
        linkEntityId: params.entityId
      };
    }
    case "booking.confirmed": {
      const service = typeof payload.service === "string" ? payload.service : "an appointment";
      const when = typeof payload.when === "string" ? payload.when : null;
      return {
        subject: `Appointment booked — ${businessName}`,
        body:
          `${customer ?? "A caller"} confirmed ${service}` +
          (when ? ` for ${when}` : "") +
          ". It is in the connected calendar.",
        linkEntity: "booking",
        linkEntityId: params.entityId
      };
    }
    case "booking.cancelled": {
      const when = typeof payload.when === "string" ? payload.when : null;
      return {
        subject: `Appointment cancelled — ${businessName}`,
        body: `A calendar appointment${when ? ` for ${when}` : ""} was cancelled and removed from the calendar.`,
        linkEntity: "booking",
        linkEntityId: params.entityId
      };
    }
    case "booking.rescheduled": {
      const when = typeof payload.when === "string" ? payload.when : null;
      const previous = typeof payload.previous === "string" ? payload.previous : null;
      return {
        subject: `Appointment moved — ${businessName}`,
        body: `A calendar appointment${previous ? ` on ${previous}` : ""} moved${when ? ` to ${when}` : ""}.`,
        linkEntity: "booking",
        linkEntityId: params.entityId
      };
    }
    case "escalation.created": {
      const reason = typeof payload.reason === "string" ? payload.reason : "a caller needs a person";
      return {
        subject: `New escalation — ${businessName}`,
        body: `${customer ?? "A caller"} asked for a human: "${reason}".`,
        linkEntity: "escalation",
        linkEntityId: params.entityId
      };
    }
    // Status changes are recorded as events for the audit/processing trail, but
    // don't page anyone: the operator making the change already knows.
    default:
      return null;
  }
}

/**
 * Records the event and fans out notification rows. Notifications start as
 * pending; actual delivery is a separate, retryable step so a provider outage
 * can never roll back the booking or escalation that triggered it.
 */
export async function emitDomainEvent(params: EmitEventParams): Promise<string | null> {
  try {
    const business = await prisma.business.findUnique({
      where: { id: params.businessId },
      select: { name: true }
    });
    if (!business) return null;

    const event = await prisma.domainEvent.create({
      data: {
        businessId: params.businessId,
        type: params.type,
        entityType: params.entityType,
        entityId: params.entityId,
        payload: JSON.stringify(params.payload ?? {})
      }
    });

    const draft = draftFor(params, business.name);
    if (!draft) {
      await prisma.domainEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date() }
      });
      return event.id;
    }

    // The customer's own confirmation, which is a different recipient type
    // from the staff alerts below and must not be conflated with them: one
    // booking transition legitimately produces both. Hooked here rather than
    // in the booking service so that every emitter — a conversation, the
    // Console, a calendar callback, an admin script — is covered by the same
    // rule, and none of them can forget.
    if (bookingTransitionFor(params.type)) {
      await confirmBookingTransition({
        businessId: params.businessId,
        eventId: event.id,
        type: params.type,
        appointmentId: params.entityId,
        previousLabel: typeof params.payload?.previous === "string" ? params.payload.previous : null
      }).catch((err) => {
        // Never let telling the customer undo the booking that prompted it.
        console.error("[veyra:confirmations] could not process a booking confirmation", err);
      });
    }

    const { recipients, emailAllowed } = await resolveRecipients(params.businessId, params.type);

    for (const recipient of recipients) {
      // Everyone with access sees it in the console.
      await createNotification({
        businessId: params.businessId,
        userId: recipient.userId,
        eventId: event.id,
        channel: "in_app",
        draft
      });

      // Email needs both the business capability and the person's preference.
      if (emailAllowed && recipient.wantsEmail) {
        await createNotification({
          businessId: params.businessId,
          userId: recipient.userId,
          eventId: event.id,
          channel: "email",
          draft
        });
      }
    }

    return event.id;
  } catch (err) {
    // The business action already succeeded; never surface this to the caller.
    console.error("Failed to emit domain event", params.type, err);
    return null;
  }
}

export class InvalidRecipientError extends Error {}

/**
 * Trim and lowercase, and nothing else — the same normalization Veyra already
 * applies to user emails, so a member and an external recipient cannot end up
 * stored in two different shapes. Anything that is not a valid address is
 * rejected rather than quietly repaired: guessing at a typo'd address means
 * mailing a stranger.
 */
export function normalizeRecipientEmail(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (!z.string().email().safeParse(normalized).success) {
    throw new InvalidRecipientError("A valid recipient email address is required.");
  }
  return normalized;
}

/**
 * A notification addressed outside the membership, for mail Veyra sends about
 * itself. It takes the same path as every other notification from here on:
 * pending row, claim lease, provider, retry.
 *
 * Deliberately not part of the member fan-out. `draftFor` has no case for a
 * system event, so `emitDomainEvent` would record the event and notify nobody
 * — this is the only way such a notification is created, and it always names
 * its recipient explicitly.
 */
export async function emitSystemEmailNotification(params: {
  businessId: string;
  type: DomainEventType;
  recipientEmail: string;
  subject: string;
  body: string;
}): Promise<{ eventId: string; notificationId: string }> {
  const recipientEmail = normalizeRecipientEmail(params.recipientEmail);

  return prisma.$transaction(async (tx) => {
    const event = await tx.domainEvent.create({
      data: {
        businessId: params.businessId,
        type: params.type,
        entityType: "system",
        entityId: params.businessId,
        payload: JSON.stringify({}),
        processedAt: new Date()
      }
    });

    // userId stays null: the database CHECK enforces that a row has a member
    // or an address, never both. The unique index on
    // (eventId, recipientEmail, channel) is what stops one event producing two
    // external sends — the member constraint cannot, because its userId is null.
    const notification = await tx.notification.create({
      data: {
        businessId: params.businessId,
        userId: null,
        recipientEmail,
        eventId: event.id,
        channel: "email",
        subject: params.subject,
        body: params.body,
        nextAttemptAt: new Date()
      }
    });

    return { eventId: event.id, notificationId: notification.id };
  });
}

async function createNotification(params: {
  businessId: string;
  userId: string;
  eventId: string;
  channel: "in_app" | "email";
  draft: NotificationDraft;
}): Promise<void> {
  try {
    await prisma.notification.create({
      data: {
        businessId: params.businessId,
        userId: params.userId,
        eventId: params.eventId,
        channel: params.channel,
        subject: params.draft.subject,
        body: params.draft.body,
        linkEntity: params.draft.linkEntity,
        linkEntityId: params.draft.linkEntityId,
        nextAttemptAt: new Date()
      }
    });
  } catch (err) {
    // The unique (eventId, userId, channel) constraint makes re-emitting an
    // event idempotent rather than duplicating alerts.
    if (isUniqueConstraintError(err)) return;
    throw err;
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002"
  );
}
