import { randomBytes } from "node:crypto";
import { prisma } from "../../db/client.js";
import { hashToken } from "./sessions.js";

/**
 * Deliberately simple policy: length does the work. No "one uppercase, one
 * symbol" rules — they push people toward weaker, harder-to-type passwords and
 * fight password managers.
 */
export const MIN_PASSWORD_LENGTH = 12;
/**
 * bcrypt only considers the first 72 bytes; anything longer would be silently
 * truncated, so it's rejected rather than quietly weakened.
 */
export const MAX_PASSWORD_BYTES = 72;

/** A tiny blocklist of patterns that show up constantly in credential stuffing. */
const WEAK_PATTERNS = [
  "password",
  "12345678",
  "qwerty",
  "letmein",
  "changeme",
  "welcome1",
  "iloveyou",
  "admin123"
];

export interface PasswordCheck {
  ok: boolean;
  error?: string;
}

export function validatePassword(password: string, email?: string): PasswordCheck {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }

  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    return {
      ok: false,
      error: `Password must be at most ${MAX_PASSWORD_BYTES} bytes`
    };
  }

  const lower = password.toLowerCase();
  if (WEAK_PATTERNS.some((pattern) => lower.includes(pattern))) {
    return { ok: false, error: "Password is too easy to guess. Choose something less common." };
  }

  // "sam@example.com" / "sam1234567890" shouldn't be a valid password for Sam.
  const localPart = email?.split("@")[0]?.toLowerCase();
  if (localPart && localPart.length >= 3 && lower.includes(localPart)) {
    return { ok: false, error: "Password must not contain your email address" };
  }

  return { ok: true };
}

/* ------------------------- password reset foundation ------------------------ *
 * The mechanism is implemented and tested, but no route consumes it: there is
 * no email provider configured, and issuing reset tokens without a delivery
 * channel would either do nothing or become a way to mint tokens. Wiring a
 * "forgot password" endpoint is a follow-up once outbound email exists.
 * -------------------------------------------------------------------------- */

const RESET_TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface IssuedResetToken {
  token: string;
  expiresAt: Date;
}

/**
 * Creates a single-use reset token. Only its hash is stored; the plaintext is
 * returned once, for a delivery channel to send.
 */
export async function createPasswordResetToken(userId: string): Promise<IssuedResetToken> {
  // Any outstanding tokens become useless as soon as a new one is issued.
  await prisma.passwordResetToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() }
  });

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);

  await prisma.passwordResetToken.create({
    data: { userId, tokenHash: hashToken(token), expiresAt }
  });

  return { token, expiresAt };
}

export type ResetTokenResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "unknown" | "expired" | "already_used" };

/** Validates and burns a reset token in one step — it can never be reused. */
export async function consumePasswordResetToken(token: string): Promise<ResetTokenResult> {
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) }
  });

  if (!record) return { ok: false, reason: "unknown" };
  if (record.usedAt) return { ok: false, reason: "already_used" };
  if (record.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };

  await prisma.passwordResetToken.update({
    where: { id: record.id },
    data: { usedAt: new Date() }
  });

  return { ok: true, userId: record.userId };
}

export async function pruneExpiredResetTokens(now = new Date()): Promise<number> {
  const result = await prisma.passwordResetToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }] }
  });
  return result.count;
}
