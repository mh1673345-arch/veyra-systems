import type { DeliveryResult, NotificationProvider, OutboundMessage } from "./providers.js";

/**
 * Resend email delivery.
 *
 * Talks to the documented REST endpoint with fetch rather than the vendor SDK:
 * the notification pipeline already owns retries, claim leases and idempotency,
 * so an SDK would only add a second opinion about all three. Nothing
 * Resend-shaped leaves this file — callers see DeliveryResult and nothing else.
 */

const DEFAULT_ENDPOINT = "https://api.resend.com/emails";

/** A send that hangs holds a claim lease open, so it is bounded. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Enough of a provider error to act on, without pasting a whole payload into the log. */
const MAX_REASON_CHARS = 200;

export interface ResendConfig {
  apiKey: string;
  /** Must be a sender Resend has verified for this account. */
  from: string;
  replyTo: string | null;
  endpoint: string;
}

/** The variables a half-configured Resend setup is missing, by name only. */
export function missingResendConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  const missing: string[] = [];
  if (!env.RESEND_API_KEY?.trim()) missing.push("RESEND_API_KEY");
  if (!env.VEYRA_EMAIL_FROM?.trim()) missing.push("VEYRA_EMAIL_FROM");
  return missing;
}

export function resendConfig(env: NodeJS.ProcessEnv = process.env): ResendConfig | null {
  if (missingResendConfig(env).length > 0) return null;
  return {
    apiKey: env.RESEND_API_KEY!.trim(),
    from: env.VEYRA_EMAIL_FROM!.trim(),
    // An empty string is "not set", not an empty reply-to header.
    replyTo: env.VEYRA_EMAIL_REPLY_TO?.trim() || null,
    endpoint: env.RESEND_API_URL?.trim() || DEFAULT_ENDPOINT
  };
}

export class ResendEmailProvider implements NotificationProvider {
  readonly name = "resend";
  /** Resend collapses repeats of an Idempotency-Key for 24 hours. */
  readonly supportsIdempotency = true;

  constructor(private readonly config: ResendConfig) {}

  /**
   * The key can only reach a log through an error string, so every reason is
   * passed through here on the way out. Belt and braces: Resend does not echo
   * the Authorization header back, but a proxy or a future endpoint might.
   */
  private redact(text: string): string {
    if (!this.config.apiKey) return text;
    return text.split(this.config.apiKey).join("[redacted]");
  }

  /** The provider's own words where it has any, bounded, never the raw payload. */
  private summarize(body: string): string {
    try {
      const parsed = JSON.parse(body) as { message?: string; error?: { message?: string } };
      const message = parsed.error?.message ?? parsed.message;
      if (message) return message.slice(0, MAX_REASON_CHARS);
    } catch {
      // Not JSON — fall through to the bounded raw text.
    }
    return body.trim().slice(0, MAX_REASON_CHARS) || "no detail given";
  }

  async send(message: OutboundMessage): Promise<DeliveryResult> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = message.signal ? AbortSignal.any([message.signal, timeout]) : timeout;

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.config.apiKey}`,
      "content-type": "application/json"
    };
    // Lets Resend collapse the one case the pipeline cannot rule out: the
    // vendor accepted, then the process died before the database recorded it.
    if (message.idempotencyKey) headers["idempotency-key"] = message.idempotencyKey;

    let response: Response;
    try {
      response = await fetch(this.config.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          from: this.config.from,
          to: [message.to],
          subject: message.subject,
          text: message.body,
          ...(this.config.replyTo ? { reply_to: this.config.replyTo } : {})
        }),
        signal
      });
    } catch (err) {
      return { delivered: false, providerName: this.name, reason: this.redact(this.describeAbort(err, message)) };
    }

    const raw = await response.text().catch(() => "");

    if (!response.ok) {
      return {
        delivered: false,
        providerName: this.name,
        reason: this.redact(`Resend returned ${response.status}: ${this.summarize(raw)}`)
      };
    }

    // The id is what an operator needs to find the message in Resend's own log.
    let id: string | null = null;
    try {
      id = (JSON.parse(raw) as { id?: string }).id ?? null;
    } catch {
      // Accepted but unparseable: still accepted.
    }
    return {
      delivered: true,
      providerName: this.name,
      detail: id ? `accepted by Resend as ${id}` : "accepted by Resend"
    };
  }

  /** Why the request never completed — the three cases read very differently. */
  private describeAbort(err: unknown, message: OutboundMessage): string {
    if (message.signal?.aborted) {
      return "Cancelled before Resend responded: this worker lost its claim lease.";
    }
    if (err instanceof Error && err.name === "TimeoutError") {
      return `Resend did not respond within ${REQUEST_TIMEOUT_MS / 1000}s.`;
    }
    return `Resend could not be reached: ${err instanceof Error ? err.message : "unknown error"}`;
  }
}
