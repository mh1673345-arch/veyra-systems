import { AnthropicResponder } from "./anthropicResponder.js";
import { RuleBasedResponder } from "./ruleBasedResponder.js";
import type {
  AiResponder,
  AssistantResult,
  FallbackReason,
  PrimaryResponder,
  RespondParams,
  ResponderName
} from "./types.js";

export type {
  AiResponder,
  AssistantResult,
  BusinessContext,
  ConversationTurn,
  FallbackReason,
  RespondParams,
  ResponderName
} from "./types.js";
export { AnthropicResponder, MIN_CONFIDENCE } from "./anthropicResponder.js";
export { RuleBasedResponder, classifyMessage } from "./ruleBasedResponder.js";

/** What actually answered a turn, for server-side observability. */
export interface RespondTrace {
  responder: ResponderName;
  fallbackReason: FallbackReason | null;
}

export interface TracedResult {
  result: AssistantResult;
  trace: RespondTrace;
}

/**
 * Anthropic is the primary responder when configured; the deterministic
 * responder answers whenever it can't be used or can't be trusted — missing key,
 * provider error, malformed output, an unsupported action, or low confidence.
 * The caller never sees which one answered.
 */
export class ReceptionistResponder implements AiResponder {
  readonly name: ResponderName;
  private readonly primary: PrimaryResponder | null;
  private readonly fallback: RuleBasedResponder;

  constructor(primary: PrimaryResponder | null, fallback = new RuleBasedResponder()) {
    this.primary = primary;
    this.fallback = fallback;
    this.name = primary ? primary.name : fallback.name;
  }

  async respondTraced(params: RespondParams): Promise<TracedResult> {
    if (!this.primary) {
      const result = await this.fallback.respond(params);
      return { result, trace: { responder: this.fallback.name, fallbackReason: "no_api_key" } };
    }

    const outcome = await this.primary.attempt(params);
    if (outcome.ok) {
      return { result: outcome.result, trace: { responder: this.primary.name, fallbackReason: null } };
    }

    const result = await this.fallback.respond(params);
    return { result, trace: { responder: this.fallback.name, fallbackReason: outcome.reason } };
  }

  async respond(params: RespondParams): Promise<AssistantResult> {
    const { result } = await this.respondTraced(params);
    return result;
  }
}

/**
 * Builds the responder pipeline for a request. Reads the key at call time so a
 * changed environment takes effect without a restart (and so tests can toggle it).
 */
export function createAiResponder(): ReceptionistResponder {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return new ReceptionistResponder(null);
  }

  return new ReceptionistResponder(new AnthropicResponder(apiKey, process.env.ANTHROPIC_MODEL));
}
