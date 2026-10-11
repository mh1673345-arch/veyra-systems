import type { AssistantAction, AssistantIntent } from "@veyra/shared";
import type { FallbackReason, ResponderName } from "./types.js";

/**
 * Structured observability for provider calls.
 *
 * Everything here is deliberately safe to log in production: it records what
 * happened and how expensive it was, never the system prompt, the caller's
 * message, API keys, session tokens or any other secret.
 */
export interface ProviderTelemetry {
  responder: ResponderName;
  model?: string;
  promptVersion?: string;
  durationMs: number;
  outcome: "success" | "fallback";
  fallbackReason?: FallbackReason;
  intent?: AssistantIntent;
  action?: AssistantAction;
  confidence?: number;
  /** Provider-reported token usage, when exposed. */
  inputTokens?: number;
  outputTokens?: number;
  attempts?: number;
  /** Set when grounding had to be capped, so silent truncation is visible. */
  contextTruncated?: boolean;
  historyTurns?: number;
}

/**
 * Emitted as a single structured line. `VEYRA_DEBUG_INTENT=verbose` adds the
 * caller's message elsewhere in the request path; nothing here ever includes it.
 */
export function recordProviderTelemetry(telemetry: ProviderTelemetry): void {
  const fields = [
    `responder=${telemetry.responder}`,
    telemetry.model ? `model=${telemetry.model}` : null,
    telemetry.promptVersion ? `promptVersion=${telemetry.promptVersion}` : null,
    `outcome=${telemetry.outcome}`,
    telemetry.fallbackReason ? `fallbackReason=${telemetry.fallbackReason}` : null,
    `durationMs=${telemetry.durationMs}`,
    telemetry.attempts !== undefined ? `attempts=${telemetry.attempts}` : null,
    telemetry.intent ? `intent=${telemetry.intent}` : null,
    telemetry.action ? `action=${telemetry.action}` : null,
    telemetry.confidence !== undefined ? `confidence=${telemetry.confidence.toFixed(2)}` : null,
    telemetry.inputTokens !== undefined ? `inputTokens=${telemetry.inputTokens}` : null,
    telemetry.outputTokens !== undefined ? `outputTokens=${telemetry.outputTokens}` : null,
    telemetry.historyTurns !== undefined ? `historyTurns=${telemetry.historyTurns}` : null,
    telemetry.contextTruncated ? "contextTruncated=true" : null
  ].filter(Boolean);

  console.log("[veyra:provider] %s", fields.join(" "));
}

/** Rolling snapshot of provider health, exposed to readiness as degradation info. */
interface ProviderHealth {
  lastOutcome: "success" | "fallback" | "unknown";
  lastFallbackReason: FallbackReason | null;
  consecutiveFailures: number;
  lastCallAt: string | null;
}

const health: ProviderHealth = {
  lastOutcome: "unknown",
  lastFallbackReason: null,
  consecutiveFailures: 0,
  lastCallAt: null
};

export function noteProviderOutcome(
  outcome: "success" | "fallback",
  reason?: FallbackReason
): void {
  health.lastOutcome = outcome;
  health.lastCallAt = new Date().toISOString();
  if (outcome === "success") {
    health.consecutiveFailures = 0;
    health.lastFallbackReason = null;
  } else {
    health.consecutiveFailures += 1;
    health.lastFallbackReason = reason ?? null;
  }
}

export function providerHealthSnapshot(): ProviderHealth & { degraded: boolean } {
  return {
    ...health,
    // Degraded, not unhealthy: the deterministic responder still answers callers.
    degraded: health.consecutiveFailures >= 3
  };
}

/** Test seam. */
export function resetProviderHealth(): void {
  health.lastOutcome = "unknown";
  health.lastFallbackReason = null;
  health.consecutiveFailures = 0;
  health.lastCallAt = null;
}
