import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { errorHandler } from "./middleware/errorHandler.js";
import { securityHeaders } from "./middleware/securityHeaders.js";
import { requireApiKey } from "./middleware/auth.js";
import { CSRF_HEADER } from "./services/auth/sessions.js";
import { healthRouter } from "./routes/health.js";
import { authRouter } from "./routes/auth.js";
import { businessesRouter } from "./routes/businesses.js";
import { conversationsRouter } from "./routes/conversations.js";
import { appointmentsRouter } from "./routes/appointments.js";
import { opsRouter } from "./routes/ops.js";
import { calendarRouter } from "./routes/calendar.js";
import { subscriptionRouter } from "./routes/subscription.js";
import { setupRouter } from "./routes/setup.js";
import { membersRouter } from "./routes/members.js";
import { notificationsRouter } from "./routes/notifications.js";
import { billingRouter, billingWebhookRouter, fakeBillingRouter } from "./routes/billing.js";
import { pilotRouter } from "./routes/pilot.js";
import { voiceRouter, voiceSimulatorRouter, voiceWebhookRouter } from "./routes/voice.js";
import { messagingRouter, messagingWebhookRouter } from "./routes/messaging.js";
import { contactsRouter } from "./routes/contacts.js";
import { demoRouter } from "./routes/demo.js";

/** Origins allowed to send session cookies. */
function allowedOrigins(): string[] {
  const configured = process.env.VEYRA_WEB_ORIGIN;
  if (configured) return configured.split(",").map((o) => o.trim());
  return ["http://localhost:5173", "http://127.0.0.1:5173"];
}

export function createApp() {
  const app = express();

  app.use(securityHeaders);
  // Credentials are required for the session cookie, so the origin must be
  // explicit — a wildcard origin cannot be combined with credentials. The
  // CSRF header must also be allowed through preflight.
  app.use(
    cors({
      origin: allowedOrigins(),
      credentials: true,
      allowedHeaders: ["Content-Type", "x-api-key", CSRF_HEADER],
      exposedHeaders: [CSRF_HEADER]
    })
  );
  // Payment-provider webhooks verify a signature over the raw bytes, so they
  // are routed before the JSON parser can consume the body.
  app.use("/api", billingWebhookRouter);
  // Telephony providers sign the exact bytes they send, so voice webhooks are
  // routed before the JSON parser too.
  app.use("/api", voiceWebhookRouter);
  // Messaging providers sign the exact bytes they send, so the same applies.
  app.use("/api", messagingWebhookRouter);
  app.use(express.json());
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.use(cookieParser());

  app.use("/api", healthRouter);

  // Operator dashboard: authenticated sessions with per-business permissions.
  // These routes do NOT accept the shared API key.
  app.use("/api", authRouter);
  app.use("/api", opsRouter);
  // Calendar connection management + the OAuth callback Google redirects to.
  app.use("/api", calendarRouter);
  // Subscription + billing overview. Plans change only via verified billing
  // webhooks (or the admin script) — never directly from a request.
  app.use("/api", subscriptionRouter);
  // Self-service onboarding and business configuration (session + CSRF).
  app.use("/api", setupRouter);
  app.use("/api", membersRouter);
  app.use("/api", notificationsRouter);
  // Billing: owner actions (session + CSRF), and the development provider's
  // stand-in checkout pages (refused in production).
  // Pilot operations: measurement, issues and pilot state (session + RBAC).
  app.use("/api", pilotRouter);
  // Voice: the Max channel. Settings, call history and the development
  // call simulator (refused in production).
  app.use("/api", voiceRouter);
  // SMS and WhatsApp: channel settings, consent and provider status.
  app.use("/api", messagingRouter);
  // Customer contact identity: one contact per business, never shared.
  app.use("/api", contactsRouter);
  app.use("/api", voiceSimulatorRouter);
  // Which business the public Reception demo talks to. Public, like the demo.
  app.use("/api", demoRouter);
  app.use("/api", billingRouter);
  app.use("/api", fakeBillingRouter);

  // Public reception demo endpoints, still gated by the shared demo key.
  app.use("/api", requireApiKey, businessesRouter);
  app.use("/api", requireApiKey, conversationsRouter);
  app.use("/api", requireApiKey, appointmentsRouter);

  app.use(errorHandler);

  return app;
}
