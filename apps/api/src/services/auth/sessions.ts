import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../../db/client.js";

/**
 * Opaque server-side sessions. A random token goes to the client in an
 * httpOnly cookie; only its SHA-256 hash is stored, so a database leak doesn't
 * hand over live sessions. Server-side records also mean sign-out, disabling a
 * user and "sign out everywhere" take effect immediately, which a stateless
 * JWT can't do.
 */

export const SESSION_COOKIE = "veyra_session";
/** Readable by JS on purpose: the SPA echoes it back in the x-csrf-token header. */
export const CSRF_COOKIE = "veyra_csrf";
export const CSRF_HEADER = "x-csrf-token";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const BCRYPT_ROUNDS = 12;
/** Avoid a write on every request; only refresh lastUsedAt when it's stale. */
const LAST_USED_REFRESH_MS = 60 * 1000;
/** Revoked rows are kept briefly so "why did I get signed out" is diagnosable. */
const REVOKED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

export interface IssuedSession {
  token: string;
  csrfToken: string;
  expiresAt: Date;
  sessionId: string;
}

/**
 * Always mints a brand-new token and CSRF secret, so a session is never
 * "upgraded" in place — a pre-authentication cookie can't become an
 * authenticated one (session fixation).
 */
export async function createSession(userId: string): Promise<IssuedSession> {
  const token = randomBytes(32).toString("hex");
  const csrfToken = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  const session = await prisma.session.create({
    data: { userId, tokenHash: hashToken(token), csrfToken, expiresAt }
  });

  return { token, csrfToken, expiresAt, sessionId: session.id };
}

export interface ResolvedSession {
  sessionId: string;
  csrfToken: string;
  user: { id: string; email: string; name: string };
}

/**
 * Returns null for anything untrustworthy: unknown or tampered token, expired
 * session, revoked session, or a user who has since been disabled.
 */
export async function resolveSession(token: string | undefined): Promise<ResolvedSession | null> {
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true }
  });
  if (!session) return null;

  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;
  if (session.user.disabledAt) return null;

  if (Date.now() - session.lastUsedAt.getTime() > LAST_USED_REFRESH_MS) {
    await prisma.session.update({
      where: { id: session.id },
      data: { lastUsedAt: new Date() }
    });
  }

  return {
    sessionId: session.id,
    csrfToken: session.csrfToken,
    user: { id: session.user.id, email: session.user.email, name: session.user.name }
  };
}

export async function revokeSession(token: string | undefined): Promise<void> {
  if (!token) return;
  await prisma.session.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() }
  });
}

/** Used when a user is disabled or removed, so existing sessions stop working. */
export async function revokeAllSessionsForUser(userId: string): Promise<number> {
  const result = await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() }
  });
  return result.count;
}

/** "Sign out everywhere else" — keeps the caller's current session alive. */
export async function revokeOtherSessions(userId: string, keepSessionId: string): Promise<number> {
  const result = await prisma.session.updateMany({
    where: { userId, revokedAt: null, id: { not: keepSessionId } },
    data: { revokedAt: new Date() }
  });
  return result.count;
}

/**
 * Opportunistic pruning. Only removes rows that are already dead: expired, or
 * revoked long enough ago to be uninteresting. Active sessions are never
 * touched. Called at startup and after each login rather than on a timer, so
 * there's no background job to fail silently.
 */
export async function pruneDeadSessions(now = new Date()): Promise<number> {
  const result = await prisma.session.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: now } },
        { revokedAt: { lt: new Date(now.getTime() - REVOKED_RETENTION_MS) } }
      ]
    }
  });
  return result.count;
}

export async function listActiveSessions(userId: string) {
  return prisma.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true, expiresAt: true, lastUsedAt: true }
  });
}

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
    path: "/"
  };
}

/** Deliberately readable by JS — it is echoed back in a header, not a secret at rest. */
export function csrfCookieOptions(expiresAt: Date) {
  return {
    httpOnly: false,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
    path: "/"
  };
}
