import type { AssistantAction, AssistantIntent, BusinessCapabilities, ClosingStyle, ReceptionTone } from "@veyra/shared";

export interface BusinessServiceContext {
  name: string;
  description: string;
  priceLabel: string;
}

export interface BusinessFaqContext {
  question: string;
  answer: string;
}

/** Everything the AI responder is allowed to know about the business it's answering for. */
export interface BusinessContext {
  name: string;
  description: string;
  hours: string;
  location: string;
  contactPhone: string | null;
  contactEmail: string | null;
  bookingRules: string;
  escalationRules: string;
  /** What this business can actually do — the responder must not offer more. */
  capabilities: BusinessCapabilities;
  /** Structured presentation choices (never free-form instructions). */
  assistantName?: string | null;
  tone?: ReceptionTone;
  closingStyle?: ClosingStyle;
  /** Where callers are pointed when they need a person. */
  escalationContact?: { phone: string | null; email: string | null };
  /** The business's own words for when Reception can't help. */
  fallbackMessage?: string | null;
  services: BusinessServiceContext[];
  faqs: BusinessFaqContext[];
}

export interface ConversationTurn {
  role: "caller" | "receptionist";
  text: string;
}

/**
 * The single structured result every responder produces. `action` is explicit
 * and machine-readable so the client never has to infer intent from prose.
 */
export interface AssistantResult {
  intent: AssistantIntent;
  message: string;
  /** 0..1. Rule-based values are fixed per branch; Anthropic self-reports. */
  confidence: number;
  action: AssistantAction;
  requiresClarification: boolean;
}

export interface RespondParams {
  callerText: string;
  /** Bounded prior turns, oldest first. Does not include callerText itself. */
  history: ConversationTurn[];
  context: BusinessContext;
}

export type ResponderName = "anthropic" | "rule-based";

/** Why the primary responder was not used for a given turn. */
export type FallbackReason =
  | "no_api_key"
  | "provider_error"
  /** The call was cancelled after the timeout; the outcome is unknowable. */
  | "provider_timeout"
  | "invalid_output"
  | "low_confidence"
  | "unsupported_action";

export type ResponderOutcome =
  | { ok: true; result: AssistantResult }
  | { ok: false; reason: FallbackReason };

/** A responder that always produces an answer (i.e. the deterministic one, or the pipeline). */
export interface AiResponder {
  readonly name: ResponderName;
  respond(params: RespondParams): Promise<AssistantResult>;
}

/** A responder that may decline, handing over to the deterministic fallback. */
export interface PrimaryResponder {
  readonly name: ResponderName;
  attempt(params: RespondParams): Promise<ResponderOutcome>;
}
