import type { NextFunction, Request, Response } from "express";
import type { MembershipRole, Permission } from "@veyra/shared";
import { prisma } from "../db/client.js";
import { HttpError } from "./errorHandler.js";
import { SESSION_COOKIE, resolveSession } from "../services/auth/sessions.js";
import { roleHasPermission } from "../services/auth/permissions.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: {
        sessionId: string;
        csrfToken: string;
        user: { id: string; email: string; name: string };
      };
      membership?: { businessId: string; role: MembershipRole };
    }
  }
}

/**
 * Placeholder auth for the *public reception demo* endpoints only: checks a
 * shared secret header against VEYRA_API_KEY. The operator dashboard does not
 * use this — it requires an authenticated session (see requireAuth).
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.VEYRA_API_KEY;
  if (!expected) {
    next();
    return;
  }

  const provided = req.header("x-api-key");
  if (provided !== expected) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

/** Rejects anything without a valid, unexpired, unrevoked session. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    const session = await resolveSession(token);
    if (!session) {
      throw new HttpError(401, "Authentication required");
    }
    req.auth = session;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Authorization for a specific business: the caller must be authenticated, be
 * a member of the business in the URL, and hold the required permission.
 *
 * A non-member gets 404 rather than 403 so the dashboard can't be used to
 * enumerate businesses the user has nothing to do with. A member who lacks the
 * permission gets 403, because the resource's existence isn't a secret to them.
 */
export function requireBusinessPermission(permission: Permission) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.auth) {
        throw new HttpError(401, "Authentication required");
      }

      const businessId = req.params.businessId;
      if (!businessId) {
        throw new HttpError(400, "A business is required");
      }

      const membership = await prisma.businessMembership.findUnique({
        where: { userId_businessId: { userId: req.auth.user.id, businessId } }
      });

      if (!membership) {
        throw new HttpError(404, "Business not found");
      }

      if (!roleHasPermission(membership.role, permission)) {
        throw new HttpError(403, "You do not have permission to do that");
      }

      req.membership = { businessId, role: membership.role as MembershipRole };
      next();
    } catch (err) {
      next(err);
    }
  };
}
