import type { Business } from "@prisma/client";
import {
  PILOT_SAFETY_KEYS,
  type PilotSafetyControls,
  type PilotSafetyKey,
  type PilotState,
  type PilotStatus,
  type PilotTargets,
  canTransitionPilot
} from "@veyra/shared";
import { prisma } from "../../db/client.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { accessFor } from "../access/accessService.js";
import { recordConfigChange } from "../setup/audit.js";
import { evaluatePilotReadiness } from "./readiness.js";

/**
 * Pilot state: status, targets and safety controls.
 *
 * The pilot lifecycle is separate from the subscription on purpose. A Pro
 * business may run no pilot; a pilot business may sit on any plan. Nothing
 * here reads or writes a subscription.
 *
 * Every change is audited through the existing ConfigAuditEvent trail rather
 * than a parallel event system.
 */

export function pilotStateOf(business: Business): PilotState {
  return {
    status: business.pilotStatus as PilotStatus,
    startedAt: business.pilotStartedAt?.toISOString() ?? null,
    endedAt: business.pilotEndedAt?.toISOString() ?? null,
    label: business.pilotLabel,
    notes: business.pilotNotes
  };
}

export function safetyOf(business: Business): PilotSafetyControls {
  return {
    allowAutoBooking: business.allowAutoBooking,
    allowAutoReschedule: business.allowAutoReschedule,
    allowAutoCancellation: business.allowAutoCancellation,
    allowEscalation: business.allowEscalation,
    allowNotifications: business.allowNotifications
  };
}

/**
 * Safety controls whose feature the plan does not include anyway. The Console
 * shows these as unavailable rather than pretending the switch does anything:
 * turning one on can never grant the feature.
 */
export async function safetyLockedByPlan(businessId: string): Promise<PilotSafetyKey[]> {
  const access = await accessFor(businessId);
  const locked: PilotSafetyKey[] = [];
  if (!access.entitlements.has("calendar_booking")) locked.push("allowAutoBooking");
  if (!access.entitlements.has("calendar_reschedule")) locked.push("allowAutoReschedule");
  if (!access.entitlements.has("calendar_cancellation")) locked.push("allowAutoCancellation");
  if (!access.entitlements.has("human_escalation")) locked.push("allowEscalation");
  if (!access.entitlements.has("email_notifications")) locked.push("allowNotifications");
  return locked;
}

export async function pilotTargetsOf(businessId: string): Promise<PilotTargets> {
  const row = await prisma.pilotTarget.findUnique({ where: { businessId } });
  return {
    targetConversations: row?.targetConversations ?? null,
    targetBookingRequests: row?.targetBookingRequests ?? null,
    targetConfirmedBookings: row?.targetConfirmedBookings ?? null,
    maxHumanInterventionRate: row?.maxHumanInterventionRate ?? null,
    maxUnresolvedIssues: row?.maxUnresolvedIssues ?? null
  };
}

async function loadBusiness(businessId: string): Promise<Business> {
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) throw new HttpError(404, "Business not found");
  return business;
}

export interface SetPilotStatusParams {
  businessId: string;
  status: PilotStatus;
  actorUserId: string;
  label?: string | null;
  notes?: string | null;
  now?: Date;
}

/**
 * Moves the pilot along. Activation is refused while pilot readiness is
 * blocking — starting a pilot you cannot monitor produces findings nobody can
 * trust.
 */
export async function setPilotStatus(params: SetPilotStatusParams): Promise<PilotState> {
  const now = params.now ?? new Date();
  const business = await loadBusiness(params.businessId);
  const from = business.pilotStatus as PilotStatus;

  if (from !== params.status && !canTransitionPilot(from, params.status)) {
    throw new HttpError(
      422,
      `A pilot can't go from "${from}" to "${params.status}".` +
        (from === "completed" ? " A completed pilot is final; start a new one instead." : "")
    );
  }

  if (params.status === "active" && from !== "active") {
    const readiness = await evaluatePilotReadiness(params.businessId);
    if (!readiness.canActivate) {
      const blocking = readiness.checks.filter((check) => check.level === "blocking");
      throw new HttpError(
        422,
        `This pilot isn't ready to monitor: ${blocking.map((check) => check.message).join(" ")}`
      );
    }
  }

  const changedFields = ["pilotStatus"];
  if (params.label !== undefined) changedFields.push("pilotLabel");
  if (params.notes !== undefined) changedFields.push("pilotNotes");

  const updated = await prisma.business.update({
    where: { id: params.businessId },
    data: {
      pilotStatus: params.status,
      ...(params.label !== undefined ? { pilotLabel: params.label } : {}),
      ...(params.notes !== undefined ? { pilotNotes: params.notes } : {}),
      // The first activation stamps the start; re-activating after a pause
      // keeps the original start so lifetime means the whole pilot.
      ...(params.status === "active" && !business.pilotStartedAt ? { pilotStartedAt: now } : {}),
      ...(params.status === "completed" ? { pilotEndedAt: now } : {}),
      // Going back to "none" clears the pilot window rather than leaving
      // half a pilot on the record.
      ...(params.status === "none" ? { pilotStartedAt: null, pilotEndedAt: null } : {}),
      ...(params.status === "active" ? { pilotEndedAt: null } : {})
    }
  });

  await recordConfigChange({
    businessId: params.businessId,
    actorUserId: params.actorUserId,
    entityType: "pilot",
    entityId: params.businessId,
    changeType: params.status,
    changedFields
  });

  return pilotStateOf(updated);
}

export async function updatePilotTargets(params: {
  businessId: string;
  actorUserId: string;
  targets: Partial<PilotTargets>;
}): Promise<PilotTargets> {
  const { businessId, targets } = params;
  await loadBusiness(businessId);

  for (const [key, value] of Object.entries(targets)) {
    if (value === null || value === undefined) continue;
    if (key === "maxHumanInterventionRate") {
      if (typeof value !== "number" || value < 0 || value > 1) {
        throw new HttpError(400, "maxHumanInterventionRate must be a share between 0 and 1.");
      }
    } else if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new HttpError(400, `${key} must be a whole number of 0 or more.`);
    }
  }

  const data = {
    targetConversations: targets.targetConversations ?? null,
    targetBookingRequests: targets.targetBookingRequests ?? null,
    targetConfirmedBookings: targets.targetConfirmedBookings ?? null,
    maxHumanInterventionRate: targets.maxHumanInterventionRate ?? null,
    maxUnresolvedIssues: targets.maxUnresolvedIssues ?? null
  };

  await prisma.pilotTarget.upsert({ where: { businessId }, create: { businessId, ...data }, update: data });
  await recordConfigChange({
    businessId,
    actorUserId: params.actorUserId,
    entityType: "pilot_targets",
    entityId: businessId,
    changeType: "updated",
    changedFields: Object.keys(targets)
  });

  return pilotTargetsOf(businessId);
}

export async function updatePilotSafety(params: {
  businessId: string;
  actorUserId: string;
  controls: Partial<PilotSafetyControls>;
}): Promise<PilotSafetyControls> {
  const business = await loadBusiness(params.businessId);
  const data: Partial<PilotSafetyControls> = {};
  for (const key of PILOT_SAFETY_KEYS) {
    const value = params.controls[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw new HttpError(400, `${key} must be true or false.`);
    data[key] = value;
  }
  if (Object.keys(data).length === 0) throw new HttpError(400, "No safety controls were supplied.");

  // Deliberately no entitlement check here: these switches only ever withhold.
  // Turning one on cannot grant a feature — effectiveCapabilities still ANDs
  // the plan's entitlements, so a locked control simply has no effect.
  const updated = await prisma.business.update({ where: { id: business.id }, data });
  await recordConfigChange({
    businessId: business.id,
    actorUserId: params.actorUserId,
    entityType: "pilot_safety",
    entityId: business.id,
    changeType: "updated",
    changedFields: Object.keys(data)
  });
  return safetyOf(updated);
}
