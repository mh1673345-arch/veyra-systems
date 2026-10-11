import {
  type BusyInterval,
  type CalendarCredentials,
  type CalendarProvider,
  CalendarProviderError,
  type CalendarSummary,
  type CreateEventParams,
  type ProviderEvent,
  type UpdateEventParams
} from "../types.js";

/**
 * Google Calendar, over the REST API with `fetch` — no vendor SDK, so nothing
 * Google-shaped leaks past this file.
 *
 * Idempotency: Google lets the client choose an event id, and rejects a second
 * insert of the same id with 409. Veyra's booking key *is* the event id, so a
 * retried create can never produce a duplicate appointment; the service treats
 * 409 as "already created".
 *
 * NOTE: as of this phase no Google credentials have been configured, so this
 * class has not been exercised against the live API — see the README.
 */

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const REQUEST_TIMEOUT_MS = 10_000;

export const GOOGLE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly"
];

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** OAuth client configuration, or null when Google is not configured at all. */
export function googleOAuthConfig(env: NodeJS.ProcessEnv = process.env): GoogleOAuthConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  // Externally configurable so production points at its own domain.
  const redirectUri = env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

function classify(status: number, body: string): CalendarProviderError {
  if (status === 401 || status === 403) {
    return new CalendarProviderError("auth", "Google rejected the calendar credentials.", status);
  }
  if (status === 409) {
    return new CalendarProviderError("duplicate", "This event already exists in Google Calendar.", status);
  }
  if (status === 404) {
    return new CalendarProviderError("not_found", "The calendar or event no longer exists.", status);
  }
  if (status === 429 || status >= 500) {
    return new CalendarProviderError("unavailable", `Google Calendar is unavailable (${status}).`, status);
  }
  // Body is included for the server log only; callers surface their own text.
  return new CalendarProviderError("rejected", `Google Calendar rejected the request (${status}): ${body.slice(0, 200)}`, status);
}

async function googleFetch(
  url: string,
  init: RequestInit & { accessToken?: string }
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init.headers ?? {}),
        ...(init.accessToken ? { Authorization: `Bearer ${init.accessToken}` } : {})
      }
    });
  } catch (err) {
    // Network failure or timeout: availability is unknown, never "free".
    const aborted = err instanceof Error && (err.name === "AbortError" || controller.signal.aborted);
    throw new CalendarProviderError(
      aborted ? "unavailable" : "unavailable",
      aborted ? "Google Calendar did not respond in time." : "Could not reach Google Calendar."
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw classify(response.status, await response.text().catch(() => ""));
  }
  if (response.status === 204) return {};
  return response.json();
}

function parseTime(value: unknown): Date {
  const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const iso = (raw.dateTime ?? raw.date) as string | undefined;
  return new Date(iso ?? 0);
}

function toProviderEvent(raw: Record<string, unknown>, calendarId: string): ProviderEvent {
  const extended = (raw.extendedProperties as Record<string, Record<string, string>> | undefined)?.private;
  return {
    id: String(raw.id ?? ""),
    calendarId,
    start: parseTime(raw.start),
    end: parseTime(raw.end),
    status: raw.status === "cancelled" ? "cancelled" : "confirmed",
    summary: typeof raw.summary === "string" ? raw.summary : null,
    bookingKey: extended?.veyraBookingKey ?? null
  };
}

export class GoogleCalendarProvider implements CalendarProvider {
  readonly name = "google" as const;

  constructor(private readonly config: GoogleOAuthConfig) {}

  async refreshCredentials(credentials: CalendarCredentials): Promise<CalendarCredentials> {
    if (!credentials.refreshToken) {
      throw new CalendarProviderError("auth", "No refresh token is stored for this connection.");
    }
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: "refresh_token"
    });
    const json = (await googleFetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    })) as Record<string, unknown>;

    const accessToken = typeof json.access_token === "string" ? json.access_token : null;
    if (!accessToken) throw new CalendarProviderError("auth", "Google returned no access token.");
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;

    return {
      accessToken,
      // Google only returns a refresh token on first consent; keep the old one.
      refreshToken: (typeof json.refresh_token === "string" ? json.refresh_token : null) ?? credentials.refreshToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000)
    };
  }

  /** Exchanges an authorization code for tokens. Used only by the OAuth callback. */
  async exchangeCode(code: string): Promise<CalendarCredentials & { scope: string | null }> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: this.config.redirectUri
    });
    const json = (await googleFetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    })) as Record<string, unknown>;

    const accessToken = typeof json.access_token === "string" ? json.access_token : null;
    if (!accessToken) throw new CalendarProviderError("auth", "Google returned no access token.");
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;

    return {
      accessToken,
      refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
      scope: typeof json.scope === "string" ? json.scope : null
    };
  }

  /** The consent URL an operator is sent to. `state` is validated on the way back. */
  authorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: GOOGLE_OAUTH_SCOPES.join(" "),
      // Needed for a refresh token, and to re-prompt if one was never issued.
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async listCalendars(credentials: CalendarCredentials): Promise<CalendarSummary[]> {
    const json = (await googleFetch(`${CALENDAR_API}/users/me/calendarList?maxResults=100`, {
      accessToken: credentials.accessToken
    })) as { items?: Record<string, unknown>[] };

    return (json.items ?? []).map((item) => ({
      id: String(item.id ?? ""),
      name: String(item.summaryOverride ?? item.summary ?? item.id ?? "Calendar"),
      timezone: typeof item.timeZone === "string" ? item.timeZone : null,
      primary: item.primary === true,
      // Only owner/writer roles can hold appointments.
      writable: item.accessRole === "owner" || item.accessRole === "writer"
    }));
  }

  async getBusy(
    credentials: CalendarCredentials,
    params: { calendarId: string; from: Date; to: Date }
  ): Promise<BusyInterval[]> {
    const json = (await googleFetch(`${CALENDAR_API}/freeBusy`, {
      method: "POST",
      accessToken: credentials.accessToken,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timeMin: params.from.toISOString(),
        timeMax: params.to.toISOString(),
        items: [{ id: params.calendarId }]
      })
    })) as { calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> };

    const calendar = json.calendars?.[params.calendarId];
    if (!calendar || calendar.errors?.length) {
      // A calendar-level error means we do not know what is busy.
      throw new CalendarProviderError("unavailable", "Google did not return free/busy for this calendar.");
    }
    return (calendar.busy ?? []).map((interval) => ({
      start: new Date(interval.start),
      end: new Date(interval.end)
    }));
  }

  async createEvent(
    credentials: CalendarCredentials,
    params: CreateEventParams
  ): Promise<ProviderEvent> {
    const json = (await googleFetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(params.calendarId)}/events`,
      {
        method: "POST",
        accessToken: credentials.accessToken,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Client-chosen id: this is what makes create idempotent.
          id: params.bookingKey,
          summary: params.summary,
          description: params.description,
          start: { dateTime: params.start.toISOString(), timeZone: params.timezone },
          end: { dateTime: params.end.toISOString(), timeZone: params.timezone },
          extendedProperties: { private: { veyraBookingKey: params.bookingKey } }
        })
      }
    )) as Record<string, unknown>;

    return toProviderEvent(json, params.calendarId);
  }

  async updateEvent(
    credentials: CalendarCredentials,
    params: UpdateEventParams
  ): Promise<ProviderEvent> {
    const json = (await googleFetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(params.calendarId)}/events/${encodeURIComponent(params.eventId)}`,
      {
        method: "PATCH",
        accessToken: credentials.accessToken,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start: { dateTime: params.start.toISOString(), timeZone: params.timezone },
          end: { dateTime: params.end.toISOString(), timeZone: params.timezone }
        })
      }
    )) as Record<string, unknown>;

    return toProviderEvent(json, params.calendarId);
  }

  async cancelEvent(
    credentials: CalendarCredentials,
    params: { calendarId: string; eventId: string }
  ): Promise<void> {
    await googleFetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(params.calendarId)}/events/${encodeURIComponent(params.eventId)}`,
      { method: "DELETE", accessToken: credentials.accessToken }
    );
  }

  async findEvent(
    credentials: CalendarCredentials,
    params: { calendarId: string; eventId: string }
  ): Promise<ProviderEvent | null> {
    try {
      const json = (await googleFetch(
        `${CALENDAR_API}/calendars/${encodeURIComponent(params.calendarId)}/events/${encodeURIComponent(params.eventId)}`,
        { accessToken: credentials.accessToken }
      )) as Record<string, unknown>;
      return toProviderEvent(json, params.calendarId);
    } catch (err) {
      if (err instanceof CalendarProviderError && err.kind === "not_found") return null;
      throw err;
    }
  }
}
