/**
 * Cost and safety limits for generative calls, kept in one place so they can be
 * reviewed (and tested) without reading the responder.
 */

/**
 * The system prompt's version. Behaviour changes as this prompt changes, so the
 * version is recorded in telemetry and on generated messages — bump it whenever
 * the prompt's meaning changes, not for typo fixes.
 */
export const PROMPT_VERSION = "reception_prompt_v1";

/** Hard ceiling on generated output. Replies are a couple of sentences. */
export const MAX_OUTPUT_TOKENS = 512;

/** How long a caller waits before the deterministic responder answers instead. */
export const PROVIDER_TIMEOUT_MS = 8_000;

/**
 * Conservative retry policy. A generative call is not safely repeatable: a
 * second attempt can produce a different intent and a different action, so we
 * only retry when we know the model never saw the request.
 */
export const MAX_PROVIDER_ATTEMPTS = 2;

/** Bounded conversation memory sent to the provider. */
export const MAX_HISTORY_TURNS = 12;
/** Per-turn character cap, so one pasted essay can't dominate the window. */
export const MAX_TURN_CHARS = 1_000;

/** Anything longer than this is not a receptionist question. */
export const MAX_CALLER_TEXT_CHARS = 2_000;

/**
 * Grounding caps. These are generous on purpose: truncating the business
 * context is how a model starts inventing prices, so the limits sit well above
 * a realistic small business and are reported when they bite.
 */
export const MAX_CONTEXT_SERVICES = 50;
export const MAX_CONTEXT_FAQS = 50;

export interface TrimResult<T> {
  items: T[];
  /** True when something was dropped, so the caller can log it rather than silently losing grounding. */
  truncated: boolean;
}

export function capItems<T>(items: T[], max: number): TrimResult<T> {
  if (items.length <= max) return { items, truncated: false };
  return { items: items.slice(0, max), truncated: true };
}

export function capTurnText(text: string): string {
  return text.length <= MAX_TURN_CHARS ? text : `${text.slice(0, MAX_TURN_CHARS)}…`;
}
