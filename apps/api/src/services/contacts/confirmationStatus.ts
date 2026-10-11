import type { BookingConfirmationDto, ConfirmationStatus } from "@veyra/shared";
import { prisma } from "../../db/client.js";
import { MAX_ATTEMPTS } from "../notifications/lease.js";

/**
 * What the Console shows about a customer confirmation.
 *
 * Two records make up the answer: BookingConfirmation says what Veyra
 * decided, and the Notification behind it says how the send is going. They
 * are combined here rather than in the UI so that every surface tells the
 * same story.
 *
 * Nothing is upgraded on assumption. A provider that accepted a message
 * leaves the status at "accepted"; it becomes "delivered" only when a
 * receipt says a handset got it.
 */

/** The provider's own word, mapped to Veyra's vocabulary. */
function fromDeliveryStatus(value: string | null): ConfirmationStatus | null {
  switch (value) {
    case "delivered":
      return "delivered";
    case "sent":
      return "sent";
    case "accepted":
    case "queued":
      return "accepted";
    case "failed":
    case "undelivered":
      return "failed";
    default:
      return null;
  }
}

export async function confirmationForBooking(
  appointmentId: string
): Promise<BookingConfirmationDto | null> {
  // The most recent decision for this booking: a reschedule supersedes the
  // original confirmation in the operator's view.
  const record = await prisma.bookingConfirmation.findFirst({
    where: { appointmentId },
    orderBy: { createdAt: "desc" }
  });
  if (!record) return null;

  const base: BookingConfirmationDto = {
    status: record.outcome as ConfirmationStatus,
    channel: record.channel === "none" ? null : record.channel,
    recipient: record.recipient,
    reason: record.reason,
    lastAttemptAt: null,
    deliveredAt: null,
    attempts: 0,
    retrying: false
  };

  if (!record.notificationId) return base;

  const notification = await prisma.notification.findUnique({
    where: { id: record.notificationId },
    select: {
      status: true,
      deliveryStatus: true,
      deliveryUpdatedAt: true,
      lastAttemptAt: true,
      attemptCount: true,
      nextAttemptAt: true,
      failureReason: true
    }
  });
  if (!notification) return base;

  const provider = fromDeliveryStatus(notification.deliveryStatus);
  const status: ConfirmationStatus =
    notification.status === "failed"
      ? "failed"
      : // The provider's own word wins where there is one, because it is
        // closer to the handset than Veyra's delivery-attempt state.
        (provider ?? (notification.status === "sent" ? "sent" : "queued"));

  return {
    ...base,
    status,
    lastAttemptAt: notification.lastAttemptAt?.toISOString() ?? null,
    deliveredAt:
      notification.deliveryStatus === "delivered"
        ? (notification.deliveryUpdatedAt?.toISOString() ?? null)
        : null,
    attempts: notification.attemptCount,
    retrying:
      notification.status === "pending" &&
      notification.attemptCount > 0 &&
      notification.attemptCount < MAX_ATTEMPTS,
    // A failure reason is the provider's own words, already bounded and
    // redacted by the adapter. Never a payload.
    reason: notification.status === "failed" ? notification.failureReason : base.reason
  };
}
