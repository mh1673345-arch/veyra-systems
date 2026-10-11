import { createHash, randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { OpsCalendarSettings } from "@veyra/shared";
import { prisma } from "../db/client.js";
import { HttpError } from "../middleware/errorHandler.js";
import { requireAuth, requireBusinessPermission } from "../middleware/auth.js";
import { roleHasPermission } from "../services/auth/permissions.js";
import { requireCsrfToken } from "../middleware/csrf.js";
import {
  CalendarServiceError,
  calendarStatus,
  disconnectCalendar,
  listAvailableCalendars,
  saveConnection,
  selectCalendar
} from "../services/calendar/service.js";
import { connectableProviders } from "../services/calendar/registry.js";
import { GoogleCalendarProvider, googleOAuthConfig } from "../services/calendar/providers/googleProvider.js";
import { CalendarProviderError } from "../services/calendar/types.js";
import { encryptionConfigured } from "../services/crypto/secretBox.js";
import { requireEntitlement } from "../services/access/accessService.js";

export const calendarRouter = Router();

/**
 * Calendar connection management.
 *
 * Tokens never cross this boundary: the browser sees a connection's status, the
 * selected calendar and the business timezone — never an access or refresh
 * token. Connecting, re-pointing and disconnecting need `calendar:manage`
 * (OWNER/ADMIN); everyone with `settings:read` can see the current state.
 */

/** How long an operator has to finish the consent screen. */
const STATE_TTL_MINUTES = 10;

const selectCalendarSchema = z.object({ calendarId: z.string().min(1) });

function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

async function settingsPayload(businessId: string, canManage: boolean): Promise<OpsCalendarSettings> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      name: true,
      timezone: true,
      minNoticeMinutes: true,
      maxHorizonDays: true,
      bufferBeforeMinutes: true,
      bufferAfterMinutes: true,
      slotIntervalMinutes: true,
      businessHours: { orderBy: { dayOfWeek: "asc" } },
      services: { orderBy: { name: "asc" } }
    }
  });
  if (!business) throw new HttpError(404, "Business not found");

  const status = await calendarStatus(businessId);

  return {
    businessId: business.id,
    businessName: business.name,
    entitled: status.entitled,
    requiredPlan: status.requiredPlan,
    calendarBookingEnabled: status.capabilityEnabled,
    live: status.live,
    timezone: business.timezone,
    connection: status.connection
      ? {
          provider: status.connection.provider,
          status: status.connection.status as OpsCalendarSettings["connection"] extends null
            ? never
            : "connected" | "needs_reauth" | "disconnected" | "error",
          statusDetail: status.connection.statusDetail,
          selectedCalendarId: status.connection.selectedCalendarId,
          selectedCalendarName: status.connection.selectedCalendarName,
          calendarTimezone: status.connection.calendarTimezone,
          connectedAt: status.connection.connectedAt.toISOString()
        }
      : null,
    connectableProviders: connectableProviders(),
    canManage,
    bookingRules: {
      minNoticeMinutes: business.minNoticeMinutes,
      maxHorizonDays: business.maxHorizonDays,
      bufferBeforeMinutes: business.bufferBeforeMinutes,
      bufferAfterMinutes: business.bufferAfterMinutes,
      slotIntervalMinutes: business.slotIntervalMinutes,
      hours: business.businessHours.map((hour) => ({
        dayOfWeek: hour.dayOfWeek,
        opensMinute: hour.opensMinute,
        closesMinute: hour.closesMinute,
        bookable: hour.bookable
      }))
    },
    services: business.services.map((service) => ({
      id: service.id,
      name: service.name,
      durationMinutes: service.durationMinutes
    }))
  };
}

/** Current calendar settings for the Console. Read-only, no secrets. */
calendarRouter.get(
  "/ops/businesses/:businessId/calendar",
  requireAuth,
  requireBusinessPermission("settings:read"),
  async (req, res, next) => {
    try {
      const canManage = roleHasPermission(req.membership!.role, "calendar:manage");
      res.json(await settingsPayload(req.params.businessId, canManage));
    } catch (err) {
      next(err);
    }
  }
);

/** Starts the OAuth flow: returns the consent URL and records single-use state. */
calendarRouter.post(
  "/ops/businesses/:businessId/calendar/connect",
  requireAuth,
  requireCsrfToken,
  requireBusinessPermission("calendar:manage"),
  async (req, res, next) => {
    try {
      // Paid boundary first: a Starter business cannot start a connection
      // even by calling this endpoint directly.
      await requireEntitlement(req.params.businessId, "calendar_booking");
      const config = googleOAuthConfig();
      if (!config) {
        throw new HttpError(
          503,
          "Google Calendar is not configured on this server. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI."
        );
      }
      if (!encryptionConfigured()) {
        // Refuse rather than store tokens we cannot protect.
        throw new HttpError(503, "VEYRA_ENCRYPTION_KEY is not configured, so calendar tokens cannot be stored safely.");
      }

      const state = randomBytes(32).toString("base64url");
      await prisma.calendarOAuthState.create({
        data: {
          businessId: req.params.businessId,
          userId: req.auth!.user.id,
          provider: "google",
          // Only the hash is stored, so a leaked database row cannot be replayed.
          stateHash: hashState(state),
          expiresAt: new Date(Date.now() + STATE_TTL_MINUTES * 60_000)
        }
      });

      const provider = new GoogleCalendarProvider(config);
      res.json({ authorizationUrl: provider.authorizationUrl(state), provider: "google" });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * OAuth callback. Deliberately unauthenticated (Google redirects the browser
 * here), so the single-use state is what proves the request is ours: it is
 * matched by hash, must be unexpired and unused, and carries the business and
 * the operator who started the flow.
 */
calendarRouter.get("/calendar/google/callback", async (req, res, next) => {
  try {
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    const consoleUrl = (process.env.VEYRA_WEB_ORIGIN ?? "http://localhost:5173").split(",")[0].trim();

    if (req.query.error) {
      // The operator declined consent — not an error condition for us.
      res.redirect(`${consoleUrl}/dashboard?calendar=declined`);
      return;
    }
    if (!code || !state) throw new HttpError(400, "Missing authorization code or state.");

    const record = await prisma.calendarOAuthState.findUnique({ where: { stateHash: hashState(state) } });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new HttpError(400, "This calendar connection link is invalid or has expired. Start again from the Console.");
    }
    // Single use, marked before the exchange so a replay cannot race it.
    await prisma.calendarOAuthState.update({ where: { id: record.id }, data: { usedAt: new Date() } });

    const config = googleOAuthConfig();
    if (!config) throw new HttpError(503, "Google Calendar is not configured on this server.");

    const provider = new GoogleCalendarProvider(config);
    const credentials = await provider.exchangeCode(code);

    await saveConnection({
      businessId: record.businessId,
      provider: "google",
      userId: record.userId,
      credentials,
      scope: credentials.scope
    });

    // The operator picks the calendar next; nothing is live until they do.
    res.redirect(`${consoleUrl}/dashboard/${record.businessId}/settings?calendar=connected`);
  } catch (err) {
    next(err);
  }
});

/** Calendars available on the connection, so the operator can choose one. */
calendarRouter.get(
  "/ops/businesses/:businessId/calendar/calendars",
  requireAuth,
  requireBusinessPermission("calendar:manage"),
  async (req, res, next) => {
    try {
      await requireEntitlement(req.params.businessId, "calendar_booking");
      const calendars = await listAvailableCalendars(req.params.businessId);
      res.json({ calendars });
    } catch (err) {
      next(toHttpError(err));
    }
  }
);

calendarRouter.post(
  "/ops/businesses/:businessId/calendar/select",
  requireAuth,
  requireCsrfToken,
  requireBusinessPermission("calendar:manage"),
  async (req, res, next) => {
    try {
      const parsed = selectCalendarSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, "A calendarId is required");
      await requireEntitlement(req.params.businessId, "calendar_booking");
      await selectCalendar(req.params.businessId, parsed.data.calendarId);
      res.json(await settingsPayload(req.params.businessId, true));
    } catch (err) {
      next(toHttpError(err));
    }
  }
);

calendarRouter.post(
  "/ops/businesses/:businessId/calendar/disconnect",
  requireAuth,
  requireCsrfToken,
  requireBusinessPermission("calendar:manage"),
  async (req, res, next) => {
    try {
      // Not entitlement-gated on purpose: a downgraded business must always be
      // able to remove its stored calendar credentials.
      await disconnectCalendar(req.params.businessId);
      res.json(await settingsPayload(req.params.businessId, true));
    } catch (err) {
      next(toHttpError(err));
    }
  }
);

/** Provider/service failures become honest HTTP errors, never silent success. */
function toHttpError(err: unknown): unknown {
  if (err instanceof CalendarServiceError) {
    const status =
      err.code === "not_connected" || err.code === "not_enabled"
        ? 409
        : err.code === "not_entitled"
          ? 403
          : 400;
    return new HttpError(status, err.message);
  }
  if (err instanceof CalendarProviderError) {
    const status = err.kind === "auth" ? 409 : err.kind === "unavailable" ? 503 : 400;
    return new HttpError(status, err.message);
  }
  return err;
}
