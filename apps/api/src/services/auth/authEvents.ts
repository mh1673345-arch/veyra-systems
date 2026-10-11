import type { Request } from "express";
import { prisma } from "../../db/client.js";

/**
 * Minimal security audit trail. Records that something happened and to whom —
 * never a password, a session token, or a reset token.
 */
export type AuthEventType =
  | "signup"
  | "login_succeeded"
  | "login_failed"
  | "logout"
  | "password_changed"
  | "sessions_revoked"
  | "user_disabled"
  | "user_enabled"
  | "role_changed"
  | "membership_removed";

export async function recordAuthEvent(params: {
  type: AuthEventType;
  userId?: string | null;
  req?: Request;
  detail?: string;
}): Promise<void> {
  try {
    await prisma.authEvent.create({
      data: {
        type: params.type,
        userId: params.userId ?? null,
        ip: params.req?.ip ?? null,
        detail: params.detail ?? null
      }
    });
  } catch (err) {
    // Auditing must never break the request it is describing.
    console.error("Failed to record auth event", params.type, err);
  }
}
