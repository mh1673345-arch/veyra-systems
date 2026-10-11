import type { Prisma } from "@prisma/client";
import { prisma } from "../../db/client.js";

/**
 * Configuration audit. Records who changed which kind of setting and which
 * fields — deliberately never the values, so contact details, prices and FAQ
 * answers are not copied into a log.
 */

export type ConfigEntity =
  | "workspace"
  | "business_profile"
  | "service"
  | "faq"
  | "working_hours"
  | "booking_settings"
  | "escalation_settings"
  | "reception_settings"
  | "reception_status"
  // Pilot operations (Phase 12)
  | "pilot"
  | "pilot_targets"
  | "pilot_safety"
  // Messaging channels (Phase 15)
  | "messaging_settings"
  | "messaging_consent"
  // Customer contact identity (Phase 15.1)
  | "customer_contact"
  // Transactional booking confirmations (Phase 15.2)
  | "booking_confirmation";

export type ConfigChange =
  | "created"
  | "updated"
  | "archived"
  | "restored"
  | "disabled"
  | "enabled"
  | "reordered"
  | "replaced"
  | "activated"
  | "paused"
  // Pilot status moves, recorded with the state they moved to.
  | "none"
  | "preparing"
  | "active"
  | "completed";

export async function recordConfigChange(
  params: {
    businessId: string;
    actorUserId: string | null;
    entityType: ConfigEntity;
    entityId?: string | null;
    changeType: ConfigChange;
    changedFields?: string[];
  },
  tx: Prisma.TransactionClient = prisma
): Promise<void> {
  await tx.configAuditEvent.create({
    data: {
      businessId: params.businessId,
      actorUserId: params.actorUserId,
      entityType: params.entityType,
      entityId: params.entityId ?? null,
      changeType: params.changeType,
      changedFields: params.changedFields ?? []
    }
  });
}

/** Names of the fields in `input` whose value differs from `current`. */
export function changedFields(current: Record<string, unknown>, input: Record<string, unknown>): string[] {
  return Object.keys(input).filter((key) => input[key] !== undefined && input[key] !== current[key]);
}
