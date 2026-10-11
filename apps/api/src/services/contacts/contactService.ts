import type { CustomerContact, Prisma } from "@prisma/client";
import type { ContactSource, ContactVerificationState } from "@veyra/shared";
import { prisma } from "../../db/client.js";
import { InvalidPhoneNumberError, toE164 } from "../messaging/phone.js";

/**
 * Customer contact identity — the only place that decides whether two pieces
 * of contact information belong to the same person.
 *
 * The rules are deliberately narrow, because the failure mode of being
 * clever here is sending one customer's booking details to another:
 *
 *   - matching is by EXACT normalized phone or EXACT normalized email, and
 *     nothing else. Never a name, never a similar address, never a caller ID
 *     that resembles a stored number;
 *   - every lookup is scoped to one business. The same number in two
 *     businesses is two unrelated people as far as Veyra is concerned;
 *   - when the phone matches one contact and the email matches a different
 *     one, that is refused rather than merged. Two records that disagree are
 *     a question for a human;
 *   - an update never weakens what is already known. A typed-in number does
 *     not overwrite one a provider confirmed.
 *
 * There is no merge operation and no cross-business lookup, by design.
 */

export class AmbiguousContactError extends Error {
  constructor(
    message: string,
    readonly phoneContactId: string,
    readonly emailContactId: string
  ) {
    super(message);
    this.name = "AmbiguousContactError";
  }
}

export class InvalidContactError extends Error {
  constructor(
    message: string,
    readonly field: "phone" | "email" | "none"
  ) {
    super(message);
    this.name = "InvalidContactError";
  }
}

/**
 * Lowercase and trim, and nothing else. The local part of an address is
 * technically case-sensitive, but every mailbox people actually use treats
 * it otherwise, and Veyra already stores member emails this way — one shape
 * across the product beats being right in theory and inconsistent in fact.
 */
export function normalizeEmail(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  // Deliberately strict and boring: one @, something either side, a dot in
  // the domain. Anything stranger is rejected rather than half-accepted.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new InvalidContactError("That is not a valid email address.", "email");
  }
  return normalized;
}

/** Strength order, so an update can refuse to go backwards. */
const STATE_RANK: Record<ContactVerificationState, number> = {
  unknown: 0,
  provided: 1,
  channel_confirmed: 2,
  verified: 3
};

function strongest(
  current: ContactVerificationState,
  incoming: ContactVerificationState
): ContactVerificationState {
  return STATE_RANK[incoming] > STATE_RANK[current] ? incoming : current;
}

export interface ContactInput {
  businessId: string;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  source: ContactSource;
  /** How well the phone is known. Defaults to "provided" when one is given. */
  phoneState?: ContactVerificationState;
  emailState?: ContactVerificationState;
}

interface NormalizedInput {
  phone: string | null;
  email: string | null;
  name: string | null;
}

function normalizeInput(input: ContactInput, defaultCountry?: string | null): NormalizedInput {
  let phone: string | null = null;
  if (input.phone) {
    try {
      phone = toE164(input.phone, { defaultCountry });
    } catch (error) {
      throw new InvalidContactError(
        error instanceof InvalidPhoneNumberError ? error.message : "That phone number is not usable.",
        "phone"
      );
    }
  }
  const email = input.email ? normalizeEmail(input.email) : null;
  const name = input.name?.trim() || null;

  if (!phone && !email) {
    throw new InvalidContactError("A contact needs a phone number or an email address.", "none");
  }
  return { phone, email, name };
}

export async function findByPhone(businessId: string, phone: string): Promise<CustomerContact | null> {
  const phoneE164 = toE164(phone);
  return prisma.customerContact.findUnique({
    where: { businessId_phoneE164: { businessId, phoneE164 } }
  });
}

export async function findByEmail(businessId: string, email: string): Promise<CustomerContact | null> {
  return prisma.customerContact.findUnique({
    where: { businessId_email: { businessId, email: normalizeEmail(email) } }
  });
}

export interface ResolvedContact {
  contact: CustomerContact;
  /** "created" | "matched_phone" | "matched_email" — how identity was decided. */
  outcome: "created" | "matched_phone" | "matched_email";
}

/**
 * Finds the contact these details belong to, or creates one.
 *
 * Deterministic by construction: the unique indexes mean at most one contact
 * per business can hold a given number or address, so there is never a set of
 * candidates to choose between — only the phone match, the email match, or
 * neither. When those two are different records the caller is told, and
 * nothing is changed.
 */
export async function resolveOrCreateContact(
  input: ContactInput,
  options: { defaultCountry?: string | null; tx?: Prisma.TransactionClient } = {}
): Promise<ResolvedContact> {
  const client = options.tx ?? prisma;
  const { phone, email, name } = normalizeInput(input, options.defaultCountry);

  const [byPhone, byEmail] = await Promise.all([
    phone
      ? client.customerContact.findUnique({
          where: { businessId_phoneE164: { businessId: input.businessId, phoneE164: phone } }
        })
      : Promise.resolve(null),
    email
      ? client.customerContact.findUnique({
          where: { businessId_email: { businessId: input.businessId, email } }
        })
      : Promise.resolve(null)
  ]);

  if (byPhone && byEmail && byPhone.id !== byEmail.id) {
    // Two existing people, or one person recorded twice. Veyra cannot tell
    // which, and guessing wrong merges two customers' histories.
    throw new AmbiguousContactError(
      "That phone number and email address belong to two different contacts. Merge them by hand, or use one of them.",
      byPhone.id,
      byEmail.id
    );
  }

  const existing = byPhone ?? byEmail;
  const phoneState = input.phoneState ?? "provided";
  const emailState = input.emailState ?? "provided";

  if (existing) {
    return {
      contact: await safeUpdate(
        existing,
        { name, phone, email, phoneState, emailState },
        client
      ),
      outcome: byPhone ? "matched_phone" : "matched_email"
    };
  }

  const contact = await client.customerContact.create({
    data: {
      businessId: input.businessId,
      displayName: name,
      phoneE164: phone,
      email,
      phoneState: phone ? phoneState : "unknown",
      emailState: email ? emailState : "unknown",
      source: input.source
    }
  });
  return { contact, outcome: "created" };
}

/**
 * Adds what is missing and strengthens what is weaker. Never replaces a value
 * that is already there with a different one — that is a correction, and
 * corrections go through updateContact where they are audited.
 */
async function safeUpdate(
  existing: CustomerContact,
  incoming: { name: string | null; phone: string | null; email: string | null; phoneState: ContactVerificationState; emailState: ContactVerificationState },
  client: Prisma.TransactionClient | typeof prisma
): Promise<CustomerContact> {
  const data: Prisma.CustomerContactUpdateInput = {};

  if (incoming.name && !existing.displayName) data.displayName = incoming.name;
  if (incoming.phone && !existing.phoneE164) {
    data.phoneE164 = incoming.phone;
    data.phoneState = incoming.phoneState;
  } else if (incoming.phone && existing.phoneE164 === incoming.phone) {
    const next = strongest(existing.phoneState as ContactVerificationState, incoming.phoneState);
    if (next !== existing.phoneState) data.phoneState = next;
  }
  if (incoming.email && !existing.email) {
    data.email = incoming.email;
    data.emailState = incoming.emailState;
  } else if (incoming.email && existing.email === incoming.email) {
    const next = strongest(existing.emailState as ContactVerificationState, incoming.emailState);
    if (next !== existing.emailState) data.emailState = next;
  }

  if (Object.keys(data).length === 0) return existing;
  return client.customerContact.update({ where: { id: existing.id }, data });
}

/**
 * An operator correcting a contact. Unlike safeUpdate this may replace a
 * value — that is the point — but a corrected value is only ever "provided",
 * because someone retyping a number does not prove it.
 */
export async function updateContact(params: {
  businessId: string;
  contactId: string;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  emailTransactionalAllowed?: boolean;
  defaultCountry?: string | null;
}): Promise<CustomerContact> {
  // Scoped by businessId as well as id: an id from another tenant finds
  // nothing rather than editing someone else's customer.
  const existing = await prisma.customerContact.findFirst({
    where: { id: params.contactId, businessId: params.businessId }
  });
  if (!existing) throw new InvalidContactError("No such contact for this business.", "none");

  const data: Prisma.CustomerContactUpdateInput = {};

  if (params.name !== undefined) data.displayName = params.name?.trim() || null;
  if (params.emailTransactionalAllowed !== undefined) {
    data.emailTransactionalAllowed = params.emailTransactionalAllowed;
  }

  if (params.phone !== undefined) {
    if (params.phone === null || params.phone === "") {
      data.phoneE164 = null;
      data.phoneState = "unknown";
      data.phoneVerifiedAt = null;
    } else {
      let phone: string;
      try {
        phone = toE164(params.phone, { defaultCountry: params.defaultCountry });
      } catch (error) {
        throw new InvalidContactError(
          error instanceof InvalidPhoneNumberError ? error.message : "That phone number is not usable.",
          "phone"
        );
      }
      if (phone !== existing.phoneE164) {
        data.phoneE164 = phone;
        // A retyped number is claimed, not proven.
        data.phoneState = "provided";
        data.phoneVerifiedAt = null;
      }
    }
  }

  if (params.email !== undefined) {
    if (params.email === null || params.email === "") {
      data.email = null;
      data.emailState = "unknown";
      data.emailVerifiedAt = null;
    } else {
      const email = normalizeEmail(params.email);
      if (email !== existing.email) {
        data.email = email;
        data.emailState = "provided";
        data.emailVerifiedAt = null;
      }
    }
  }

  const phoneAfter = "phoneE164" in data ? (data.phoneE164 as string | null) : existing.phoneE164;
  const emailAfter = "email" in data ? (data.email as string | null) : existing.email;
  if (!phoneAfter && !emailAfter) {
    throw new InvalidContactError("A contact needs a phone number or an email address.", "none");
  }

  if (Object.keys(data).length === 0) return existing;
  return prisma.customerContact.update({ where: { id: existing.id }, data });
}

/** Attaches a contact to the records that should point at it. */
export async function linkContact(params: {
  contactId: string;
  conversationId?: string | null;
  appointmentId?: string | null;
  callSessionId?: string | null;
  tx?: Prisma.TransactionClient;
}): Promise<void> {
  const client = params.tx ?? prisma;
  if (params.conversationId) {
    await client.conversation.update({
      where: { id: params.conversationId },
      data: { customerContactId: params.contactId }
    });
  }
  if (params.appointmentId) {
    await client.appointment.update({
      where: { id: params.appointmentId },
      data: { customerContactId: params.contactId }
    });
  }
  if (params.callSessionId) {
    await client.callSession.update({
      where: { id: params.callSessionId },
      data: { customerContactId: params.contactId }
    });
  }
}
