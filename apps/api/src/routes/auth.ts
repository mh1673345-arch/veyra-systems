import { Router } from "express";
import { z } from "zod";
import type { AuthSessionResponse, MembershipRole } from "@veyra/shared";
import { prisma } from "../db/client.js";
import { HttpError } from "../middleware/errorHandler.js";
import { requireAuth } from "../middleware/auth.js";
import { requireCsrfToken } from "../middleware/csrf.js";
import { permissionsForRole } from "../services/auth/permissions.js";
import { recordAuthEvent } from "../services/auth/authEvents.js";
import { createRateLimiter } from "../services/auth/rateLimiter.js";
import { validatePassword } from "../services/auth/passwords.js";
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  createSession,
  csrfCookieOptions,
  hashPassword,
  listActiveSessions,
  pruneDeadSessions,
  revokeAllSessionsForUser,
  revokeOtherSessions,
  revokeSession,
  sessionCookieOptions,
  verifyPassword
} from "../services/auth/sessions.js";

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const signupSchema = z.object({
  name: z.string().trim().min(1, "Your name is required.").max(100),
  email: z.string().trim().email("Enter a valid email."),
  password: z.string().min(1, "Choose a password.")
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1)
});

/** Deliberately identical for unknown email, wrong password and disabled user. */
const GENERIC_LOGIN_ERROR = "Invalid email or password";

/**
 * Throttling, not lockout: attempts are counted per email+IP and always expire,
 * so an attacker can't lock someone else out of their account by failing logins
 * from elsewhere. The same 429 is returned whether or not the account exists.
 */
const loginLimiter = createRateLimiter({ maxAttempts: 10, windowMs: 10 * 60 * 1000 });

/** Account creation is throttled per IP so it can't be used to mass-create users. */
const signupLimiter = createRateLimiter({ maxAttempts: 5, windowMs: 60 * 60 * 1000 });

function rateLimitKey(email: string, ip: string | undefined): string {
  return `login:${email.toLowerCase()}|${ip ?? "unknown"}`;
}

/** Exported so tests can start from a clean slate. */
export function resetLoginThrottle(): void {
  void loginLimiter.clear();
  void signupLimiter.clear();
}

function issueSessionCookies(
  res: import("express").Response,
  session: { token: string; csrfToken: string; expiresAt: Date }
) {
  res.cookie(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));
  res.cookie(CSRF_COOKIE, session.csrfToken, csrfCookieOptions(session.expiresAt));
}

function clearSessionCookies(res: import("express").Response) {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.clearCookie(CSRF_COOKIE, { path: "/" });
}

/**
 * Self-service account creation. Same password policy as a password change,
 * throttled per IP, and signs the new user straight in. There is no email
 * verification yet: no email provider exists to send one.
 */
authRouter.post("/auth/signup", async (req, res, next) => {
  try {
    const limit = await signupLimiter.consume(`signup:${req.ip ?? "unknown"}`);
    if (!limit.allowed) {
      res.setHeader("Retry-After", String(limit.retryAfterSeconds));
      throw new HttpError(429, "Too many sign-up attempts. Try again later.");
    }

    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid sign-up details.");
    }
    const email = parsed.data.email.toLowerCase();

    const policy = validatePassword(parsed.data.password, email);
    if (!policy.ok) throw new HttpError(400, policy.error ?? "That password isn't strong enough.");

    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      throw new HttpError(409, "An account with this email already exists. Sign in instead.");
    }

    const user = await prisma.user.create({
      data: { email, name: parsed.data.name, passwordHash: await hashPassword(parsed.data.password) }
    });

    const session = await createSession(user.id);
    issueSessionCookies(res, session);
    await recordAuthEvent({ type: "signup", userId: user.id, req });

    res.status(201).json({ user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/auth/login", async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      // Never echo which field was wrong, or the submitted password.
      throw new HttpError(401, GENERIC_LOGIN_ERROR);
    }

    const email = parsed.data.email.toLowerCase();
    const key = rateLimitKey(email, req.ip);
    const limit = await loginLimiter.consume(key);
    if (!limit.allowed) {
      res.setHeader("Retry-After", String(limit.retryAfterSeconds));
      throw new HttpError(429, "Too many sign-in attempts. Try again later.");
    }

    const user = await prisma.user.findUnique({ where: { email } });

    // Always run a hash comparison so a missing user isn't distinguishable by timing.
    const passwordMatches = user
      ? await verifyPassword(parsed.data.password, user.passwordHash)
      : await verifyPassword(parsed.data.password, await hashPassword("invalid-placeholder"));

    if (!user || !passwordMatches || user.disabledAt) {
      await recordAuthEvent({ type: "login_failed", userId: user?.id ?? null, req });
      throw new HttpError(401, GENERIC_LOGIN_ERROR);
    }

    await loginLimiter.reset(key);

    // A fresh token and CSRF secret every time: a pre-auth cookie can never be
    // promoted into an authenticated session.
    const session = await createSession(user.id);
    issueSessionCookies(res, session);

    await recordAuthEvent({ type: "login_succeeded", userId: user.id, req });
    // Cheap, bounded housekeeping at a natural moment rather than a timer.
    void pruneDeadSessions();

    res.status(200).json({ user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    next(err);
  }
});

/**
 * Requires a live session and a CSRF token, so a third-party page can't sign
 * users out. A client whose session has already gone simply gets 401 and can
 * treat itself as signed out.
 */
authRouter.post("/auth/logout", requireAuth, requireCsrfToken, async (req, res, next) => {
  try {
    const userId = req.auth!.user.id;
    await revokeSession(req.cookies?.[SESSION_COOKIE] as string | undefined);
    clearSessionCookies(res);
    await recordAuthEvent({ type: "logout", userId, req });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/** The signed-in user plus exactly the businesses they belong to. */
authRouter.get("/auth/me", requireAuth, async (req, res, next) => {
  try {
    const memberships = await prisma.businessMembership.findMany({
      where: { userId: req.auth!.user.id },
      include: { business: { select: { id: true, name: true } } },
      orderBy: { createdAt: "asc" }
    });

    const body: AuthSessionResponse = {
      user: req.auth!.user,
      memberships: memberships.map((membership) => ({
        businessId: membership.businessId,
        businessName: membership.business.name,
        role: membership.role as MembershipRole,
        permissions: permissionsForRole(membership.role)
      }))
    };

    // Lets a client that has the session cookie but lost the readable CSRF
    // cookie recover without signing in again.
    res.setHeader("x-csrf-token", req.auth!.csrfToken);
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/** Active sessions for the signed-in user. No device fingerprinting. */
authRouter.get("/auth/sessions", requireAuth, async (req, res, next) => {
  try {
    const sessions = await listActiveSessions(req.auth!.user.id);
    res.json(
      sessions.map((session) => ({
        id: session.id,
        current: session.id === req.auth!.sessionId,
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        lastUsedAt: session.lastUsedAt.toISOString()
      }))
    );
  } catch (err) {
    next(err);
  }
});

/** Sign out everywhere else; the calling session stays valid. */
authRouter.post(
  "/auth/sessions/revoke-others",
  requireAuth,
  requireCsrfToken,
  async (req, res, next) => {
    try {
      const revoked = await revokeOtherSessions(req.auth!.user.id, req.auth!.sessionId);
      await recordAuthEvent({
        type: "sessions_revoked",
        userId: req.auth!.user.id,
        req,
        detail: `revoked ${revoked} other session(s)`
      });
      res.json({ revoked });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Changing a password revokes every existing session — including this one —
 * and then issues a fresh session for the caller, so the browser making the
 * change stays signed in while every other device is signed out.
 */
authRouter.post("/auth/password", requireAuth, requireCsrfToken, async (req, res, next) => {
  try {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "Current and new password are required");
    }

    const user = await prisma.user.findUnique({ where: { id: req.auth!.user.id } });
    if (!user) {
      throw new HttpError(401, "Authentication required");
    }

    const matches = await verifyPassword(parsed.data.currentPassword, user.passwordHash);
    if (!matches) {
      // Never reveals anything about the new password's validity.
      throw new HttpError(403, "Current password is incorrect");
    }

    const policy = validatePassword(parsed.data.newPassword, user.email);
    if (!policy.ok) {
      throw new HttpError(422, policy.error!);
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(parsed.data.newPassword) }
    });

    await revokeAllSessionsForUser(user.id);
    const session = await createSession(user.id);
    issueSessionCookies(res, session);

    await recordAuthEvent({ type: "password_changed", userId: user.id, req });

    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});
