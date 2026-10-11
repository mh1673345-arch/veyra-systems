import type { CustomerContact } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { isE164, maskPhone } from "../messaging/phone.js";
import { linkContact, resolveOrCreateContact } from "./contactService.js";

/**
 * Turning a phone call into a contact, carefully.
 *
 * Caller ID is a hint and nothing more. It is trivially spoofable, it is
 * often a switchboard rather than a person, and the number a call came from
 * is frequently not the number that person wants a confirmation on. Acting
 * on it alone would mean texting whoever last held that number and, worse,
 * showing an operator a stranger's history as though it were the caller's.
 *
 * So there are exactly two ways a call produces a contact, and both need the
 * caller to say something:
 *
 *   - they confirm the number they are calling from ("yes, this number"),
 *     which the carrier did deliver the call from — channel_confirmed;
 *   - they give a different number, which nothing has corroborated —
 *     provided.
 *
 * Caller ID on its own produces nothing.
 */

/** What Veyra should ask, given what the call already knows. */
export function confirmationPrompt(callerNumber: string | null): string {
  return callerNumber && isE164(callerNumber)
    ? `Should I send the confirmation to the number you're calling from, ending ${callerNumber.slice(-2)}?`
    : "What number should we use for your confirmation?";
}

/**
 * A caller ID may *suggest* a contact this business already knows, which is
 * useful for an operator reviewing the call afterwards. It deliberately does
 * not link anything and does not return the contact's details — a suggestion
 * that leaked a name would be caller ID acting as authentication by the back
 * door.
 */
export async function suggestedContactFromCallerId(params: {
  businessId: string;
  callerNumber: string | null;
}): Promise<{ contactId: string; maskedPhone: string } | null> {
  if (!params.callerNumber || !isE164(params.callerNumber)) return null;
  const contact = await prisma.customerContact.findUnique({
    where: { businessId_phoneE164: { businessId: params.businessId, phoneE164: params.callerNumber } },
    select: { id: true, phoneE164: true }
  });
  if (!contact) return null;
  return { contactId: contact.id, maskedPhone: maskPhone(contact.phoneE164) ?? "•••" };
}

export interface VoiceContactResult {
  contact: CustomerContact;
  /** How the number was established, for the record and for the Console. */
  basis: "confirmed_caller_id" | "spoken_by_caller";
}

/**
 * Records the number a caller actually agreed to, and links it to the call
 * and its conversation.
 *
 * `confirmedCallerNumber` means the caller said yes to the number they were
 * calling from; `spokenNumber` means they gave a different one. Passing
 * neither is a programming error rather than a silent no-op, because the
 * alternative is a call that quietly ends with no way to confirm anything.
 */
export async function recordConfirmedVoiceContact(params: {
  businessId: string;
  callSessionId: string;
  conversationId?: string | null;
  name?: string | null;
  confirmedCallerNumber?: string | null;
  spokenNumber?: string | null;
  defaultCountry?: string | null;
}): Promise<VoiceContactResult> {
  const usingCallerId = Boolean(params.confirmedCallerNumber);
  const number = params.confirmedCallerNumber ?? params.spokenNumber;
  if (!number) {
    throw new Error(
      "A voice contact needs either a confirmed caller number or one the caller gave. Caller ID alone is not enough."
    );
  }

  const { contact } = await resolveOrCreateContact(
    {
      businessId: params.businessId,
      name: params.name ?? null,
      phone: number,
      source: "voice",
      // The carrier delivered the call from this number and the caller
      // agreed to it. That is control of the channel, not proof of identity.
      phoneState: usingCallerId ? "channel_confirmed" : "provided"
    },
    { defaultCountry: params.defaultCountry }
  );

  await linkContact({
    contactId: contact.id,
    callSessionId: params.callSessionId,
    conversationId: params.conversationId ?? null
  });

  return { contact, basis: usingCallerId ? "confirmed_caller_id" : "spoken_by_caller" };
}
