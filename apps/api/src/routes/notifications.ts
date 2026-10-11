import { Router } from "express";
import { z } from "zod";
import type {
  MembershipRole,
  NotificationChannel,
  NotificationPreferences,
  NotificationStatus,
  OpsNotification,
  OpsNotificationList,
  OpsWorkItem
} from "@veyra/shared";
import { prisma } from "../db/client.js";
import { hasEntitlement } from "../services/access/accessService.js";
import { HttpError } from "../middleware/errorHandler.js";
import { requireAuth, requireBusinessPermission } from "../middleware/auth.js";
import { requireCsrfToken } from "../middleware/csrf.js";

export const notificationsRouter = Router();

const preferencesSchema = z
  .object({
    new_booking_email: z.boolean(),
    new_escalation_email: z.boolean()
  })
  .partial();

/** Same default rule the fan-out uses: operational roles yes, VIEWER no. */
function defaultEmailPreference(role: MembershipRole): boolean {
  return role !== "VIEWER";
}

function toNotificationDto(row: {
  id: string;
  channel: string;
  status: string;
  subject: string;
  body: string;
  linkEntity: string | null;
  linkEntityId: string | null;
  readAt: Date | null;
  createdAt: Date;
}): OpsNotification {
  return {
    id: row.id,
    channel: row.channel as NotificationChannel,
    status: row.status as NotificationStatus,
    subject: row.subject,
    body: row.body,
    linkEntity: (row.linkEntity as OpsNotification["linkEntity"]) ?? null,
    linkEntityId: row.linkEntityId,
    read: row.readAt !== null,
    createdAt: row.createdAt.toISOString()
  };
}

/**
 * In-app notifications for the signed-in user in this business. Scoped by both
 * businessId and userId, so one member never sees another's notifications and
 * no tenant sees another's.
 */
notificationsRouter.get(
  "/ops/businesses/:businessId/notifications",
  requireAuth,
  requireBusinessPermission("dashboard:read"),
  async (req, res, next) => {
    try {
      const where = {
        businessId: req.params.businessId,
        userId: req.auth!.user.id,
        channel: "in_app"
      };

      const [rows, unreadCount] = await Promise.all([
        prisma.notification.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: 50
        }),
        prisma.notification.count({ where: { ...where, readAt: null } })
      ]);

      const body: OpsNotificationList = {
        unreadCount,
        notifications: rows.map(toNotificationDto)
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  }
);

notificationsRouter.post(
  "/ops/businesses/:businessId/notifications/:id/read",
  requireAuth,
  requireCsrfToken,
  requireBusinessPermission("dashboard:read"),
  async (req, res, next) => {
    try {
      // Scoped to the caller: you can only mark your own notification read.
      const updated = await prisma.notification.updateMany({
        where: {
          id: req.params.id,
          businessId: req.params.businessId,
          userId: req.auth!.user.id
        },
        data: { readAt: new Date() }
      });

      if (updated.count === 0) {
        throw new HttpError(404, "Notification not found");
      }

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

notificationsRouter.post(
  "/ops/businesses/:businessId/notifications/read-all",
  requireAuth,
  requireCsrfToken,
  requireBusinessPermission("dashboard:read"),
  async (req, res, next) => {
    try {
      const updated = await prisma.notification.updateMany({
        where: {
          businessId: req.params.businessId,
          userId: req.auth!.user.id,
          channel: "in_app",
          readAt: null
        },
        data: { readAt: new Date() }
      });
      res.json({ read: updated.count });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Unresolved operational work, oldest first — the queue an operator actually
 * works from. Derived from the real records rather than a separate table that
 * could drift out of sync.
 */
notificationsRouter.get(
  "/ops/businesses/:businessId/work-queue",
  requireAuth,
  requireBusinessPermission("dashboard:read"),
  async (req, res, next) => {
    try {
      const businessId = req.params.businessId;

      const [bookings, escalations] = await Promise.all([
        prisma.appointment.findMany({
          where: { businessId, status: { in: ["submitted", "reviewing"] } },
          include: { conversation: { select: { callerName: true } } }
        }),
        prisma.escalation.findMany({
          where: { businessId, status: { in: ["requested", "assigned"] } },
          include: { conversation: { select: { callerName: true } } }
        })
      ]);

      const now = Date.now();
      const ageHours = (date: Date) => Math.floor((now - date.getTime()) / (60 * 60 * 1000));

      const items: OpsWorkItem[] = [
        ...bookings.map((booking) => ({
          id: booking.id,
          type: "booking" as const,
          customer: booking.conversation?.callerName ?? null,
          summary: booking.serviceName ?? `Requested ${booking.requestedTime}`,
          status: booking.status,
          conversationId: booking.conversationId,
          createdAt: booking.createdAt.toISOString(),
          ageHours: ageHours(booking.createdAt)
        })),
        ...escalations.map((escalation) => ({
          id: escalation.id,
          type: "escalation" as const,
          customer: escalation.conversation?.callerName ?? null,
          summary: escalation.reason,
          status: escalation.status,
          conversationId: escalation.conversationId,
          createdAt: escalation.createdAt.toISOString(),
          ageHours: ageHours(escalation.createdAt)
        }))
      ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

      res.json(items);
    } catch (err) {
      next(err);
    }
  }
);

/** The caller's own notification preferences for this business. */
notificationsRouter.get(
  "/ops/businesses/:businessId/notification-preferences",
  requireAuth,
  requireBusinessPermission("dashboard:read"),
  async (req, res, next) => {
    try {
      const membership = await prisma.businessMembership.findUnique({
        where: {
          userId_businessId: { userId: req.auth!.user.id, businessId: req.params.businessId }
        },
        include: { business: { select: { capEmailNotifications: true } } }
      });
      if (!membership) {
        throw new HttpError(404, "Business not found");
      }

      const role = membership.role as MembershipRole;
      const body: NotificationPreferences = {
        new_booking_email: membership.notifyNewBookingEmail ?? defaultEmailPreference(role),
        new_escalation_email: membership.notifyNewEscalationEmail ?? defaultEmailPreference(role),
        // A preference can be on while the business can't send email at all.
        emailAvailable:
          membership.business.capEmailNotifications &&
          (await hasEntitlement(req.params.businessId, "email_notifications"))
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  }
);

notificationsRouter.patch(
  "/ops/businesses/:businessId/notification-preferences",
  requireAuth,
  requireCsrfToken,
  requireBusinessPermission("dashboard:read"),
  async (req, res, next) => {
    try {
      const parsed = preferencesSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, "Preferences must be booleans");
      }

      const updated = await prisma.businessMembership.update({
        where: {
          userId_businessId: { userId: req.auth!.user.id, businessId: req.params.businessId }
        },
        data: {
          ...(parsed.data.new_booking_email !== undefined
            ? { notifyNewBookingEmail: parsed.data.new_booking_email }
            : {}),
          ...(parsed.data.new_escalation_email !== undefined
            ? { notifyNewEscalationEmail: parsed.data.new_escalation_email }
            : {})
        },
        include: { business: { select: { capEmailNotifications: true } } }
      });

      const role = updated.role as MembershipRole;
      const body: NotificationPreferences = {
        new_booking_email: updated.notifyNewBookingEmail ?? defaultEmailPreference(role),
        new_escalation_email: updated.notifyNewEscalationEmail ?? defaultEmailPreference(role),
        emailAvailable:
          updated.business.capEmailNotifications &&
          (await hasEntitlement(req.params.businessId, "email_notifications"))
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  }
);
