import { Router } from "express";
import { z } from "zod";
import type { ConsentState, ContactSource, ContactVerificationState, CustomerContactDto } from "@veyra/shared";
import { prisma } from "../db/client.js";
import { HttpError } from "../middleware/errorHandler.js";
import { requireAuth, requireBusinessPermission } from "../middleware/auth.js";
import { requireCsrfToken } from "../middleware/csrf.js";
import { maskPhone } from "../services/messaging/phone.js";
import { AmbiguousContactError, InvalidContactError, updateContact } from "../services/contacts/contactService.js";
import { resolveConfirmationDestinations } from "../services/contacts/destinations.js";
import { recordConfigChange } from "../services/setup/audit.js";

export const contactsRouter = Router();

/**
 * Customer contacts in the Console.
 *
 * Reading is a dashboard permission; changing one needs operations:write,
 * which OWNER, ADMIN and OPERATOR have and VIEWER does not. Every lookup is
 * scoped by businessId as well as contact id, so an id borrowed from another
 * tenant finds nothing rather than someone else's customer.
 *
 * Phone numbers come back masked. An operator recognising a number they
 * already know does not need to read it in full, and a list view is the
 * easiest place for personal data to end up somewhere it should not.
 */

async function toDto(contact: {
  id: string;
  businessId: string;
  displayName: string | null;
  phoneE164: string | null;
  email: string | null;
  phoneState: string;
  emailState: string;
  source: string;
  emailTransactionalAllowed: boolean;
  createdAt: Date;
}): Promise<CustomerContactDto> {
  const [bookingCount, conversationCount, consents] = await Promise.all([
    prisma.appointment.count({ where: { customerContactId: contact.id } }),
    prisma.conversation.count({ where: { customerContactId: contact.id } }),
    contact.phoneE164
      ? prisma.messagingConsent.findMany({
          where: { businessId: contact.businessId, phoneE164: contact.phoneE164 },
          select: { channel: true, state: true }
        })
      : Promise.resolve([])
  ]);

  const consentFor = (channel: string): ConsentState =>
    (consents.find((row) => row.channel === channel)?.state as ConsentState | undefined) ?? "unknown";

  return {
    id: contact.id,
    displayName: contact.displayName,
    phone: maskPhone(contact.phoneE164),
    email: contact.email,
    phoneState: contact.phoneState as ContactVerificationState,
    emailState: contact.emailState as ContactVerificationState,
    source: contact.source as ContactSource,
    emailTransactionalAllowed: contact.emailTransactionalAllowed,
    // Consent lives with the number, not the contact record: it is what the
    // customer actually opted out of.
    smsConsent: consentFor("sms"),
    whatsappConsent: consentFor("whatsapp"),
    bookingCount,
    conversationCount,
    createdAt: contact.createdAt.toISOString()
  };
}

contactsRouter.get(
  "/ops/businesses/:businessId/contacts/:contactId",
  requireAuth,
  requireBusinessPermission("dashboard:read"),
  async (req, res, next) => {
    try {
      const contact = await prisma.customerContact.findFirst({
        where: { id: req.params.contactId, businessId: req.params.businessId }
      });
      if (!contact) throw new HttpError(404, "Contact not found");
      res.json(await toDto(contact));
    } catch (err) {
      next(err);
    }
  }
);

const updateSchema = z
  .object({
    name: z.string().trim().max(120).nullable().optional(),
    phone: z.string().trim().max(24).nullable().optional(),
    email: z.string().trim().max(200).nullable().optional(),
    emailTransactionalAllowed: z.boolean().optional()
  })
  .strict();

contactsRouter.patch(
  "/ops/businesses/:businessId/contacts/:contactId",
  requireAuth,
  requireCsrfToken,
  // OWNER, ADMIN and OPERATOR. A VIEWER has dashboard:read only and cannot
  // reach this at all.
  requireBusinessPermission("operations:write"),
  async (req, res, next) => {
    try {
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, parsed.error.errors[0]?.message ?? "Invalid contact update");
      }

      const settings = await prisma.messagingSettings.findUnique({
        where: { businessId: req.params.businessId },
        select: { defaultCountry: true }
      });

      const contact = await updateContact({
        businessId: req.params.businessId,
        contactId: req.params.contactId,
        ...parsed.data,
        defaultCountry: settings?.defaultCountry ?? null
      });

      // Audited: who changed a customer's contact details, and which ones.
      // The values themselves are not recorded — the audit says what changed,
      // not what somebody's phone number is.
      await recordConfigChange({
        businessId: req.params.businessId,
        actorUserId: req.auth!.user.id,
        entityType: "customer_contact",
        entityId: contact.id,
        changeType: "updated",
        changedFields: Object.keys(parsed.data)
      });

      res.json(await toDto(contact));
    } catch (err) {
      if (err instanceof InvalidContactError) {
        next(new HttpError(400, err.message));
        return;
      }
      if (err instanceof AmbiguousContactError) {
        next(new HttpError(409, err.message));
        return;
      }
      next(err);
    }
  }
);

/**
 * Where a confirmation for this conversation's booking could go. Shown on a
 * booking so an operator can see, before they confirm it, whether the
 * customer can actually be told.
 */
contactsRouter.get(
  "/ops/businesses/:businessId/conversations/:conversationId/destinations",
  requireAuth,
  requireBusinessPermission("dashboard:read"),
  async (req, res, next) => {
    try {
      res.json(
        await resolveConfirmationDestinations({
          businessId: req.params.businessId,
          conversationId: req.params.conversationId
        })
      );
    } catch (err) {
      next(err);
    }
  }
);
