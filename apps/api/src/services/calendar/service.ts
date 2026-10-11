import { randomBytes } from "node:crypto";
import type { CalendarConnection, Service as ServiceRow } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { decryptSecret, encryptOptional, encryptSecret } from "../crypto/secretBox.js";
import { calendarProviderFor } from "./registry.js";
import { accessFor } from "../access/accessService.js";
import { type Entitlement, type PlanCode, lowestPlanWith } from "@veyra/shared";
import {
  type BookingRules,
  candidateSlots,
  checkBookingRules,
  formatLocal,
  overlaps
} from "./rules.js";
import {
  type BusyInterval,
  type CalendarCredentials,
  type CalendarProvider,
  CalendarProviderError,
  type CalendarSummary,
  type ProviderEvent
} from "./types.js";

/**
 * CalendarService — the only entry point to calendar behaviour.
 *
 * Routes, the action executor and the web app call this; none of them may
 * touch a provider. Three independent conditions gate everything live:
 *
 *   subscription entitlement  (what the business has paid for — AccessService)
 *   AND capability flag       (what the business has switched on)
 *   AND a healthy connection  (what is actually wired up)
 *
 * If any is false, Veyra stays booking-request-only. A configuration flag can
 * never grant what the plan does not include, and nothing here names a plan.
 */

export type AvailabilityStatus =
  | "available"
  | "unavailable"
  | "outside_business_hours"
  | "too_soon"
  | "too_far"
  | "calendar_unavailable"
  | "requires_manual_review";

export interface AvailabilitySlot {
  start: Date;
  end: Date;
}

export interface AvailabilityResult {
  status: AvailabilityStatus;
  timezone: string;
  slot?: AvailabilitySlot;
  /** Operator-facing detail. Never the caller-facing sentence. */
  detail?: string;
  alternatives: AvailabilitySlot[];
}

export interface CalendarStatus {
  /** The subscription includes live calendar booking. */
  entitled: boolean;
  /** Lowest plan that includes it, for the Console's locked state. */
  requiredPlan: PlanCode | null;
  /** Per-operation entitlements, so each boundary can be checked on its own. */
  entitlements: Record<CalendarEntitlement, boolean>;
  /** The business's own capability flag (configuration, not payment). */
  capabilityEnabled: boolean;
  connection: {
    provider: string;
    status: string;
    statusDetail: string | null;
    selectedCalendarId: string | null;
    selectedCalendarName: string | null;
    connectedAt: Date;
    calendarTimezone: string | null;
  } | null;
  /** True only when entitled AND the capability is on AND the connection can be used. */
  live: boolean;
  timezone: string;
}

export type CalendarEntitlement = Extract<
  Entitlement,
  "calendar_availability" | "calendar_booking" | "calendar_reschedule" | "calendar_cancellation"
>;

const CALENDAR_ENTITLEMENTS: CalendarEntitlement[] = [
  "calendar_availability",
  "calendar_booking",
  "calendar_reschedule",
  "calendar_cancellation"
];

export class CalendarServiceError extends Error {
  constructor(
    readonly code: "not_connected" | "not_enabled" | "not_entitled" | "invalid_state" | "provider",
    message: string
  ) {
    super(message);
    this.name = "CalendarServiceError";
  }
}

/* ------------------------------------------------------------------ *
 * Booking keys
 * ------------------------------------------------------------------ */

/** Base32hex, which is the only alphabet Google accepts in an event id. */
const BOOKING_KEY_ALPHABET = "0123456789abcdefghijklmnopqrstuv";

/**
 * Marker so a Veyra-created event is recognisable by its id alone. It cannot
 * be the word "veyra": base32hex stops at "v", and a single "y" is enough for
 * Google to reject the whole create with "Invalid resource id value" — which
 * is exactly what a real calendar did the first time one of these keys left
 * the building.
 */
const BOOKING_KEY_PREFIX = "vra";

/** The full shape Google will accept: base32hex only, 5-1024 characters. */
export const BOOKING_KEY_PATTERN = /^[0-9a-v]{5,1024}$/;

/**
 * A booking key is the stable identity of one booking's calendar event. It is
 * used verbatim as the provider event id, so retrying a create cannot produce a
 * second event.
 */
export function newBookingKey(): string {
  const bytes = randomBytes(20);
  let key = BOOKING_KEY_PREFIX;
  for (const byte of bytes) key += BOOKING_KEY_ALPHABET[byte % 32];
  return key;
}

/* ------------------------------------------------------------------ *
 * Connection and status
 * ------------------------------------------------------------------ */

const USABLE_STATUSES = new Set(["connected"]);

export async function getConnection(businessId: string): Promise<CalendarConnection | null> {
  return prisma.calendarConnection.findFirst({
    where: { businessId, status: { not: "disconnected" } },
    orderBy: { connectedAt: "desc" }
  });
}

export async function calendarStatus(businessId: string): Promise<CalendarStatus> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { capCalendarBooking: true, timezone: true }
  });
  if (!business) throw new CalendarServiceError("invalid_state", "Business not found.");

  const connection = await getConnection(businessId);
  const usable =
    connection !== null &&
    USABLE_STATUSES.has(connection.status) &&
    connection.selectedCalendarId !== null;

  const access = await accessFor(businessId);
  const entitlements = Object.fromEntries(
    CALENDAR_ENTITLEMENTS.map((entitlement) => [entitlement, access.entitlements.has(entitlement)])
  ) as Record<CalendarEntitlement, boolean>;
  const entitled = entitlements.calendar_booking;

  return {
    entitled,
    requiredPlan: lowestPlanWith("calendar_booking"),
    entitlements,
    capabilityEnabled: business.capCalendarBooking,
    connection: connection
      ? {
          provider: connection.provider,
          status: connection.status,
          statusDetail: connection.statusDetail,
          selectedCalendarId: connection.selectedCalendarId,
          selectedCalendarName: connection.selectedCalendarName,
          connectedAt: connection.connectedAt,
          calendarTimezone: connection.timezone
        }
      : null,
    // Entitlement AND configuration AND health. A stored, healthy connection
    // on a downgraded business is kept but not live; upgrading makes it live
    // again without reconnecting.
    live: entitled && business.capCalendarBooking && usable,
    timezone: business.timezone
  };
}

/** Decrypts credentials, refreshing the access token when it is close to expiry. */
async function credentialsFor(
  connection: CalendarConnection,
  provider: CalendarProvider
): Promise<CalendarCredentials> {
  if (!connection.accessTokenEnc) {
    throw new CalendarServiceError("not_connected", "This calendar connection has no stored credentials.");
  }

  let credentials: CalendarCredentials = {
    accessToken: decryptSecret(connection.accessTokenEnc),
    refreshToken: connection.refreshTokenEnc ? decryptSecret(connection.refreshTokenEnc) : null,
    expiresAt: connection.tokenExpiresAt
  };

  const expiringSoon =
    credentials.expiresAt !== null && credentials.expiresAt.getTime() - Date.now() < 60_000;

  if (expiringSoon && provider.refreshCredentials && credentials.refreshToken) {
    try {
      credentials = await provider.refreshCredentials(credentials);
      await prisma.calendarConnection.update({
        where: { id: connection.id },
        data: {
          accessTokenEnc: encryptSecret(credentials.accessToken),
          refreshTokenEnc: encryptOptional(credentials.refreshToken) ?? connection.refreshTokenEnc,
          tokenExpiresAt: credentials.expiresAt,
          status: "connected",
          statusDetail: null
        }
      });
    } catch (err) {
      if (err instanceof CalendarProviderError && err.kind === "auth") {
        await markNeedsReauth(connection.id, "Google rejected the stored refresh token.");
      }
      throw err;
    }
  }

  return credentials;
}

export async function markNeedsReauth(connectionId: string, detail: string): Promise<void> {
  await prisma.calendarConnection.update({
    where: { id: connectionId },
    data: { status: "needs_reauth", statusDetail: detail }
  });
}

async function markError(connectionId: string, detail: string): Promise<void> {
  await prisma.calendarConnection.update({
    where: { id: connectionId },
    data: { status: "error", statusDetail: detail.slice(0, 300), lastCheckedAt: new Date() }
  });
}

/** Resolves the live provider + credentials, or explains why it isn't live. */
async function liveConnection(businessId: string): Promise<{
  connection: CalendarConnection;
  provider: CalendarProvider;
  credentials: CalendarCredentials;
  calendarId: string;
}> {
  const status = await calendarStatus(businessId);
  if (!status.entitled) {
    throw new CalendarServiceError("not_entitled", "The subscription does not include live calendar booking.");
  }
  if (!status.capabilityEnabled) {
    throw new CalendarServiceError("not_enabled", "Calendar booking is not enabled for this business.");
  }
  const connection = await getConnection(businessId);
  if (!connection || !USABLE_STATUSES.has(connection.status)) {
    throw new CalendarServiceError("not_connected", "No healthy calendar connection.");
  }
  if (!connection.selectedCalendarId) {
    throw new CalendarServiceError("not_connected", "No calendar has been selected yet.");
  }
  const provider = calendarProviderFor(connection.provider);
  const credentials = await credentialsFor(connection, provider);
  return { connection, provider, credentials, calendarId: connection.selectedCalendarId };
}

/**
 * The stored connection, without the plan/capability checks liveConnection
 * applies. Used for exactly one thing: removing an event Veyra itself created
 * while the business was on a plan that included calendar booking (see
 * cancelCalendarBooking). It still needs a healthy stored connection — nothing
 * is reconnected or re-authorised here.
 */
async function storedConnection(businessId: string): Promise<{
  connection: CalendarConnection;
  provider: CalendarProvider;
  credentials: CalendarCredentials;
}> {
  const connection = await getConnection(businessId);
  if (!connection || !USABLE_STATUSES.has(connection.status)) {
    throw new CalendarServiceError("not_connected", "No healthy calendar connection.");
  }
  const provider = calendarProviderFor(connection.provider);
  const credentials = await credentialsFor(connection, provider);
  return { connection, provider, credentials };
}

/** Records provider failures against the connection so the Console can show them. */
async function handleProviderError(connectionId: string, err: unknown): Promise<void> {
  if (!(err instanceof CalendarProviderError)) return;
  if (err.kind === "auth") await markNeedsReauth(connectionId, "The calendar provider rejected the credentials.");
  else if (err.kind === "unavailable") await markError(connectionId, err.message);
}

/* ------------------------------------------------------------------ *
 * Rules
 * ------------------------------------------------------------------ */

export async function bookingRulesFor(businessId: string): Promise<BookingRules> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      timezone: true,
      minNoticeMinutes: true,
      maxHorizonDays: true,
      bufferBeforeMinutes: true,
      bufferAfterMinutes: true,
      slotIntervalMinutes: true,
      businessHours: { select: { dayOfWeek: true, opensMinute: true, closesMinute: true, bookable: true } }
    }
  });
  if (!business) throw new CalendarServiceError("invalid_state", "Business not found.");

  return {
    timezone: business.timezone,
    minNoticeMinutes: business.minNoticeMinutes,
    maxHorizonDays: business.maxHorizonDays,
    bufferBeforeMinutes: business.bufferBeforeMinutes,
    bufferAfterMinutes: business.bufferAfterMinutes,
    slotIntervalMinutes: business.slotIntervalMinutes,
    hours: business.businessHours
  };
}

async function resolveService(
  businessId: string,
  params: { serviceId?: string | null; serviceName?: string | null }
): Promise<ServiceRow | null> {
  if (params.serviceId) {
    return prisma.service.findFirst({ where: { id: params.serviceId, businessId } });
  }
  if (params.serviceName) {
    const services = await prisma.service.findMany({ where: { businessId } });
    const needle = params.serviceName.toLowerCase();
    return (
      services.find((service) => service.name.toLowerCase() === needle) ??
      services.find((service) => service.name.toLowerCase().includes(needle)) ??
      null
    );
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Availability
 * ------------------------------------------------------------------ */

export interface CheckAvailabilityParams {
  businessId: string;
  serviceId?: string | null;
  serviceName?: string | null;
  startTime: Date;
  now?: Date;
  /** How many alternatives to look for when the requested time doesn't work. */
  alternativeCount?: number;
}

/**
 * The authoritative availability answer. Structured — callers must never parse
 * prose to decide what happened.
 */
export async function checkAvailability(params: CheckAvailabilityParams): Promise<AvailabilityResult> {
  const now = params.now ?? new Date();
  const rules = await bookingRulesFor(params.businessId);
  const status = await calendarStatus(params.businessId);

  if (!status.live || !status.entitlements.calendar_availability) {
    return {
      status: "requires_manual_review",
      timezone: rules.timezone,
      // Operator-facing only; the caller is never told about the business's plan.
      detail: !status.entitled || !status.entitlements.calendar_availability
        ? "Live calendar availability is not included in this business's subscription."
        : status.capabilityEnabled
          ? "Calendar booking is enabled but no healthy calendar connection is available."
          : "Calendar booking is not enabled for this business.",
      alternatives: []
    };
  }

  const service = await resolveService(params.businessId, params);
  const duration = service?.durationMinutes ?? null;
  if (!duration) {
    // No configured duration means no honest slot arithmetic. Never guessed.
    return {
      status: "requires_manual_review",
      timezone: rules.timezone,
      detail: service
        ? `Service "${service.name}" has no configured duration.`
        : "No service was identified for this request.",
      alternatives: []
    };
  }

  const ruleCheck = checkBookingRules({ rules, start: params.startTime, durationMinutes: duration, now });
  if (!ruleCheck.ok) {
    const status =
      ruleCheck.violation === "too_soon"
        ? "too_soon"
        : ruleCheck.violation === "too_far"
          ? "too_far"
          : ruleCheck.violation === "outside_business_hours"
            ? "outside_business_hours"
            : "requires_manual_review";

    const alternatives =
      status === "too_far"
        ? []
        : await safeAlternatives({
            businessId: params.businessId,
            rules,
            duration,
            now,
            count: params.alternativeCount ?? 3
          });

    return { status, timezone: rules.timezone, alternatives, detail: ruleCheck.violation };
  }

  // Rules allow it — now, and only now, ask the calendar.
  let busy: BusyInterval[];
  try {
    busy = await busyBetween(params.businessId, ruleCheck.window!.start, ruleCheck.window!.end);
  } catch (err) {
    // Provider trouble must never be reported as "free".
    return {
      status: "calendar_unavailable",
      timezone: rules.timezone,
      detail: err instanceof Error ? err.message : "The calendar could not be reached.",
      alternatives: []
    };
  }

  const clash = busy.some((interval) =>
    overlaps(ruleCheck.window!.start, ruleCheck.window!.end, interval.start, interval.end)
  );

  if (!clash) {
    return {
      status: "available",
      timezone: rules.timezone,
      slot: { start: ruleCheck.appointment!.start, end: ruleCheck.appointment!.end },
      alternatives: []
    };
  }

  return {
    status: "unavailable",
    timezone: rules.timezone,
    alternatives: await safeAlternatives({
      businessId: params.businessId,
      rules,
      duration,
      now,
      count: params.alternativeCount ?? 3,
      after: params.startTime
    })
  };
}

/** Free/busy for a window, through the live connection. */
export async function busyBetween(businessId: string, from: Date, to: Date): Promise<BusyInterval[]> {
  const { connection, provider, credentials, calendarId } = await liveConnection(businessId);
  try {
    const busy = await provider.getBusy(credentials, { calendarId, from, to });
    await prisma.calendarConnection.update({
      where: { id: connection.id },
      data: { lastCheckedAt: new Date() }
    });
    return busy;
  } catch (err) {
    await handleProviderError(connection.id, err);
    throw err;
  }
}

/**
 * Real alternatives only: generated from the business rules and then filtered
 * against actual free/busy. If the calendar can't be reached, none are offered
 * rather than inventing any.
 */
export async function findAlternativeSlots(params: {
  businessId: string;
  rules: BookingRules;
  durationMinutes: number;
  now: Date;
  count: number;
  /** The time the caller asked for; alternatives are the free slots closest to it. */
  near?: Date;
}): Promise<AvailabilitySlot[]> {
  // Search from the requested day (or today), so same-day options either side
  // of the requested time are considered.
  const from = params.near && params.near > params.now ? params.near : params.now;
  const slots = candidateSlots({
    rules: params.rules,
    durationMinutes: params.durationMinutes,
    now: params.now,
    from
  });
  if (slots.length === 0) return [];

  const searchEnd = slots[slots.length - 1].window.end;
  const busy = await busyBetween(params.businessId, slots[0].window.start, searchEnd);

  const free = slots
    .filter(
      (slot) =>
        !busy.some((interval) => overlaps(slot.window.start, slot.window.end, interval.start, interval.end))
    )
    .map((slot) => ({ start: slot.start, end: slot.end }));

  // "Nearest" must be true: rank by distance from the requested time (later
  // wins a tie), then present the chosen few in chronological order.
  const anchor = (params.near ?? params.now).getTime();
  return free
    .sort((a, b) => {
      const distance = Math.abs(a.start.getTime() - anchor) - Math.abs(b.start.getTime() - anchor);
      return distance !== 0 ? distance : b.start.getTime() - a.start.getTime();
    })
    .slice(0, params.count)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

async function safeAlternatives(params: {
  businessId: string;
  rules: BookingRules;
  duration: number;
  now: Date;
  count: number;
  after?: Date;
}): Promise<AvailabilitySlot[]> {
  try {
    return await findAlternativeSlots({
      businessId: params.businessId,
      rules: params.rules,
      durationMinutes: params.duration,
      now: params.now,
      count: params.count,
      near: params.after
    });
  } catch {
    // Alternatives are a courtesy; never fail the whole answer for them, and
    // never fabricate them.
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Booking: create, cancel, reschedule
 * ------------------------------------------------------------------ */

export interface ConfirmBookingResult {
  status: "confirmed" | "unavailable" | "calendar_unavailable" | "needs_review";
  event?: ProviderEvent;
  detail?: string;
}

/**
 * Creates the calendar event for a held booking. Idempotent: the booking key is
 * the provider event id, so a retry after an ambiguous response finds the
 * existing event instead of creating a second one.
 */
export async function createCalendarEvent(params: {
  businessId: string;
  bookingKey: string;
  summary: string;
  description: string;
  start: Date;
  end: Date;
}): Promise<{ event: ProviderEvent; calendarId: string; provider: string }> {
  const { connection, provider, credentials, calendarId } = await liveConnection(params.businessId);
  const rules = await bookingRulesFor(params.businessId);

  const request = {
    calendarId,
    bookingKey: params.bookingKey,
    summary: params.summary,
    description: params.description,
    start: params.start,
    end: params.end,
    timezone: rules.timezone
  };

  try {
    const event = await provider.createEvent(credentials, request);
    return { event, calendarId, provider: connection.provider };
  } catch (err) {
    if (err instanceof CalendarProviderError && (err.kind === "duplicate" || err.kind === "ambiguous")) {
      // Either the provider says this id already exists, or the outcome was
      // unknown. Both are resolved by looking, never by creating again.
      const existing = await provider
        .findEvent(credentials, { calendarId, eventId: params.bookingKey })
        .catch(() => null);
      if (existing && existing.status === "confirmed") {
        return { event: existing, calendarId, provider: connection.provider };
      }
    }
    await handleProviderError(connection.id, err);
    throw err;
  }
}

/**
 * Looks for an event already created under this booking key. This is how a
 * retry after an unrecorded success is resolved: the event is adopted rather
 * than created again (and rather than being mistaken for someone else's
 * booking occupying the slot).
 */
export async function findEventByBookingKey(params: {
  businessId: string;
  bookingKey: string;
}): Promise<ProviderEvent | null> {
  const { connection, provider, credentials, calendarId } = await liveConnection(params.businessId);
  try {
    return await provider.findEvent(credentials, { calendarId, eventId: params.bookingKey });
  } catch (err) {
    await handleProviderError(connection.id, err);
    throw err;
  }
}

export async function cancelCalendarEvent(params: {
  businessId: string;
  calendarId: string;
  eventId: string;
  /** Only for a Veyra-created event on a plan that has since lapsed. */
  lapsedPlanCleanup?: boolean;
}): Promise<void> {
  const { connection, provider, credentials } = params.lapsedPlanCleanup
    ? await storedConnection(params.businessId)
    : await liveConnection(params.businessId);
  try {
    await provider.cancelEvent(credentials, { calendarId: params.calendarId, eventId: params.eventId });
  } catch (err) {
    // An event that is already gone is a successful cancellation.
    if (err instanceof CalendarProviderError && err.kind === "not_found") return;
    await handleProviderError(connection.id, err);
    throw err;
  }
}

export async function updateCalendarEvent(params: {
  businessId: string;
  calendarId: string;
  eventId: string;
  start: Date;
  end: Date;
}): Promise<ProviderEvent> {
  const { connection, provider, credentials } = await liveConnection(params.businessId);
  const rules = await bookingRulesFor(params.businessId);
  try {
    return await provider.updateEvent(credentials, {
      calendarId: params.calendarId,
      eventId: params.eventId,
      start: params.start,
      end: params.end,
      timezone: rules.timezone
    });
  } catch (err) {
    await handleProviderError(connection.id, err);
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * Connection management (used by the OAuth routes and the Console)
 * ------------------------------------------------------------------ */

export async function listAvailableCalendars(businessId: string): Promise<CalendarSummary[]> {
  const connection = await getConnection(businessId);
  if (!connection) throw new CalendarServiceError("not_connected", "This business has no calendar connection.");
  const provider = calendarProviderFor(connection.provider);
  const credentials = await credentialsFor(connection, provider);
  try {
    return await provider.listCalendars(credentials);
  } catch (err) {
    await handleProviderError(connection.id, err);
    throw err;
  }
}

export async function selectCalendar(
  businessId: string,
  calendarId: string
): Promise<CalendarStatus> {
  const connection = await getConnection(businessId);
  if (!connection) throw new CalendarServiceError("not_connected", "This business has no calendar connection.");

  const calendars = await listAvailableCalendars(businessId);
  const chosen = calendars.find((calendar) => calendar.id === calendarId);
  if (!chosen) throw new CalendarServiceError("invalid_state", "That calendar is not available on this connection.");
  if (!chosen.writable) {
    throw new CalendarServiceError("invalid_state", "Veyra needs write access to hold appointments in that calendar.");
  }

  await prisma.calendarConnection.update({
    where: { id: connection.id },
    data: {
      selectedCalendarId: chosen.id,
      selectedCalendarName: chosen.name,
      timezone: chosen.timezone,
      status: "connected",
      statusDetail: null
    }
  });
  return calendarStatus(businessId);
}

export async function disconnectCalendar(businessId: string): Promise<void> {
  const connection = await getConnection(businessId);
  if (!connection) return;
  // Credentials are destroyed, not just flagged.
  await prisma.calendarConnection.update({
    where: { id: connection.id },
    data: {
      status: "disconnected",
      disconnectedAt: new Date(),
      accessTokenEnc: null,
      refreshTokenEnc: null,
      tokenExpiresAt: null,
      selectedCalendarId: null,
      selectedCalendarName: null,
      statusDetail: null
    }
  });
}

/** Stores (or replaces) a connection's credentials after a successful OAuth exchange. */
export async function saveConnection(params: {
  businessId: string;
  provider: string;
  userId: string;
  credentials: CalendarCredentials;
  scope?: string | null;
  externalAccountId?: string | null;
}): Promise<CalendarConnection> {
  const data = {
    provider: params.provider,
    externalAccountId: params.externalAccountId ?? null,
    scope: params.scope ?? null,
    accessTokenEnc: encryptSecret(params.credentials.accessToken),
    refreshTokenEnc: encryptOptional(params.credentials.refreshToken),
    tokenExpiresAt: params.credentials.expiresAt,
    status: "connected",
    statusDetail: null,
    connectedByUserId: params.userId,
    connectedAt: new Date(),
    disconnectedAt: null
  };

  return prisma.calendarConnection.upsert({
    where: { businessId_provider: { businessId: params.businessId, provider: params.provider } },
    create: { businessId: params.businessId, ...data },
    update: data
  });
}

/** Caller-facing description of a slot, always in the business timezone. */
export function describeSlot(slot: AvailabilitySlot, timezone: string): string {
  return formatLocal(slot.start, timezone);
}
