import express, { Router } from "express";
import { currentEnvironment } from "../config/database.js";
import { prisma } from "../db/client.js";
import { HttpError } from "../middleware/errorHandler.js";
import { requireAuth, requireBusinessPermission } from "../middleware/auth.js";
import { requireCsrfToken } from "../middleware/csrf.js";
import { roleHasPermission } from "../services/auth/permissions.js";
import { callDetail, listCalls, updateVoiceSettings, voiceOverview } from "../services/voice/console.js";
import { processVoiceWebhook, startOutboundCall } from "../services/voice/session.js";
import { fakeVoiceProvider, voiceProvider, voiceProviderByName } from "../services/voice/registry.js";
import { VoiceWebhookVerificationError } from "../services/voice/types.js";
import { TwilioVoiceProvider } from "../services/voice/providers/twilioVoice.js";
import { mediaStreamUrl } from "../services/voice/media/bridge.js";
import { CallTransitionError } from "../services/voice/callState.js";

/* ------------------------------------------------------------------ *
 * Provider webhooks — mounted before express.json(): telephony providers
 * sign the exact bytes they sent, so the body must not be parsed first.
 * ------------------------------------------------------------------ */

export const voiceWebhookRouter = Router();

voiceWebhookRouter.post(
  "/voice/webhooks/:provider",
  express.raw({ type: "*/*", limit: "512kb" }),
  async (req, res) => {
    const provider = voiceProviderByName(req.params.provider);
    if (!provider) {
      res.status(404).json({ error: "Unknown voice provider" });
      return;
    }
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    // Twilio signs the full public URL, so it has to be reconstructed exactly.
    const url = `${process.env.VEYRA_PUBLIC_API_URL ?? `${req.protocol}://${req.get("host") ?? "localhost"}`}${req.originalUrl}`;

    try {
      const result = await processVoiceWebhook({ provider, rawBody, headers: req.headers, url });

      // Twilio drives the call from this response, so it must ALWAYS receive
      // TwiML. Answering it with JSON makes the carrier play an error message
      // to the caller — which is exactly what would have happened on the first
      // real call before this was fixed.
      if (provider instanceof TwilioVoiceProvider) {
        if (result.answeredCall) {
          // A new inbound call: hand the audio to Veyra's media stream, which
          // is what makes streaming recognition and barge-in possible.
          const publicUrl = process.env.VEYRA_PUBLIC_API_URL;
          if (!publicUrl) {
            console.error("[veyra:voice] VEYRA_PUBLIC_API_URL is not set, so Twilio cannot be given a media stream URL");
            res.type("text/xml").send(provider.instructionMarkup({ kind: "hangup", sayFirst: "Sorry — this line isn't available right now." }));
            return;
          }
          res
            .type("text/xml")
            .send(provider.mediaStreamMarkup({ websocketUrl: mediaStreamUrl(publicUrl), callSid: result.answeredCall.externalCallId }));
          return;
        }
        res.type("text/xml").send(result.instruction ? provider.instructionMarkup(result.instruction) : provider.noopMarkup());
        return;
      }
      if (result.instruction) {
        await provider
          .perform({ externalCallId: instructionCallId(req, result), instruction: result.instruction })
          .catch((err) => console.error("[veyra:voice] could not carry out the next step", err instanceof Error ? err.message : err));
      }
      res.status(200).json({ received: true, outcome: result.outcome });
    } catch (err) {
      if (err instanceof VoiceWebhookVerificationError || err instanceof SyntaxError) {
        // Never processed, never recorded. Logged without the payload — a call
        // webhook carries phone numbers.
        console.warn("[veyra:voice] rejected unverified %s webhook: %s", provider.name, err.message);
        res.status(400).json({ error: "Webhook could not be verified" });
        return;
      }
      if (err instanceof CallTransitionError) {
        // An impossible move is the provider's confusion, not a Veyra failure:
        // recorded and acknowledged so it is not retried forever.
        console.warn("[veyra:voice] refused an impossible call transition: %s", err.message);
        res.status(200).json({ received: true, outcome: "ignored", detail: err.message });
        return;
      }
      console.error("[veyra:voice] %s webhook processing failed; the provider will retry", provider.name, err);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  }
);

/** The call an instruction belongs to, taken from the event Veyra just handled. */
function instructionCallId(req: express.Request, result: { callSessionId?: string }): string {
  // The session id is known; the provider needs its own call id.
  const fromBody = (() => {
    try {
      const parsed = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "{}");
      return String(parsed?.data?.externalCallId ?? "");
    } catch {
      return "";
    }
  })();
  return fromBody || (result.callSessionId ?? "");
}

/* ------------------------------------------------------------------ *
 * Console
 * ------------------------------------------------------------------ */

export const voiceRouter = Router();

const read = [requireAuth, requireBusinessPermission("settings:read")] as const;
const manage = [requireAuth, requireCsrfToken, requireBusinessPermission("settings:write")] as const;

voiceRouter.get("/ops/businesses/:businessId/voice", ...read, async (req, res, next) => {
  try {
    res.json(await voiceOverview(req.params.businessId, roleHasPermission(req.membership!.role, "settings:write")));
  } catch (err) {
    next(err);
  }
});

voiceRouter.put("/ops/businesses/:businessId/voice", ...manage, async (req, res, next) => {
  try {
    await updateVoiceSettings({ businessId: req.params.businessId, patch: req.body ?? {} });
    res.json(await voiceOverview(req.params.businessId, true));
  } catch (err) {
    next(err);
  }
});

voiceRouter.get(
  "/ops/businesses/:businessId/calls",
  requireAuth,
  requireBusinessPermission("dashboard:read"),
  async (req, res, next) => {
    try {
      res.json(await listCalls(req.params.businessId));
    } catch (err) {
      next(err);
    }
  }
);

voiceRouter.get(
  "/ops/businesses/:businessId/calls/:callId",
  requireAuth,
  requireBusinessPermission("dashboard:read"),
  async (req, res, next) => {
    try {
      res.json(await callDetail(req.params.businessId, req.params.callId));
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Places a single outbound call, because an operator asked for it.
 *
 * Deliberately one call to one number: there is no campaign runner, nothing
 * scheduled and nothing autonomous anywhere in this phase.
 */
voiceRouter.post(
  "/ops/businesses/:businessId/calls",
  requireAuth,
  requireCsrfToken,
  requireBusinessPermission("operations:write"),
  async (req, res, next) => {
    try {
      const to = req.body?.to;
      if (typeof to !== "string" || !/^\+?[0-9 ().-]{6,20}$/.test(to.trim())) {
        throw new HttpError(400, "A valid phone number to call is required.");
      }
      const session = await startOutboundCall({
        businessId: req.params.businessId,
        to: to.trim(),
        actorUserId: req.auth!.user.id
      });
      res.status(201).json(await callDetail(req.params.businessId, session.id));
    } catch (err) {
      next(err);
    }
  }
);

/* ------------------------------------------------------------------ *
 * Development call simulator — the same pipeline, no telephony.
 * ------------------------------------------------------------------ */

export const voiceSimulatorRouter = Router();

/**
 * The simulator's guard, applied to each route rather than by path prefix:
 * these paths start with /ops/businesses/:id, so a prefix mount would never
 * have matched them and the guard would have silently done nothing.
 */
function simulatorOnly(_req: express.Request, _res: express.Response, next: express.NextFunction) {
  if (currentEnvironment() === "production") {
    next(new HttpError(404, "Not found"));
    return;
  }
  if (voiceProvider()?.name !== "fake") {
    next(new HttpError(409, "The call simulator needs VEYRA_VOICE_PROVIDER=fake."));
    return;
  }
  next();
}

/**
 * Delivers whatever the fake provider has queued to the real webhook route,
 * signed, over HTTP — so a simulated call exercises verification, idempotency
 * and the state machine exactly as a carrier's would.
 */
async function deliverFakeVoiceEvents(): Promise<{ delivered: number; instructions: string[] }> {
  const base = process.env.VEYRA_PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
  const instructions: string[] = [];
  let delivered = 0;

  for (const event of fakeVoiceProvider.drainSignedEvents()) {
    const response = await fetch(`${base}/api/voice/webhooks/fake`, {
      method: "POST",
      headers: event.headers,
      body: event.rawBody
    });
    delivered += 1;
    instructions.push(`${response.status}`);
  }
  return { delivered, instructions };
}

voiceSimulatorRouter.post(
  "/ops/businesses/:businessId/voice/simulate/call",
  requireAuth,
  requireCsrfToken,
  requireBusinessPermission("operations:write"),
  simulatorOnly,
  async (req, res, next) => {
    try {
      const settings = await prisma.voiceSettings.findUnique({ where: { businessId: req.params.businessId } });
      if (!settings?.businessPhoneNumber) {
        throw new HttpError(409, "Configure a phone number for this business before simulating a call.");
      }
      const from = typeof req.body?.from === "string" && req.body.from.trim() ? req.body.from.trim() : "+15550000001";

      const { externalCallId } = fakeVoiceProvider.simulateInboundCall({ from, to: settings.businessPhoneNumber });
      await deliverFakeVoiceEvents();
      fakeVoiceProvider.simulateAnswered(externalCallId);
      await deliverFakeVoiceEvents();

      const session = await prisma.callSession.findUnique({
        where: { provider_externalCallId: { provider: "fake", externalCallId } }
      });
      res.status(201).json({
        externalCallId,
        callSessionId: session?.id ?? null,
        spoken: fakeVoiceProvider.spokenOn(externalCallId).map((line) => line.text)
      });
    } catch (err) {
      next(err);
    }
  }
);

voiceSimulatorRouter.post(
  "/ops/businesses/:businessId/voice/simulate/say",
  requireAuth,
  requireCsrfToken,
  requireBusinessPermission("operations:write"),
  simulatorOnly,
  async (req, res, next) => {
    try {
      const externalCallId = req.body?.externalCallId;
      const text = req.body?.text;
      if (typeof externalCallId !== "string" || typeof text !== "string" || !text.trim()) {
        throw new HttpError(400, "externalCallId and text are required.");
      }
      const session = await prisma.callSession.findFirst({
        where: { externalCallId, businessId: req.params.businessId }
      });
      if (!session) throw new HttpError(404, "Call not found");

      const before = fakeVoiceProvider.spokenOn(externalCallId).length;
      fakeVoiceProvider.simulateCallerSpeech(externalCallId, text.trim());
      await deliverFakeVoiceEvents();

      res.json({
        externalCallId,
        spoken: fakeVoiceProvider.spokenOn(externalCallId).slice(before).map((line) => line.text)
      });
    } catch (err) {
      next(err);
    }
  }
);

voiceSimulatorRouter.post(
  "/ops/businesses/:businessId/voice/simulate/hangup",
  requireAuth,
  requireCsrfToken,
  requireBusinessPermission("operations:write"),
  simulatorOnly,
  async (req, res, next) => {
    try {
      const externalCallId = req.body?.externalCallId;
      if (typeof externalCallId !== "string") throw new HttpError(400, "externalCallId is required.");
      const session = await prisma.callSession.findFirst({
        where: { externalCallId, businessId: req.params.businessId }
      });
      if (!session) throw new HttpError(404, "Call not found");

      fakeVoiceProvider.simulateCallerHangup(externalCallId);
      await deliverFakeVoiceEvents();
      res.json(await callDetail(req.params.businessId, session.id));
    } catch (err) {
      next(err);
    }
  }
);
