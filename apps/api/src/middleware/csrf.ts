import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { CSRF_HEADER } from "../services/auth/sessions.js";
import { HttpError } from "./errorHandler.js";

/**
 * CSRF protection for cookie-authenticated, state-changing requests.
 *
 * The token is minted per session and stored on the session row. It is sent to
 * the browser in a JS-readable cookie, and the SPA echoes it back in the
 * x-csrf-token header. Validation compares the header against the *session's*
 * token server-side, so:
 *   - a cross-site page can't set a custom header, and
 *   - a token belonging to another session doesn't match.
 *
 * Safe methods are untouched: GET/HEAD/OPTIONS don't change state.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function requireCsrfToken(req: Request, _res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  // Runs after requireAuth, so an unauthenticated request has already been
  // rejected with 401 rather than reaching this check.
  if (!req.auth) {
    next(new HttpError(401, "Authentication required"));
    return;
  }

  const provided = req.header(CSRF_HEADER);
  if (!provided || !constantTimeEquals(provided, req.auth.csrfToken)) {
    next(new HttpError(403, "Invalid or missing CSRF token"));
    return;
  }

  next();
}
