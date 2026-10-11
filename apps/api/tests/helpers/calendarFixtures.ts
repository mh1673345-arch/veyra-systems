import { DateTime } from "luxon";
import { prisma } from "../../src/db/client.js";
import { encryptSecret } from "../../src/services/crypto/secretBox.js";
import { fakeCalendarProvider } from "../../src/services/calendar/registry.js";
import { changePlan } from "../../src/services/access/accessService.js";

/**
 * Fixtures for the calendar tests.
 *
 * Business-flow tests run against the real CalendarService and the real action
 * executor; only the *provider* is swapped for the in-memory fake, which
 * implements the same CalendarProvider contract Google does.
 */

export const TZ = "America/New_York";

export interface CalendarBusinessOptions {
  timezone?: string;
  calendarBooking?: boolean;
  connect?: boolean;
  connectionStatus?: string;
  selectedCalendarId?: string | null;
  minNoticeMinutes?: number;
  maxHorizonDays?: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  slotIntervalMinutes?: number;
  /** Mon-Fri 09:00-17:00 by default. */
  hours?: { dayOfWeek: number; opensMinute: number; closesMinute: number; bookable?: boolean }[];
  serviceDurationMinutes?: number | null;
  namePrefix?: string;
  /**
   * Subscription plan. Defaults to PRO, the lowest plan with live calendar
   * booking, because most calendar tests exercise the live path. null = no
   * subscription at all.
   */
  plan?: "STARTER" | "PRO" | "MAX" | null;
  subscriptionStatus?: "trialing" | "active" | "past_due" | "cancelled" | "expired";
}

export interface CalendarBusinessFixture {
  businessId: string;
  serviceId: string;
  serviceName: string;
  conversationId: string;
  timezone: string;
}

export async function createCalendarBusiness(
  options: CalendarBusinessOptions = {}
): Promise<CalendarBusinessFixture> {
  const timezone = options.timezone ?? TZ;
  const hours: NonNullable<CalendarBusinessOptions["hours"]> =
    options.hours ??
    [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, opensMinute: 9 * 60, closesMinute: 17 * 60 }));

  const business = await prisma.business.create({
    data: {
      name: `${options.namePrefix ?? "Calendar"} Test ${Math.random().toString(36).slice(2, 8)}`,
      capBookingRequests: true,
      capCalendarBooking: options.calendarBooking ?? true,
      capHumanEscalation: true,
      timezone,
      minNoticeMinutes: options.minNoticeMinutes ?? 120,
      maxHorizonDays: options.maxHorizonDays ?? 60,
      bufferBeforeMinutes: options.bufferBeforeMinutes ?? 0,
      bufferAfterMinutes: options.bufferAfterMinutes ?? 0,
      slotIntervalMinutes: options.slotIntervalMinutes ?? 30,
      businessHours: {
        create: hours.map((hour) => ({
          dayOfWeek: hour.dayOfWeek,
          opensMinute: hour.opensMinute,
          closesMinute: hour.closesMinute,
          bookable: hour.bookable ?? true
        }))
      },
      services: {
        create: [
          {
            name: "Teeth whitening",
            description: "In-office whitening.",
            priceLabel: "$250",
            durationMinutes:
              options.serviceDurationMinutes === undefined ? 60 : options.serviceDurationMinutes
          }
        ]
      }
    },
    include: { services: true }
  });

  const plan = options.plan === undefined ? "PRO" : options.plan;
  if (plan) {
    await changePlan({
      businessId: business.id,
      plan,
      status: options.subscriptionStatus ?? "active",
      actorType: "system",
      reason: "test fixture"
    });
  }

  if (options.connect ?? true) {
    await connectFakeCalendar(business.id, {
      status: options.connectionStatus ?? "connected",
      selectedCalendarId:
        options.selectedCalendarId === undefined ? "primary" : options.selectedCalendarId
    });
  }

  const conversation = await prisma.conversation.create({
    data: { businessId: business.id, callerName: "Casey Caller" }
  });

  return {
    businessId: business.id,
    serviceId: business.services[0].id,
    serviceName: business.services[0].name,
    conversationId: conversation.id,
    timezone
  };
}

export async function connectFakeCalendar(
  businessId: string,
  options: { status?: string; selectedCalendarId?: string | null } = {}
): Promise<void> {
  await prisma.calendarConnection.upsert({
    where: { businessId_provider: { businessId, provider: "fake" } },
    create: {
      businessId,
      provider: "fake",
      status: options.status ?? "connected",
      selectedCalendarId:
        options.selectedCalendarId === undefined ? "primary" : options.selectedCalendarId,
      selectedCalendarName: "Demo calendar",
      timezone: "UTC",
      accessTokenEnc: encryptSecret("test-access-token"),
      refreshTokenEnc: encryptSecret("test-refresh-token"),
      tokenExpiresAt: new Date(Date.now() + 60 * 60_000)
    },
    update: {
      status: options.status ?? "connected",
      selectedCalendarId:
        options.selectedCalendarId === undefined ? "primary" : options.selectedCalendarId,
      accessTokenEnc: encryptSecret("test-access-token"),
      disconnectedAt: null
    }
  });
}

/** A fixed, predictable clock: Monday 5 October 2026, 09:00 in the business zone. */
export function at(
  local: string,
  timezone = TZ
): Date {
  const dt = DateTime.fromISO(local, { zone: timezone });
  if (!dt.isValid) throw new Error(`Invalid fixture time "${local}": ${dt.invalidReason}`);
  return dt.toJSDate();
}

export const MONDAY_9AM = () => at("2026-10-05T09:00");

/** Clears every fake-provider event and busy window between tests. */
export function resetFakeCalendar(): void {
  fakeCalendarProvider.reset();
}

export { fakeCalendarProvider };
