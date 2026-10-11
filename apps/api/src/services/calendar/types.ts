/**
 * The provider-neutral calendar contract.
 *
 *   CalendarService  ← the only thing application code talks to
 *        ↓
 *   CalendarProvider ← GoogleCalendarProvider, FakeCalendarProvider, later
 *                      MicrosoftCalendarProvider
 *
 * Nothing above this line (routes, the AI responder, the web app) may call a
 * calendar vendor directly, and no vendor SDK type appears in this file.
 */

export type CalendarProviderName = "google" | "fake";

/** Credentials as the service hands them to a provider — already decrypted. */
export interface CalendarCredentials {
  accessToken: string;
  refreshToken: string | null;
  /** Expiry of the access token, when the provider reports one. */
  expiresAt: Date | null;
}

export interface CalendarSummary {
  id: string;
  name: string;
  /** The calendar's own timezone, when the provider reports one. */
  timezone: string | null;
  primary: boolean;
  /** False for calendars the connected account cannot write to. */
  writable: boolean;
}

export interface BusyInterval {
  start: Date;
  end: Date;
}

export interface ProviderEvent {
  id: string;
  calendarId: string;
  start: Date;
  end: Date;
  status: "confirmed" | "cancelled";
  summary: string | null;
  /** The application booking key, when the event carries it. */
  bookingKey: string | null;
}

export interface CreateEventParams {
  calendarId: string;
  /**
   * Stable application identity for this booking. Providers that accept a
   * client-supplied event id use it directly, so a retried create cannot
   * produce a second event.
   */
  bookingKey: string;
  summary: string;
  description: string;
  start: Date;
  end: Date;
  /** IANA timezone the local times were resolved in, for the provider's display. */
  timezone: string;
}

export interface UpdateEventParams {
  calendarId: string;
  eventId: string;
  start: Date;
  end: Date;
  timezone: string;
}

/**
 * Why a provider call failed. The kind drives behaviour, so failures are never
 * classified by parsing a message string:
 *  - unavailable: network/5xx/timeout — availability is unknown, never assume free
 *  - auth:        credentials rejected or revoked — connection needs re-auth
 *  - duplicate:   an event with this id already exists (an idempotent create)
 *  - not_found:   the event or calendar is gone
 *  - ambiguous:   the request may or may not have taken effect
 *  - rejected:    the provider refused the request (bad input, permissions)
 */
export type CalendarFailureKind =
  | "unavailable"
  | "auth"
  | "duplicate"
  | "not_found"
  | "ambiguous"
  | "rejected";

export class CalendarProviderError extends Error {
  constructor(
    readonly kind: CalendarFailureKind,
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "CalendarProviderError";
  }
}

export interface CalendarProvider {
  readonly name: CalendarProviderName;
  /** Calendars the connected account can see. */
  listCalendars(credentials: CalendarCredentials): Promise<CalendarSummary[]>;
  /** Busy intervals in [from, to). Free/busy only — no event contents. */
  getBusy(
    credentials: CalendarCredentials,
    params: { calendarId: string; from: Date; to: Date }
  ): Promise<BusyInterval[]>;
  createEvent(credentials: CalendarCredentials, params: CreateEventParams): Promise<ProviderEvent>;
  updateEvent(credentials: CalendarCredentials, params: UpdateEventParams): Promise<ProviderEvent>;
  cancelEvent(
    credentials: CalendarCredentials,
    params: { calendarId: string; eventId: string }
  ): Promise<void>;
  /** Used to recover from an ambiguous create: did the event land or not? */
  findEvent(
    credentials: CalendarCredentials,
    params: { calendarId: string; eventId: string }
  ): Promise<ProviderEvent | null>;
  /** Exchanges a refresh token for a fresh access token, where supported. */
  refreshCredentials?(credentials: CalendarCredentials): Promise<CalendarCredentials>;
}
