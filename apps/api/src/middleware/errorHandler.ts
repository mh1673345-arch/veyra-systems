import type { NextFunction, Request, Response } from "express";

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Errors that carry a stable machine-readable code alongside the message
 * (ENTITLEMENT_REQUIRED, PLAN_LIMIT_REACHED). Their extra fields are exactly
 * what a client needs to explain the restriction — never internals.
 */
interface CodedHttpError extends HttpError {
  code: string;
  entitlement?: string;
  requiredPlan?: string | null;
  limit?: string;
  allowed?: number;
}

function isCoded(err: HttpError): err is CodedHttpError {
  return typeof (err as Partial<CodedHttpError>).code === "string";
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError && isCoded(err)) {
    res.status(err.status).json({
      error: err.message,
      code: err.code,
      ...(err.entitlement !== undefined ? { entitlement: err.entitlement } : {}),
      ...(err.requiredPlan !== undefined ? { requiredPlan: err.requiredPlan } : {}),
      ...(err.limit !== undefined ? { limit: err.limit } : {}),
      ...(err.allowed !== undefined ? { allowed: err.allowed } : {})
    });
    return;
  }

  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }

  console.error(err);
  res.status(500).json({ error: "Internal server error" });
}
