import { Router } from "express";
import { prisma } from "../db/client.js";
import { currentEnvironment } from "../config/database.js";
import { providerHealthSnapshot } from "../services/ai/telemetry.js";

export const healthRouter = Router();

/** Liveness: is this process up? Deliberately does no I/O. */
healthRouter.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

/**
 * Readiness: can this process actually serve traffic?
 *
 * The database is required — nothing works without it. Anthropic is NOT:
 * Reception stays fully operational on the deterministic responder, so a
 * provider outage must not pull the instance out of the load balancer. Provider
 * degradation is reported instead, for internal visibility.
 */
healthRouter.get("/ready", async (_req, res) => {
  const provider = providerHealthSnapshot();
  const checks: Record<string, string> = {};
  let ready = true;

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch {
    checks.database = "unreachable";
    ready = false;
  }

  checks.config = process.env.DATABASE_URL ? "ok" : "missing DATABASE_URL";
  if (!process.env.DATABASE_URL) ready = false;

  // Informational only — never gates readiness.
  checks.responder = process.env.ANTHROPIC_API_KEY ? "anthropic" : "rule-based";
  checks.provider = provider.degraded ? "degraded" : provider.lastOutcome;

  res.status(ready ? 200 : 503).json({
    ready,
    environment: currentEnvironment(),
    checks,
    providerDegraded: provider.degraded,
    // No key material, no prompts — just the shape of recent behaviour.
    lastProviderFallbackReason: provider.lastFallbackReason
  });
});
