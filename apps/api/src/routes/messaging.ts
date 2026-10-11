import express, { Router } from "express";
import { z } from "zod";
import type { MessagingChannel } from "@veyra/shared";
import { prisma } from "../db/client.js";
import { HttpError } from "../middleware/errorHandler.js";
import { requireAuth, requireBusinessPermission } from "../middleware/auth.js";
import { requireCsrfToken } from "../middleware/csrf.js";
import { roleHasPermission } from "../services/auth/permissions.js";
import { messagingOverview } from "../services/messaging/console.js";
import {
  MessagingWebhookVerificationError,
  processMessagingWebhook,
  processVerifiedEvents,
  verifyMessagingWebhook
} from "../services/messaging/webhooks.js";
import {
  answerVerificationChallenge,
  metaWebhookConfig,
  missingMetaWebhookConfig
} from "../services/messaging/providers/metaWhatsAppWebhook.js";
import { InvalidPhoneNumberError, toE164 } from "../services/messaging/phone.js";
import { hasEntitlement } from "../services/access/accessService.js";
import { recordConfigChange } from "../services/setup/audit.js";
import { KNOWN_SMS_PROVIDERS, KNOWN_WHATSAPP_PROVIDERS } from "../services/messaging/registry.js";

/* ------------------------------------------------------------------ *
 * Provider webhooks — mounted before express.json(): messaging providers
 * sign the exact bytes they send, so the body must not be parsed first.
 * ------------------------------------------------------------------ */

export const messagingWebhookRouter = Router();

messagingWebhookRouter.post(
  "/messaging/webhooks/:provider",
  express.raw({ type: "*/*", limit: "512kb" }),
  async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    try {
      const results = await processMessagingWebhook({
        provider: req.params.provider,
        rawBody,
        headers: req.headers
      });
      // 2xx only once the work has committed: that is when the provider is
      // entitled to stop retrying.
      res.status(200).json({ received: true, results: results.map((r) => r.outcome) });
    } catch (error) {
      if (error instanceof MessagingWebhookVerificationError) {
        // Logged without the payload: an unverified body is attacker-supplied.
        console.warn("[veyra:messaging] rejected an unverified webhook for %s", req.params.provider);
        res.status(400).json({ error: "Invalid signature" });
        return;
      }
      console.error("[veyra:messaging] webhook processing failed", error);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  }
);

/* ------------------------------------------------------------------ *
 * Meta WhatsApp — one URL, because Meta uses the same one for the
 * subscription handshake (GET) and for every event (POST).
 * ------------------------------------------------------------------ */

const META_WEBHOOK_PATH = "/messaging/whatsapp/meta/webhook";

messagingWebhookRouter.get(META_WEBHOOK_PATH, (req, res) => {
  const config = metaWebhookConfig();
  if (!config) {
    console.warn(
      "[veyra:messaging] a Meta webhook verification arrived but %s not set",
      missingMetaWebhookConfig().join(" and ")
    );
    res.status(503).json({ error: "Meta webhooks are not configured on this server" });
    return;
  }

  const answer = answerVerificationChallenge(req.query as Record<string, unknown>, config);
  if (!answer.ok) {
    // Reason and safe diagnostic, never either token: a failed handshake is
    // exactly where a secret would otherwise get written into a log. Lengths
    // and presence are enough to tell a dashboard typo from a process that
    // was started before .env was last edited — dotenv reads the file once
    // at boot, and `tsx watch` only watches TypeScript.
    console.warn(
      "[veyra:messaging] Meta webhook verification refused: %s (%s)",
      answer.reason,
      answer.diagnostic
    );
    res.sendStatus(403);
    return;
  }

  console.log("[veyra:messaging] Meta webhook verification succeeded");
  // Meta expects the bare challenge, not JSON.
  res.status(200).type("text/plain").send(answer.challenge);
});

messagingWebhookRouter.post(
  META_WEBHOOK_PATH,
  express.raw({ type: "*/*", limit: "512kb" }),
  async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    // Verification is synchronous: a forged request must be refused, and
    // must not reach the claim store or create anything.
    let events;
    try {
      events = await verifyMessagingWebhook({ provider: "meta", rawBody, headers: req.headers });
    } catch (error) {
      if (error instanceof MessagingWebhookVerificationError) {
        console.warn("[veyra:messaging] rejected an unverified Meta webhook");
        res.status(403).json({ error: "Invalid signature" });
        return;
      }
      console.error("[veyra:messaging] Meta webhook verification failed", error);
      res.status(500).json({ error: "Webhook processing failed" });
      return;
    }

    // Acknowledged before the work. A Reception turn can involve an AI call
    // and then a second call back out to Meta; Meta retries a webhook it
    // considers slow, and a retry storm would turn one customer message into
    // several. The claim store, not this response, is what makes a
    // redelivery harmless.
    res.status(200).json({ received: true, events: events.length });

    void processVerifiedEvents("meta", events).catch((error) => {
      console.error("[veyra:messaging] Meta webhook processing failed after acknowledgement", error);
    });
  }
);

/* ------------------------------------------------------------------ *
 * Console
 * ------------------------------------------------------------------ */

export const messagingRouter = Router();

messagingRouter.get(
  "/ops/businesses/:businessId/messaging",
  requireAuth,
  requireBusinessPermission("dashboard:read"),
  async (req, res, next) => {
    try {
      const canManage = roleHasPermission(req.membership!.role, "settings:write");
      res.json(await messagingOverview(req.params.businessId, canManage));
    } catch (err) {
      next(err);
    }
  }
);

const channelSchema = z.enum(["sms", "whatsapp"]);

const settingsSchema = z
  .object({
    smsEnabled: z.boolean().optional(),
    whatsappEnabled: z.boolean().optional(),
    smsProvider: z.string().trim().max(40).nullable().optional(),
    whatsappProvider: z.string().trim().max(40).nullable().optional(),
    smsSender: z.string().trim().max(24).nullable().optional(),
    whatsappSender: z.string().trim().max(24).nullable().optional(),
    defaultCountry: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, "Use a two-letter country code, for example PK.")
      .nullable()
      .optional(),
    customerMessagingEnabled: z.boolean().optional(),
    operatorMessagingEnabled: z.boolean().optional()
  })
  .strict();

messagingRouter.patch(
  "/ops/businesses/:businessId/messaging",
  requireAuth,
  requireCsrfToken,
  requireBusinessPermission("settings:write"),
  async (req, res, next) => {
    try {
      const parsed = settingsSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, parsed.error.errors[0]?.message ?? "Invalid messaging settings");
      }
      const input = parsed.data;
      const businessId = req.params.businessId;

      // Switching a channel on is a paid feature, whatever the Console shows.
      // Checked here so configuration can never stand in for an entitlement.
      for (const [flag, entitlement] of [
        [input.smsEnabled, "sms"],
        [input.whatsappEnabled, "whatsapp"]
      ] as const) {
        if (flag === true && !(await hasEntitlement(businessId, entitlement))) {
          throw new HttpError(
            402,
            `${entitlement === "sms" ? "SMS" : "WhatsApp"} is not included in this plan.`
          );
        }
      }

      // Provider names are validated against what this build can actually
      // talk to: a typo would otherwise fail closed much later, at send time.
      if (input.smsProvider && !(KNOWN_SMS_PROVIDERS as readonly string[]).includes(input.smsProvider)) {
        throw new HttpError(400, `Unknown SMS provider "${input.smsProvider}".`);
      }
      if (
        input.whatsappProvider &&
        !(KNOWN_WHATSAPP_PROVIDERS as readonly string[]).includes(input.whatsappProvider)
      ) {
        throw new HttpError(400, `Unknown WhatsApp provider "${input.whatsappProvider}".`);
      }

      const data: Record<string, unknown> = {};
      const changed: string[] = [];
      for (const key of [
        "smsEnabled",
        "whatsappEnabled",
        "smsProvider",
        "whatsappProvider",
        "customerMessagingEnabled",
        "operatorMessagingEnabled"
      ] as const) {
        if (input[key] !== undefined) {
          data[key] = input[key];
          changed.push(key);
        }
      }
      if (input.defaultCountry !== undefined) {
        data.defaultCountry = input.defaultCountry ? input.defaultCountry.toUpperCase() : null;
        changed.push("defaultCountry");
      }

      // Senders are stored in one shape only, and an ambiguous local number
      // is refused rather than guessed at.
      for (const key of ["smsSender", "whatsappSender"] as const) {
        const value = input[key];
        if (value === undefined) continue;
        if (value === null || value === "") {
          data[key] = null;
        } else {
          try {
            data[key] = toE164(value, { defaultCountry: input.defaultCountry ?? null });
          } catch (error) {
            throw new HttpError(
              400,
              error instanceof InvalidPhoneNumberError ? error.message : "That sender number is not valid."
            );
          }
        }
        changed.push(key);
      }

      if (changed.length === 0) {
        res.json(await messagingOverview(businessId, true));
        return;
      }

      await prisma.messagingSettings.upsert({
        where: { businessId },
        create: { businessId, ...data },
        update: data
      });
      await recordConfigChange({
        businessId,
        actorUserId: req.auth!.user.id,
        entityType: "messaging_settings",
        changeType: "updated",
        changedFields: changed
      });

      res.json(await messagingOverview(businessId, true));
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Consent, viewed and set by an operator. Reading it is a dashboard
 * permission; changing it is a settings one, because recording consent
 * someone did not give is exactly as consequential as it sounds.
 */
messagingRouter.get(
  "/ops/businesses/:businessId/messaging/consent",
  requireAuth,
  requireBusinessPermission("dashboard:read"),
  async (req, res, next) => {
    try {
      const rows = await prisma.messagingConsent.findMany({
        where: { businessId: req.params.businessId },
        orderBy: { updatedAt: "desc" },
        take: 200
      });
      const { maskPhone } = await import("../services/messaging/phone.js");
      res.json({
        consents: rows.map((row) => ({
          channel: row.channel as MessagingChannel,
          // Never the full number: this is a list an operator browses.
          phone: maskPhone(row.phoneE164),
          state: row.state,
          source: row.source,
          updatedAt: row.updatedAt.toISOString()
        }))
      });
    } catch (err) {
      next(err);
    }
  }
);

const consentSchema = z
  .object({
    channel: channelSchema,
    phone: z.string().trim().min(1),
    state: z.enum(["unknown", "granted", "revoked"])
  })
  .strict();

messagingRouter.post(
  "/ops/businesses/:businessId/messaging/consent",
  requireAuth,
  requireCsrfToken,
  requireBusinessPermission("settings:write"),
  async (req, res, next) => {
    try {
      const parsed = consentSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, parsed.error.errors[0]?.message ?? "Invalid consent update");
      }
      const { recordConsent } = await import("../services/messaging/consent.js");
      await recordConsent({
        businessId: req.params.businessId,
        channel: parsed.data.channel,
        phone: parsed.data.phone,
        state: parsed.data.state,
        source: "operator"
      });
      await recordConfigChange({
        businessId: req.params.businessId,
        actorUserId: req.auth!.user.id,
        entityType: "messaging_consent",
        changeType: "updated",
        changedFields: [parsed.data.channel, parsed.data.state]
      });
      res.status(204).end();
    } catch (err) {
      if (err instanceof InvalidPhoneNumberError) {
        next(new HttpError(400, err.message));
        return;
      }
      next(err);
    }
  }
);
