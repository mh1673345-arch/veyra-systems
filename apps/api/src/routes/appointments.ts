import { Router } from "express";
import { z } from "zod";
import type { Appointment, AppointmentStatus } from "@veyra/shared";
import { prisma } from "../db/client.js";
import { HttpError } from "../middleware/errorHandler.js";
import { accessFor, effectiveCapabilities } from "../services/access/accessService.js";
import { emitDomainEvent } from "../services/notifications/events.js";
import { scheduleProcessing } from "../services/notifications/processor.js";
import {
  AmbiguousContactError,
  InvalidContactError,
  resolveOrCreateContact
} from "../services/contacts/contactService.js";

export const appointmentsRouter = Router();

const createAppointmentSchema = z.object({
  requestedTime: z.string().min(1),
  serviceName: z.string().min(1).optional(),
  notes: z.string().min(1).optional(),
  /**
   * How to reach the customer about this booking. Optional as a whole —
   * plenty of requests are made by someone the business already knows how to
   * contact — but when it is given, at least one method must be usable, and
   * neither phone nor email is required in favour of the other.
   */
  contact: z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      phone: z.string().trim().min(1).max(24).optional(),
      email: z.string().trim().min(3).max(200).optional()
    })
    .refine((value) => Boolean(value.phone || value.email), {
      message: "Give a phone number or an email address, or leave contact out entirely."
    })
    .optional()
});

const APPOINTMENT_STATUSES: AppointmentStatus[] = [
  "draft",
  "submitted",
  "reviewing",
  "confirmed",
  "declined",
  "cancelled"
];

function toAppointmentStatus(status: string): AppointmentStatus {
  return (APPOINTMENT_STATUSES as string[]).includes(status)
    ? (status as AppointmentStatus)
    : "submitted";
}

function toAppointmentDto(appointment: {
  id: string;
  conversationId: string;
  businessId: string;
  requestedTime: string;
  serviceName: string | null;
  notes: string | null;
  status: string;
  submittedAt: Date | null;
  createdAt: Date;
}): Appointment {
  return {
    id: appointment.id,
    conversationId: appointment.conversationId,
    businessId: appointment.businessId,
    requestedTime: appointment.requestedTime,
    serviceName: appointment.serviceName,
    notes: appointment.notes,
    status: toAppointmentStatus(appointment.status),
    submittedAt: appointment.submittedAt?.toISOString() ?? null,
    createdAt: appointment.createdAt.toISOString()
  };
}

/**
 * Creates a booking *request*. It always lands in "submitted" — nothing here
 * may confirm it, because there is no calendar integration to confirm against.
 */
appointmentsRouter.post("/conversations/:conversationId/appointments", async (req, res, next) => {
  try {
    const parsed = createAppointmentSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    const conversation = await prisma.conversation.findUnique({
      where: { id: req.params.conversationId },
      include: { business: true }
    });
    if (!conversation) {
      throw new HttpError(404, "Conversation not found");
    }

    if (conversation.business.receptionStatus !== "active") {
      throw new HttpError(409, "This business isn't taking requests here right now.");
    }

    const capabilities = effectiveCapabilities(conversation.business, await accessFor(conversation.businessId));
    if (!capabilities.booking_requests) {
      throw new HttpError(422, "This business is not configured to take booking requests");
    }

    // Resolve the customer BEFORE the booking, so an unusable phone number is
    // a 400 the caller can fix rather than a saved booking nobody can confirm.
    let contactId: string | null = conversation.customerContactId;
    if (parsed.data.contact) {
      const settings = await prisma.messagingSettings.findUnique({
        where: { businessId: conversation.businessId },
        select: { defaultCountry: true }
      });
      try {
        const resolved = await resolveOrCreateContact(
          {
            businessId: conversation.businessId,
            name: parsed.data.contact.name ?? conversation.callerName,
            phone: parsed.data.contact.phone ?? null,
            email: parsed.data.contact.email ?? null,
            source: (conversation.channel as "web" | "voice" | "sms" | "whatsapp") ?? "web",
            // Typed into a form. That is a claim, not proof of ownership.
            phoneState: "provided",
            emailState: "provided"
          },
          { defaultCountry: settings?.defaultCountry ?? null }
        );
        contactId = resolved.contact.id;
      } catch (error) {
        if (error instanceof InvalidContactError) throw new HttpError(400, error.message);
        if (error instanceof AmbiguousContactError) throw new HttpError(409, error.message);
        throw error;
      }
    }

    const appointment = await prisma.appointment.create({
      data: {
        conversationId: conversation.id,
        businessId: conversation.businessId,
        requestedTime: parsed.data.requestedTime,
        serviceName: parsed.data.serviceName ?? null,
        notes: parsed.data.notes ?? null,
        status: "submitted",
        submittedAt: new Date(),
        customerContactId: contactId
      }
    });

    // The conversation remembers the customer too, so a later message on the
    // same thread resolves to them without asking again.
    if (contactId && contactId !== conversation.customerContactId) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { customerContactId: contactId }
      });
    }

    // The booking is already saved; notification work must never undo it.
    await emitDomainEvent({
      businessId: conversation.businessId,
      type: "booking_request.created",
      entityType: "booking",
      entityId: appointment.id,
      payload: {
        customer: conversation.callerName,
        service: appointment.serviceName,
        requestedTime: appointment.requestedTime
      }
    });
    scheduleProcessing();

    res.status(201).json(toAppointmentDto(appointment));
  } catch (err) {
    next(err);
  }
});

appointmentsRouter.get("/businesses/:businessId/appointments", async (req, res) => {
  const appointments = await prisma.appointment.findMany({
    where: { businessId: req.params.businessId },
    orderBy: { createdAt: "desc" }
  });
  res.json(appointments.map(toAppointmentDto));
});
