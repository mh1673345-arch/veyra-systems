import { Router } from "express";
import { z } from "zod";
import type {
  AppointmentStatus,
  AssistantAction,
  AssistantIntent,
  EscalationStatus,
  OpsActivityItem,
  OpsBooking,
  OpsConversationSummary,
  OpsEscalation,
  OpsOverview,
  BookingConfirmationDto,
  StatusEvent
} from "@veyra/shared";
import { prisma } from "../db/client.js";
import { HttpError } from "../middleware/errorHandler.js";
import { requireAuth, requireBusinessPermission } from "../middleware/auth.js";
import { requireCsrfToken } from "../middleware/csrf.js";
import { emitDomainEvent } from "../services/notifications/events.js";
import { cancelCalendarBooking, rescheduleCalendarBooking } from "../services/calendar/bookings.js";
import { releaseExpiredHolds } from "../services/calendar/holds.js";
import { scheduleProcessing } from "../services/notifications/processor.js";
import { toCapabilities } from "../services/businessContext.js";
import {
  EntitlementError,
  accessFor,
  effectiveCapabilities,
  hasEntitlement
} from "../services/access/accessService.js";
import { lowestPlanWith } from "@veyra/shared";
import {
  allowedBookingTransitions,
  allowedBookingTransitionsFor,
  allowedEscalationTransitions,
  canTransitionBooking,
  canTransitionEscalation
} from "../services/ops/transitions.js";
import { confirmationForBooking } from "../services/contacts/confirmationStatus.js";

export const opsRouter = Router();

const updateStatusSchema = z.object({ status: z.string().min(1) });

/**
 * Every handler below resolves the business first and scopes its queries by
 * businessId. A record belonging to another business is reported as 404 rather
 * than 403, so the dashboard can't be used to probe for records it can't see.
 */
async function requireBusiness(businessId: string) {
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) {
    throw new HttpError(404, "Business not found");
  }
  return business;
}

function toStatusEventDto(event: {
  id: string;
  entityType: string;
  entityId: string;
  fromStatus: string;
  toStatus: string;
  actorType: string;
  actorUserId: string | null;
  createdAt: Date;
  actorUser?: { name: string } | null;
}): StatusEvent {
  return {
    id: event.id,
    entityType: event.entityType === "escalation" ? "escalation" : "booking",
    entityId: event.entityId,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    actorType: event.actorType,
    actorUserId: event.actorUserId,
    // Read through the relation so a renamed user isn't stale in the audit log.
    actorName: event.actorUser?.name ?? null,
    createdAt: event.createdAt.toISOString()
  };
}

type BookingRow = {
  id: string;
  conversationId: string;
  requestedTime: string;
  serviceName: string | null;
  notes: string | null;
  status: string;
  mode: string;
  startTime: Date | null;
  endTime: Date | null;
  timezone: string | null;
  calendarProvider: string | null;
  externalCalendarId: string | null;
  externalEventId: string | null;
  externalEventStatus: string | null;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
  conversation?: { callerName: string | null } | null;
};

function toBookingDto(booking: BookingRow, confirmation: BookingConfirmationDto | null = null): OpsBooking {
  return {
    id: booking.id,
    conversationId: booking.conversationId,
    callerName: booking.conversation?.callerName ?? null,
    requestedTime: booking.requestedTime,
    serviceName: booking.serviceName,
    notes: booking.notes,
    status: booking.status as AppointmentStatus,
    mode: booking.mode === "calendar" ? "calendar" : "request",
    startTime: booking.startTime?.toISOString() ?? null,
    endTime: booking.endTime?.toISOString() ?? null,
    timezone: booking.timezone,
    calendarProvider: booking.calendarProvider,
    externalCalendarId: booking.externalCalendarId,
    externalEventId: booking.externalEventId,
    externalEventStatus: booking.externalEventStatus,
    // A calendar-backed booking may only be cancelled from here: that path goes
    // through CalendarService so the external event moves with it.
    allowedTransitions: allowedBookingTransitionsFor(booking.mode, booking.status),
    submittedAt: booking.submittedAt?.toISOString() ?? null,
    reviewedAt: booking.reviewedAt?.toISOString() ?? null,
    resolvedAt: booking.resolvedAt?.toISOString() ?? null,
    confirmation,
    createdAt: booking.createdAt.toISOString()
  };
}

type EscalationRow = {
  id: string;
  conversationId: string;
  reason: string;
  status: string;
  assignedAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
  conversation?: { callerName: string | null } | null;
};

function toEscalationDto(escalation: EscalationRow): OpsEscalation {
  return {
    id: escalation.id,
    conversationId: escalation.conversationId,
    callerName: escalation.conversation?.callerName ?? null,
    reason: escalation.reason,
    status: escalation.status as EscalationStatus,
    allowedTransitions: allowedEscalationTransitions(escalation.status),
    assignedAt: escalation.assignedAt?.toISOString() ?? null,
    resolvedAt: escalation.resolvedAt?.toISOString() ?? null,
    createdAt: escalation.createdAt.toISOString()
  };
}

/* ------------------------------ overview ------------------------------ */

opsRouter.get("/ops/businesses/:businessId/overview", requireAuth, requireBusinessPermission("dashboard:read"), async (req, res, next) => {
  try {
    const business = await requireBusiness(req.params.businessId);
    const businessId = business.id;

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [
      conversationsToday,
      conversationsTotal,
      openBookings,
      resolvedBookings,
      openEscalations,
      resolvedEscalations,
      recentEvents,
      recentConversations,
      unreadNotifications
    ] = await Promise.all([
      prisma.conversation.count({ where: { businessId, createdAt: { gte: startOfToday } } }),
      prisma.conversation.count({ where: { businessId } }),
      prisma.appointment.count({ where: { businessId, status: { in: ["submitted", "reviewing"] } } }),
      prisma.appointment.count({ where: { businessId, status: { in: ["confirmed", "declined"] } } }),
      prisma.escalation.count({ where: { businessId, status: { in: ["requested", "assigned"] } } }),
      prisma.escalation.count({ where: { businessId, status: { in: ["resolved", "closed"] } } }),
      prisma.statusEvent.findMany({
        where: { businessId },
        orderBy: { createdAt: "desc" },
        take: 10
      }),
      prisma.conversation.findMany({
        where: { businessId },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { id: true, callerName: true, createdAt: true }
      }),
      prisma.notification.count({
        where: { businessId, userId: req.auth!.user.id, channel: "in_app", readAt: null }
      })
    ]);

    // Activity is assembled only from rows that actually exist — no synthesised
    // metrics, no placeholder history.
    const activity: OpsActivityItem[] = [
      ...recentEvents.map((event) => ({
        id: event.id,
        type: (event.entityType === "escalation"
          ? "escalation_status"
          : "booking_status") as OpsActivityItem["type"],
        description: `${event.entityType === "escalation" ? "Escalation" : "Booking"} moved ${event.fromStatus} → ${event.toStatus}`,
        createdAt: event.createdAt.toISOString(),
        conversationId: null
      })),
      ...recentConversations.map((conversation) => ({
        id: conversation.id,
        type: "conversation_started" as const,
        description: `Conversation started${conversation.callerName ? ` with ${conversation.callerName}` : ""}`,
        createdAt: conversation.createdAt.toISOString(),
        conversationId: conversation.id
      }))
    ]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 12);

    const overview: OpsOverview = {
      businessId,
      businessName: business.name,
      conversationsToday,
      conversationsTotal,
      openBookings,
      openEscalations,
      resolvedBookings,
      resolvedEscalations,
      openWork: openBookings + openEscalations,
      unreadNotifications,
      recentActivity: activity
    };

    res.json(overview);
  } catch (err) {
    next(err);
  }
});

/* ---------------------------- capabilities ---------------------------- */

opsRouter.get("/ops/businesses/:businessId/capabilities", requireAuth, requireBusinessPermission("settings:read"), async (req, res, next) => {
  try {
    const business = await requireBusiness(req.params.businessId);
    res.json({
      businessId: business.id,
      businessName: business.name,
      // Effective: configured AND included in the subscription.
      capabilities: effectiveCapabilities(business, await accessFor(business.id)),
      // What the business itself has switched on, for explaining the difference.
      configured: toCapabilities(business)
    });
  } catch (err) {
    next(err);
  }
});

/* --------------------------- conversations ---------------------------- */

opsRouter.get("/ops/businesses/:businessId/conversations", requireAuth, requireBusinessPermission("dashboard:read"), async (req, res, next) => {
  try {
    const business = await requireBusiness(req.params.businessId);

    const conversations = await prisma.conversation.findMany({
      where: { businessId: business.id },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        messages: { orderBy: { createdAt: "desc" } },
        _count: { select: { appointments: true, escalations: true } }
      }
    });

    const summaries: OpsConversationSummary[] = conversations.map((conversation) => {
      const lastCaller = conversation.messages.find((m) => m.sender === "caller");
      const lastReceptionist = conversation.messages.find((m) => m.sender === "receptionist");
      return {
        id: conversation.id,
        callerName: conversation.callerName,
        channel: conversation.channel as OpsConversationSummary["channel"],
        customerContactId: conversation.customerContactId,
        status: conversation.status === "closed" ? "closed" : "open",
        createdAt: conversation.createdAt.toISOString(),
        messageCount: conversation.messages.length,
        lastCallerMessage: lastCaller?.text ?? null,
        lastMessageAt: conversation.messages[0]?.createdAt.toISOString() ?? null,
        lastIntent: (lastReceptionist?.intent as AssistantIntent | null) ?? null,
        bookingCount: conversation._count.appointments,
        escalationCount: conversation._count.escalations
      };
    });

    res.json(summaries);
  } catch (err) {
    next(err);
  }
});

opsRouter.get("/ops/businesses/:businessId/conversations/:id", requireAuth, requireBusinessPermission("dashboard:read"), async (req, res, next) => {
  try {
    const business = await requireBusiness(req.params.businessId);

    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id, businessId: business.id },
      include: {
        messages: { orderBy: { createdAt: "asc" } },
        appointments: { orderBy: { createdAt: "desc" } },
        escalations: { orderBy: { createdAt: "desc" } }
      }
    });
    if (!conversation) {
      throw new HttpError(404, "Conversation not found");
    }

    const lastCaller = [...conversation.messages].reverse().find((m) => m.sender === "caller");
    const lastReceptionist = [...conversation.messages]
      .reverse()
      .find((m) => m.sender === "receptionist");

    res.json({
      conversation: {
        id: conversation.id,
        callerName: conversation.callerName,
        channel: conversation.channel,
        customerContactId: conversation.customerContactId,
        status: conversation.status === "closed" ? "closed" : "open",
        createdAt: conversation.createdAt.toISOString(),
        messageCount: conversation.messages.length,
        lastCallerMessage: lastCaller?.text ?? null,
        lastMessageAt:
          conversation.messages.at(-1)?.createdAt.toISOString() ?? null,
        lastIntent: (lastReceptionist?.intent as AssistantIntent | null) ?? null,
        bookingCount: conversation.appointments.length,
        escalationCount: conversation.escalations.length
      },
      // Business-facing view: intent and action only. Confidence, clarification
      // flags and responder details stay in server logs.
      messages: conversation.messages.map((message) => ({
        id: message.id,
        sender: message.sender === "receptionist" ? "receptionist" : "caller",
        text: message.text,
        intent: (message.intent as AssistantIntent | null) ?? null,
        action: (message.action as AssistantAction | null) ?? null,
        createdAt: message.createdAt.toISOString()
      })),
      bookings: await Promise.all(
        conversation.appointments.map(async (a) =>
          toBookingDto(
            { ...a, conversation: { callerName: conversation.callerName } },
            await confirmationForBooking(a.id)
          )
        )
      ),
      escalations: conversation.escalations.map((e) =>
        toEscalationDto({ ...e, conversation: { callerName: conversation.callerName } })
      )
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------ bookings ------------------------------ */

opsRouter.get("/ops/businesses/:businessId/bookings", requireAuth, requireBusinessPermission("dashboard:read"), async (req, res, next) => {
  // Lapsed holds are released before the list is read, so an operator never
  // sees a slot as "awaiting confirmation" when its window has passed.
  await releaseExpiredHolds({ businessId: req.params.businessId }).catch((err) =>
    console.error("[veyra:holds] sweep failed", err)
  );
  try {
    const business = await requireBusiness(req.params.businessId);
    const bookings = await prisma.appointment.findMany({
      where: { businessId: business.id },
      orderBy: { createdAt: "desc" },
      include: { conversation: { select: { callerName: true } } }
    });
    // The confirmation is fetched per booking rather than in the mapper, so
    // .map cannot pass its index in as one.
    res.json(
      await Promise.all(
        bookings.map(async (booking) => toBookingDto(booking, await confirmationForBooking(booking.id)))
      )
    );
  } catch (err) {
    next(err);
  }
});

opsRouter.get("/ops/businesses/:businessId/bookings/:id", requireAuth, requireBusinessPermission("dashboard:read"), async (req, res, next) => {
  try {
    const business = await requireBusiness(req.params.businessId);
    const booking = await prisma.appointment.findFirst({
      where: { id: req.params.id, businessId: business.id },
      include: { conversation: { select: { callerName: true } } }
    });
    if (!booking) {
      throw new HttpError(404, "Booking request not found");
    }

    const history = await prisma.statusEvent.findMany({
      where: { businessId: business.id, entityType: "booking", entityId: booking.id },
      orderBy: { createdAt: "asc" },
      include: { actorUser: { select: { name: true } } }
    });

    res.json({
      booking: toBookingDto(booking, await confirmationForBooking(booking.id)),
      businessName: business.name,
      history: history.map(toStatusEventDto)
    });
  } catch (err) {
    next(err);
  }
});

opsRouter.patch("/ops/businesses/:businessId/bookings/:id/status", requireAuth, requireCsrfToken, requireBusinessPermission("operations:write"), async (req, res, next) => {
  try {
    const business = await requireBusiness(req.params.businessId);
    const parsed = updateStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "A target status is required");
    }

    const booking = await prisma.appointment.findFirst({
      where: { id: req.params.id, businessId: business.id }
    });
    if (!booking) {
      throw new HttpError(404, "Booking request not found");
    }

    const nextStatus = parsed.data.status;
    const allowed = allowedBookingTransitionsFor(booking.mode, booking.status);
    if (!allowed.includes(nextStatus as AppointmentStatus)) {
      throw new HttpError(
        422,
        `Cannot move a ${booking.mode === "calendar" ? "calendar booking" : "booking request"} from ` +
          `"${booking.status}" to "${nextStatus}". Allowed: ${allowed.join(", ") || "none"}.`
      );
    }

    // A calendar-backed booking is never flipped in the database alone: the
    // external event has to move with it, so this goes through CalendarService.
    // If the provider refuses, nothing is marked cancelled here either.
    if (booking.mode === "calendar") {
      // Paid feature boundary, enforced in cancelCalendarBooking rather than
      // by hiding the button. The one exception: a confirmed booking Veyra put
      // in the calendar before a downgrade can still be cancelled by staff.
      const outcome = await cancelCalendarBooking({
        appointmentId: booking.id,
        actorUserId: req.auth!.user.id,
        reason: "Cancelled by operator",
        allowLapsedPlanCleanup: true
      });
      if (outcome.status === "not_entitled") {
        throw new EntitlementError("calendar_cancellation", lowestPlanWith("calendar_cancellation"));
      }
      if (outcome.status !== "cancelled") {
        throw new HttpError(
          502,
          outcome.status === "provider_failed"
            ? `The calendar provider did not cancel the event: ${outcome.detail}. The booking is unchanged.`
            : "This booking can no longer be cancelled."
        );
      }
      const refreshed = await prisma.appointment.findFirstOrThrow({
        where: { id: booking.id },
        include: { conversation: { select: { callerName: true } } }
      });
      res.json(toBookingDto(refreshed));
      return;
    }

    const now = new Date();
    const updated = await prisma.appointment.update({
      where: { id: booking.id },
      data: {
        status: nextStatus,
        ...(nextStatus === "reviewing" ? { reviewedAt: now } : {}),
        ...(["confirmed", "declined", "cancelled"].includes(nextStatus)
          ? { resolvedAt: now }
          : {})
      },
      include: { conversation: { select: { callerName: true } } }
    });

    await prisma.statusEvent.create({
      data: {
        businessId: business.id,
        entityType: "booking",
        entityId: booking.id,
        fromStatus: booking.status,
        toStatus: nextStatus,
        actorType: "operator",
        actorUserId: req.auth!.user.id
      }
    });

    await emitDomainEvent({
      businessId: business.id,
      type: "booking_request.status_changed",
      entityType: "booking",
      entityId: booking.id,
      payload: { from: booking.status, to: nextStatus }
    });
    scheduleProcessing();

    res.json(toBookingDto(updated));
  } catch (err) {
    next(err);
  }
});

/* ----------------------------- escalations ---------------------------- */

/**
 * Move a calendar booking to a new time, from the Console.
 *
 * The rescheduling service has existed since the calendar phase but had no
 * operator entry point, so a booking could only ever be cancelled and redone.
 * This is that entry point: the new slot is verified free before anything
 * changes, and a refusal leaves the original booking exactly as it was.
 *
 * Paid boundary and pilot safety are both enforced here — an operator cannot
 * reschedule on a plan that excludes it, nor while the pilot's
 * allowAutoReschedule brake is off.
 */
opsRouter.post(
  "/ops/businesses/:businessId/bookings/:id/reschedule",
  requireAuth,
  requireCsrfToken,
  requireBusinessPermission("operations:write"),
  async (req, res, next) => {
    try {
      const business = await prisma.business.findUnique({
        where: { id: req.params.businessId },
        select: { id: true, allowAutoReschedule: true }
      });
      if (!business) throw new HttpError(404, "Business not found");

      const startRaw = req.body?.start;
      if (typeof startRaw !== "string") throw new HttpError(400, "A new start time is required.");
      const start = new Date(startRaw);
      if (Number.isNaN(start.getTime())) throw new HttpError(400, "start must be a valid ISO date-time.");

      const booking = await prisma.appointment.findFirst({
        where: { id: req.params.id, businessId: business.id }
      });
      if (!booking) throw new HttpError(404, "Booking request not found");
      if (booking.mode !== "calendar") {
        throw new HttpError(422, "Only a calendar-backed booking can be rescheduled. Edit a booking request directly.");
      }
      if (!business.allowAutoReschedule) {
        throw new HttpError(
          409,
          "Rescheduling is switched off for this business by a pilot safety control. Turn it back on in the Pilot section first."
        );
      }

      const outcome = await rescheduleCalendarBooking({
        appointmentId: booking.id,
        newStart: start,
        actorUserId: req.auth!.user.id
      });

      switch (outcome.status) {
        case "rescheduled": {
          const refreshed = await prisma.appointment.findFirstOrThrow({
            where: { id: booking.id },
            include: { conversation: { select: { callerName: true } } }
          });
          res.json(toBookingDto(refreshed));
          return;
        }
        case "not_entitled":
          throw new EntitlementError("calendar_reschedule", lowestPlanWith("calendar_reschedule"));
        case "unavailable": {
          const alternatives = outcome.availability.alternatives.slice(0, 3).map((slot) => slot.start.toISOString());
          throw new HttpError(
            409,
            `That time isn't free, so the booking is unchanged.${
              alternatives.length > 0 ? ` Nearest free slots: ${alternatives.join(", ")}.` : ""
            }`
          );
        }
        case "calendar_unavailable":
          throw new HttpError(502, `The calendar could not be reached: ${outcome.detail}. The booking is unchanged.`);
        default:
          throw new HttpError(422, "This booking can't be rescheduled.");
      }
    } catch (err) {
      next(err);
    }
  }
);

opsRouter.get("/ops/businesses/:businessId/escalations", requireAuth, requireBusinessPermission("dashboard:read"), async (req, res, next) => {
  try {
    const business = await requireBusiness(req.params.businessId);
    const escalations = await prisma.escalation.findMany({
      where: { businessId: business.id },
      orderBy: { createdAt: "desc" },
      include: { conversation: { select: { callerName: true } } }
    });
    res.json(escalations.map(toEscalationDto));
  } catch (err) {
    next(err);
  }
});

opsRouter.get("/ops/businesses/:businessId/escalations/:id", requireAuth, requireBusinessPermission("dashboard:read"), async (req, res, next) => {
  try {
    const business = await requireBusiness(req.params.businessId);
    const escalation = await prisma.escalation.findFirst({
      where: { id: req.params.id, businessId: business.id },
      include: { conversation: { select: { callerName: true } } }
    });
    if (!escalation) {
      throw new HttpError(404, "Escalation not found");
    }

    const history = await prisma.statusEvent.findMany({
      where: { businessId: business.id, entityType: "escalation", entityId: escalation.id },
      orderBy: { createdAt: "asc" },
      include: { actorUser: { select: { name: true } } }
    });

    res.json({
      escalation: toEscalationDto(escalation),
      businessName: business.name,
      history: history.map(toStatusEventDto)
    });
  } catch (err) {
    next(err);
  }
});

opsRouter.patch("/ops/businesses/:businessId/escalations/:id/status", requireAuth, requireCsrfToken, requireBusinessPermission("operations:write"), async (req, res, next) => {
  try {
    const business = await requireBusiness(req.params.businessId);
    const parsed = updateStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "A target status is required");
    }

    const escalation = await prisma.escalation.findFirst({
      where: { id: req.params.id, businessId: business.id }
    });
    if (!escalation) {
      throw new HttpError(404, "Escalation not found");
    }

    const nextStatus = parsed.data.status;
    if (!canTransitionEscalation(escalation.status, nextStatus)) {
      throw new HttpError(
        422,
        `Cannot move an escalation from "${escalation.status}" to "${nextStatus}". ` +
          `Allowed: ${allowedEscalationTransitions(escalation.status).join(", ") || "none"}.`
      );
    }

    const now = new Date();
    const updated = await prisma.escalation.update({
      where: { id: escalation.id },
      data: {
        status: nextStatus,
        ...(nextStatus === "assigned" ? { assignedAt: now } : {}),
        ...(["resolved", "closed"].includes(nextStatus) ? { resolvedAt: now } : {})
      },
      include: { conversation: { select: { callerName: true } } }
    });

    await prisma.statusEvent.create({
      data: {
        businessId: business.id,
        entityType: "escalation",
        entityId: escalation.id,
        fromStatus: escalation.status,
        toStatus: nextStatus,
        actorType: "operator",
        actorUserId: req.auth!.user.id
      }
    });

    await emitDomainEvent({
      businessId: business.id,
      type:
        nextStatus === "assigned"
          ? "escalation.assigned"
          : nextStatus === "resolved"
            ? "escalation.resolved"
            : "escalation.status_changed",
      entityType: "escalation",
      entityId: escalation.id,
      payload: { from: escalation.status, to: nextStatus }
    });
    scheduleProcessing();

    res.json(toEscalationDto(updated));
  } catch (err) {
    next(err);
  }
});
