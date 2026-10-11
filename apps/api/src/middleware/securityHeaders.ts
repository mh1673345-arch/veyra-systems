import type { NextFunction, Request, Response } from "express";

/**
 * Security headers for the API. This service returns JSON only — it never
 * serves HTML — so the CSP is deliberately restrictive rather than a copy of a
 * page-serving policy: nothing should ever be loaded or framed from here.
 *
 * The web app is served separately by Vite (dev) or a static host (production),
 * and needs its own CSP there; these headers do not cover it.
 */
export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  // Nothing embeds or loads from an API response.
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  // Clickjacking protection for older browsers that ignore frame-ancestors.
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");

  // HSTS only makes sense over real HTTPS, and asserting it in development
  // would pin localhost to https in the browser.
  if (process.env.NODE_ENV === "production" && req.secure) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  next();
}
