import type { Business, VoiceSettings } from "@prisma/client";
import { lowestPlanWith } from "@veyra/shared";
import { prisma } from "../../db/client.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { EntitlementError, accessFor, assertWithinLimit } from "../access/accessService.js";
import { voiceProvider } from "./registry.js";
import type { VoiceProvider } from "./types.js";

/**
 * Whether a business may actually use the phone.
 *
 * Four things must all hold, and they are checked in this order every time —
 * never inferred from the Console having shown a button:
 *
 *   1. the plan includes voice (Max);
 *   2. the specific direction is included (inbound / outbound);
 *   3. the business has switched voice on and configured it;
 *   4. a voice provider is configured and healthy.
 *
 * The first two are entitlements and fail with ENTITLEMENT_REQUIRED, so a
 * Starter or Pro business calling a voice API directly is refused by the
 * backend exactly as if the UI did not exist.
 */

export interface VoiceAccess {
  business: Business;
  settings: VoiceSettings;
  provider: VoiceProvider;
}

export class VoiceUnavailableError extends HttpError {
  readonly code = "VOICE_UNAVAILABLE";
  constructor(message: string) {
    super(409, message);
  }
}

/** Minutes used this billing period, from the calls themselves. */
export async function voiceMinutesUsed(businessId: string): Promise<number> {
  const access = await accessFor(businessId);
  const periodStart =
    access.subscription?.currentPeriodStart ??
    new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));

  const calls = await prisma.callSession.aggregate({
    where: { businessId, startedAt: { gte: periodStart }, durationSeconds: { not: null } },
    _sum: { durationSeconds: true }
  });
  return Math.ceil((calls._sum.durationSeconds ?? 0) / 60);
}

export async function voiceSettingsFor(businessId: string): Promise<VoiceSettings | null> {
  return prisma.voiceSettings.findUnique({ where: { businessId } });
}

/**
 * The gate. `direction` decides which of the two directional entitlements is
 * required; `startingNewCall` also enforces the monthly minute allowance.
 */
export async function requireVoiceAccess(params: {
  businessId: string;
  direction: "inbound" | "outbound";
  /** A new call checks the minute allowance; a turn inside a live call does not. */
  startingNewCall?: boolean;
}): Promise<VoiceAccess> {
  const business = await prisma.business.findUnique({ where: { id: params.businessId } });
  if (!business) throw new HttpError(404, "Business not found");

  const access = await accessFor(params.businessId);
  if (!access.entitlements.has("voice_reception")) {
    throw new EntitlementError("voice_reception", lowestPlanWith("voice_reception"));
  }
  const directional = params.direction === "inbound" ? "voice_inbound" : "voice_outbound";
  if (!access.entitlements.has(directional)) {
    throw new EntitlementError(directional, lowestPlanWith(directional));
  }

  const settings = await voiceSettingsFor(params.businessId);
  if (!settings || !settings.enabled) {
    throw new VoiceUnavailableError("Voice is not switched on for this business.");
  }
  if (params.direction === "inbound" && !settings.businessPhoneNumber) {
    throw new VoiceUnavailableError("This business has no phone number configured for Veyra to answer.");
  }

  const provider = voiceProvider();
  if (!provider) {
    throw new VoiceUnavailableError("No voice provider is configured on this server.");
  }
  if (settings.provider && settings.provider !== provider.name) {
    throw new VoiceUnavailableError(
      `This business is configured for the ${settings.provider} voice provider, but the server runs ${provider.name}.`
    );
  }

  // A new call must fit inside the plan's monthly minutes. A call already in
  // progress is never cut off for this — see enforceMinuteAllowance.
  if (params.startingNewCall) await enforceMinuteAllowance(params.businessId);

  return { business, settings, provider };
}

/**
 * Monthly voice minutes.
 *
 * Policy, deliberately: going over the allowance blocks *new* paid voice
 * sessions and leaves any call already in progress alone. Hanging up on
 * someone mid-sentence to enforce a billing limit would be a worse failure
 * than the overage.
 */
export async function enforceMinuteAllowance(businessId: string): Promise<void> {
  // The ordinary plan-limit path: the counter lives with every other usage
  // counter, and the Console explains an overage the same way it explains a
  // team-member limit.
  await assertWithinLimit(businessId, "monthly_voice_minutes");
}
