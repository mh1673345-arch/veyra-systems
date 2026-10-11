import type { MessagingResult, OutboundWhatsApp, WhatsAppProvider } from "../types.js";

/**
 * WhatsApp through Meta's Cloud API.
 *
 * Direct to Meta rather than through a telephony carrier: WhatsApp is its own
 * platform with its own rules, and routing it through an SMS vendor would
 * mean inheriting their interpretation of those rules as well as their
 * pricing.
 *
 * Two of Meta's constraints are already modelled upstream, so this adapter
 * does not re-decide them:
 *   - a business-initiated message needs an approved template. The caller has
 *     resolved that (see templates.ts) and passes either kind: "session" or
 *     kind: "template";
 *   - the recipient must be reachable. On a test app that means a number
 *     added to the allowed list in the dashboard; Meta refuses anything else,
 *     and that refusal is surfaced verbatim rather than retried.
 *
 * Nothing Meta-shaped leaves this file, and the access token cannot: every
 * error string is passed through a redactor on the way out.
 */

export interface MetaWhatsAppConfig {
  accessToken: string;
  /** The sender's id in the Cloud API. Not a phone number. */
  phoneNumberId: string;
  /** Recorded for operators; not needed to send. */
  businessAccountId: string | null;
  graphVersion: string;
  baseUrl: string;
}

/** A send that hangs holds a claim lease open, so it is bounded. */
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REASON_CHARS = 240;

/** The variables Meta needs before Veyra can send anything at all. */
export function missingMetaWhatsAppConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  const missing: string[] = [];
  if (!env.META_WHATSAPP_ACCESS_TOKEN?.trim()) missing.push("META_WHATSAPP_ACCESS_TOKEN");
  if (!env.META_WHATSAPP_PHONE_NUMBER_ID?.trim()) missing.push("META_WHATSAPP_PHONE_NUMBER_ID");
  return missing;
}

export function metaWhatsAppConfig(env: NodeJS.ProcessEnv = process.env): MetaWhatsAppConfig | null {
  if (missingMetaWhatsAppConfig(env).length > 0) return null;
  return {
    accessToken: env.META_WHATSAPP_ACCESS_TOKEN!.trim(),
    phoneNumberId: env.META_WHATSAPP_PHONE_NUMBER_ID!.trim(),
    businessAccountId: env.META_WHATSAPP_BUSINESS_ACCOUNT_ID?.trim() || null,
    graphVersion: env.META_GRAPH_VERSION?.trim() || "v21.0",
    baseUrl: env.META_GRAPH_URL?.trim() || "https://graph.facebook.com"
  };
}

/**
 * Meta error codes that mean "try again later" rather than "never".
 *
 * Everything else in the 4xx range is treated as permanent, because the usual
 * causes — a recipient not on the test allow-list, an unapproved template, a
 * token that has expired — will refuse exactly as firmly in an hour, and
 * retrying them only delays an operator finding out.
 */
const RETRYABLE_META_CODES = new Set([
  130429, // throughput rate limit
  131056, // per-recipient pair rate limit
  133016 // business account temporarily locked for rate limiting
]);

interface MetaErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_data?: { details?: string };
    fbtrace_id?: string;
  };
}

interface MetaSendResponse {
  messages?: { id?: string; message_status?: string }[];
  contacts?: { input?: string; wa_id?: string }[];
}

export class MetaWhatsAppProvider implements WhatsAppProvider {
  readonly name = "meta";
  readonly channel = "whatsapp" as const;
  /** A real vendor: nothing about this is a development stand-in. */
  readonly simulated = false;

  constructor(private readonly config: MetaWhatsAppConfig) {}

  /**
   * The token can only reach a log through an error string, so every reason
   * goes through here. Meta does not echo the Authorization header back, but
   * a proxy or a future endpoint might, and a leaked token is a leaked
   * WhatsApp account.
   */
  private redact(text: string): string {
    if (!this.config.accessToken) return text;
    return text.split(this.config.accessToken).join("[redacted]");
  }

  private endpoint(path: string): string {
    return `${this.config.baseUrl}/${this.config.graphVersion}/${path}`;
  }

  /**
   * Meta wants the number without a leading "+". Veyra stores E.164, so the
   * plus is stripped here rather than anywhere upstream — the canonical form
   * stays canonical everywhere except on the wire.
   */
  private wireNumber(e164: string): string {
    return e164.replace(/^\+/, "");
  }

  private payloadFor(message: OutboundWhatsApp): Record<string, unknown> {
    const to = this.wireNumber(message.to);

    if (message.kind === "session") {
      return {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        // No link previews: a confirmation is not a place to render someone
        // else's page.
        text: { preview_url: false, body: message.body }
      };
    }

    return {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template: {
        name: message.templateName,
        language: { code: message.templateLanguage },
        // Only sent when the template actually declares variables: Meta
        // rejects a components array a template did not ask for.
        ...(message.templateVariables.length > 0
          ? {
              components: [
                {
                  type: "body",
                  parameters: message.templateVariables.map((text) => ({ type: "text", text }))
                }
              ]
            }
          : {})
      }
    };
  }

  async sendWhatsAppMessage(message: OutboundWhatsApp): Promise<MessagingResult> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = message.signal ? AbortSignal.any([message.signal, timeout]) : timeout;

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.config.accessToken}`,
      "content-type": "application/json"
    };

    let response: Response;
    try {
      response = await fetch(this.endpoint(`${this.config.phoneNumberId}/messages`), {
        method: "POST",
        headers,
        body: JSON.stringify(this.payloadFor(message)),
        signal
      });
    } catch (err) {
      return this.failure(this.describeAbort(err, message), { retryable: true });
    }

    const raw = await response.text().catch(() => "");

    if (!response.ok) {
      const parsed = this.parseError(raw);
      const retryable =
        response.status === 429 ||
        response.status >= 500 ||
        (parsed.code !== null && RETRYABLE_META_CODES.has(parsed.code));
      return this.failure(`Meta returned ${response.status}: ${parsed.message}`, { retryable });
    }

    let body: MetaSendResponse = {};
    try {
      body = JSON.parse(raw) as MetaSendResponse;
    } catch {
      // Accepted but unparseable: still accepted, just without an id.
    }

    const providerMessageId = body.messages?.[0]?.id ?? null;
    return {
      accepted: true,
      providerMessageId,
      // Meta's own word for a message it has taken. It is not delivery, and a
      // webhook receipt is the only thing that can upgrade it.
      status: "accepted",
      detail: providerMessageId
        ? `accepted by Meta as ${providerMessageId}`
        : "accepted by Meta",
      retryable: false,
      timestamp: new Date()
    };
  }

  private failure(reason: string, options: { retryable: boolean }): MessagingResult {
    return {
      accepted: false,
      providerMessageId: null,
      status: "failed",
      detail: this.redact(reason).slice(0, MAX_REASON_CHARS),
      retryable: options.retryable,
      timestamp: new Date()
    };
  }

  /** Meta's own words where it gives any, bounded, never the raw payload. */
  private parseError(raw: string): { message: string; code: number | null } {
    try {
      const parsed = JSON.parse(raw) as MetaErrorBody;
      const error = parsed.error;
      if (error) {
        const detail = error.error_data?.details;
        return {
          message: [error.message, detail].filter(Boolean).join(" — ") || "no detail given",
          code: typeof error.code === "number" ? error.code : null
        };
      }
    } catch {
      // Not JSON — fall through to the bounded raw text.
    }
    return { message: raw.trim().slice(0, MAX_REASON_CHARS) || "no detail given", code: null };
  }

  private describeAbort(err: unknown, message: OutboundWhatsApp): string {
    if (message.signal?.aborted) {
      return "Cancelled before Meta responded: this worker lost its claim lease.";
    }
    if (err instanceof Error && err.name === "TimeoutError") {
      return `Meta did not respond within ${REQUEST_TIMEOUT_MS / 1000}s.`;
    }
    return `Meta could not be reached: ${err instanceof Error ? err.message : "unknown error"}`;
  }

  /**
   * Reachability, without spending a message on every Console load. Reading
   * the sender's own record proves the token works and the phone number id
   * belongs to it, which are the two things that actually break.
   */
  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const response = await fetch(
        `${this.endpoint(this.config.phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`,
        {
          headers: { authorization: `Bearer ${this.config.accessToken}` },
          signal: AbortSignal.timeout(8000)
        }
      );
      const raw = await response.text().catch(() => "");

      if (!response.ok) {
        const parsed = this.parseError(raw);
        // A temporary token expiring is the single most likely cause here, so
        // it is named rather than left as "something went wrong".
        const expired = response.status === 401 || parsed.code === 190;
        return {
          ok: false,
          detail: this.redact(
            expired
              ? `Meta rejected the access token (${parsed.message}). A temporary token expires after 24 hours.`
              : `Meta returned ${response.status}: ${parsed.message}`
          ).slice(0, MAX_REASON_CHARS)
        };
      }

      const body = JSON.parse(raw) as { display_phone_number?: string; verified_name?: string; quality_rating?: string };
      return {
        ok: true,
        detail: `Meta WhatsApp reachable as ${body.verified_name ?? "this sender"}${
          body.quality_rating ? ` (quality ${body.quality_rating})` : ""
        }.`
      };
    } catch {
      return { ok: false, detail: "Meta could not be reached." };
    }
  }
}
