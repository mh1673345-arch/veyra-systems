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

/** How the fake provider should misbehave, mirroring real failure kinds. */
export type FailureMode = null | "unavailable" | "auth" | "ambiguous" | "rejected";

/**
 * Deterministic in-memory calendar, used by the automated tests and by the
 * local demo connection (`npm run calendar:dev-connect`). It implements the
 * same CalendarProvider contract as Google, so business-flow tests exercise the
 * real CalendarService rather than a mocked-out one.
 *
 * It is never selectable in production: the provider registry refuses it there.
 */
export class FakeCalendarProvider implements CalendarProvider {
  readonly name = "fake" as const;

  private busy: BusyInterval[] = [];
  private readonly events = new Map<string, ProviderEvent>();
  private failure: FailureMode = null;
  private calendars: CalendarSummary[] = [
    { id: "primary", name: "Demo calendar", timezone: "UTC", primary: true, writable: true },
    { id: "secondary", name: "Treatment room 2", timezone: "UTC", primary: false, writable: true },
    { id: "readonly", name: "Public holidays", timezone: "UTC", primary: false, writable: false }
  ];

  /** Test seam: what the calendar reports as busy. */
  setBusy(intervals: { start: Date; end: Date }[]): void {
    this.busy = intervals.map((interval) => ({ ...interval }));
  }

  /** Test seam: make the next calls fail in a specific, realistic way. */
  setFailure(mode: FailureMode): void {
    this.failure = mode;
  }

  setCalendars(calendars: CalendarSummary[]): void {
    this.calendars = calendars;
  }

  /** Everything the fake calendar currently holds, for assertions. */
  listEvents(): ProviderEvent[] {
    return [...this.events.values()];
  }

  reset(): void {
    this.busy = [];
    this.events.clear();
    this.failure = null;
  }

  private guard(operation: "read" | "write"): void {
    if (!this.failure) return;
    if (this.failure === "unavailable") {
      throw new CalendarProviderError("unavailable", "Fake calendar is unavailable.");
    }
    if (this.failure === "auth") {
      throw new CalendarProviderError("auth", "Fake calendar credentials were rejected.", 401);
    }
    if (this.failure === "ambiguous" && operation === "write") {
      // The write may or may not have landed — exactly the case recovery has to
      // handle. The event *is* stored, but the caller is told nothing useful.
      throw new CalendarProviderError("ambiguous", "Fake calendar timed out after sending.");
    }
    if (this.failure === "rejected" && operation === "write") {
      throw new CalendarProviderError("rejected", "Fake calendar rejected the request.", 400);
    }
  }

  async listCalendars(_credentials: CalendarCredentials): Promise<CalendarSummary[]> {
    this.guard("read");
    return [...this.calendars];
  }

  async getBusy(
    _credentials: CalendarCredentials,
    params: { calendarId: string; from: Date; to: Date }
  ): Promise<BusyInterval[]> {
    this.guard("read");
    const fromEvents = [...this.events.values()]
      .filter((event) => event.status === "confirmed" && event.calendarId === params.calendarId)
      .map((event) => ({ start: event.start, end: event.end }));

    return [...this.busy, ...fromEvents].filter(
      (interval) =>
        interval.start.getTime() < params.to.getTime() && interval.end.getTime() > params.from.getTime()
    );
  }

  async createEvent(
    _credentials: CalendarCredentials,
    params: CreateEventParams
  ): Promise<ProviderEvent> {
    const id = eventIdFor(params.bookingKey);
    const existing = this.events.get(id);
    if (existing && existing.status === "confirmed") {
      // Same booking key, same event: the provider refuses a second copy.
      throw new CalendarProviderError("duplicate", `Event ${id} already exists.`, 409);
    }

    // A provider that is unreachable or refuses never applied the write.
    if (this.failure && this.failure !== "ambiguous") this.guard("write");

    const event: ProviderEvent = {
      id,
      calendarId: params.calendarId,
      start: params.start,
      end: params.end,
      status: "confirmed",
      summary: params.summary,
      bookingKey: params.bookingKey
    };
    // Stored *before* the ambiguous guard, so that failure leaves a real event
    // behind — exactly the situation recovery has to detect.
    this.events.set(id, event);
    this.guard("write");
    return event;
  }

  async updateEvent(
    _credentials: CalendarCredentials,
    params: UpdateEventParams
  ): Promise<ProviderEvent> {
    if (this.failure && this.failure !== "ambiguous") this.guard("write");
    const event = this.events.get(params.eventId);
    if (!event) throw new CalendarProviderError("not_found", `Event ${params.eventId} not found.`, 404);
    const updated: ProviderEvent = { ...event, start: params.start, end: params.end };
    this.events.set(params.eventId, updated);
    this.guard("write");
    return updated;
  }

  async cancelEvent(
    _credentials: CalendarCredentials,
    params: { calendarId: string; eventId: string }
  ): Promise<void> {
    if (this.failure && this.failure !== "ambiguous") this.guard("write");
    const event = this.events.get(params.eventId);
    if (!event) throw new CalendarProviderError("not_found", `Event ${params.eventId} not found.`, 404);
    this.events.set(params.eventId, { ...event, status: "cancelled" });
    this.guard("write");
  }

  async findEvent(
    _credentials: CalendarCredentials,
    params: { calendarId: string; eventId: string }
  ): Promise<ProviderEvent | null> {
    this.guard("read");
    return this.events.get(params.eventId) ?? null;
  }
}

/** Shared with the Google provider: a booking key maps to one event id. */
export function eventIdFor(bookingKey: string): string {
  return bookingKey;
}
