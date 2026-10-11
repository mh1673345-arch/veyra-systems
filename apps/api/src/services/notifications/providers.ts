import type { MessageDeliveryStatus } from "@veyra/shared";
import { currentEnvironment } from "../../config/database.js";
import { ResendEmailProvider, missingResendConfig, resendConfig } from "./resendProvider.js";

/**
 * Delivery adapters. Business logic talks to this interface only, so no vendor
 * SDK leaks into the notification pipeline.
 *
 * The provider is chosen explicitly by VEYRA_EMAIL_PROVIDER — see
 * resolveEmailProviderChoice below — and there are three of them:
 *   - "resend": a real vendor adapter, used only when its credentials exist;
 *   - "console": captures the message locally and says so (providerName
 *     "console"), so nothing ever claims a send that did not happen;
 *   - unconfigured: always fails with the specific reason, so an undelivered
 *     email is recorded as failed rather than sent.
 */

export interface OutboundMessage {
  to: string;
  subject: string;
  body: string;
  /**
   * Stable for the lifetime of one notification — identical on every retry and
   * for every worker — so a vendor that supports idempotency keys can collapse
   * a resend of a message it already accepted (e.g. a worker crashed after the
   * vendor accepted but before the database recorded it). Derived from the
   * notification id only; contains no recipient or content.
   * Optional so adapters without idempotency support can simply ignore it.
   */
  idempotencyKey?: string;
  /**
   * Aborted when this worker loses its claim lease mid-delivery. Adapters that
   * can cancel an in-flight request should honour it; ignoring it is safe,
   * because the stale worker's finalization is rejected either way.
   */
  signal?: AbortSignal;
}

export type DeliveryResult =
  | {
      delivered: true;
      providerName: string;
      detail?: string;
      /** Messaging channels: the provider's id, so a receipt can find the row. */
      providerMessageId?: string | null;
      /** What the provider says so far — "accepted" is not "delivered". */
      deliveryStatus?: MessageDeliveryStatus;
    }
  | {
      delivered: false;
      providerName: string;
      reason: string;
      /**
       * Whether another attempt could plausibly succeed. Left undefined by
       * adapters that cannot tell, which the worker reads as "retry" — the
       * safe default for email. An explicit false means the failure is
       * permanent (bad number, rejected template, opted out) and the worker
       * stops immediately instead of spending four more attempts on it.
       */
      retryable?: boolean;
      deliveryStatus?: MessageDeliveryStatus;
    };

export interface NotificationProvider {
  readonly name: string;
  /** True when the adapter passes OutboundMessage.idempotencyKey to its vendor. */
  readonly supportsIdempotency?: boolean;
  send(message: OutboundMessage): Promise<DeliveryResult>;
}

/** The idempotency key for a notification. Stable across retries and workers. */
export function notificationIdempotencyKey(notificationId: string): string {
  return `veyra-notification:${notificationId}`;
}

/** In-app notifications are "delivered" by existing in the database. */
export class InAppProvider implements NotificationProvider {
  readonly name = "in_app";

  async send(): Promise<DeliveryResult> {
    return { delivered: true, providerName: this.name };
  }
}

/**
 * Development capture. It confirms only that the message was written to the
 * server log — which is why it reports itself as "console" rather than as an
 * email vendor. Captured messages are also kept in memory for tests.
 */
export class ConsoleEmailProvider implements NotificationProvider {
  readonly name = "console";
  readonly supportsIdempotency = true;
  private readonly captured: OutboundMessage[] = [];
  private readonly acceptedKeys = new Set<string>();

  async send(message: OutboundMessage): Promise<DeliveryResult> {
    // Behaves like a vendor with idempotency keys: a repeat of an accepted key
    // is acknowledged without capturing ("sending") the message a second time.
    if (message.idempotencyKey && this.acceptedKeys.has(message.idempotencyKey)) {
      return {
        delivered: true,
        providerName: this.name,
        detail: "duplicate suppressed by idempotency key; no email was sent"
      };
    }
    if (message.idempotencyKey) this.acceptedKeys.add(message.idempotencyKey);
    this.captured.push(message);
    console.log("[veyra:email:console] to=%s subject=%j", message.to, message.subject);
    return {
      delivered: true,
      providerName: this.name,
      detail: "captured by the development console provider; no email was sent"
    };
  }

  messages(): OutboundMessage[] {
    return [...this.captured];
  }

  clear(): void {
    this.captured.length = 0;
    this.acceptedKeys.clear();
  }
}

/** Used when real email is expected but nothing is configured to send it. */
export class UnconfiguredEmailProvider implements NotificationProvider {
  readonly name = "unconfigured";

  /** The specific reason, so an operator is not left guessing which one applies. */
  constructor(private readonly reason = "No email provider is configured.") {}

  async send(): Promise<DeliveryResult> {
    return {
      delivered: false,
      providerName: this.name,
      reason: `${this.reason} Email delivery is unavailable until it is configured.`
    };
  }
}

export type EmailProviderKind = "console" | "resend" | "unconfigured";

export interface EmailProviderChoice {
  kind: EmailProviderKind;
  /** Why, when the choice is "unconfigured". Safe to print: never a secret. */
  reason?: string;
}

/**
 * Which email provider this server will actually use.
 *
 * Deliberately a pure function of the environment, so the startup banner and
 * the factory cannot disagree — the banner used to report "configured" purely
 * because NODE_ENV was not "production", which told an operator nothing about
 * whether a single email could be sent.
 *
 * Selection is explicit. NODE_ENV only ever *removes* an option: the console
 * provider captures mail instead of sending it, so it is refused in production
 * no matter what the variable says.
 */
export function resolveEmailProviderChoice(
  env: NodeJS.ProcessEnv = process.env,
  environment: string = currentEnvironment()
): EmailProviderChoice {
  const requested = (env.VEYRA_EMAIL_PROVIDER ?? "").trim().toLowerCase();
  const production = environment === "production";

  if (requested === "" || requested === "console") {
    if (!production) return { kind: "console" };
    return {
      kind: "unconfigured",
      reason:
        requested === "console"
          ? "The console provider captures mail instead of sending it and is refused in production."
          : "VEYRA_EMAIL_PROVIDER is not set."
    };
  }

  if (requested === "resend") {
    const missing = missingResendConfig(env);
    if (missing.length === 0) return { kind: "resend" };
    return {
      kind: "unconfigured",
      reason: `VEYRA_EMAIL_PROVIDER=resend, but ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set.`
    };
  }

  // Bounded: this is operator-supplied text on its way to a log.
  return {
    kind: "unconfigured",
    reason: `Unknown VEYRA_EMAIL_PROVIDER "${requested.slice(0, 32)}". Use "resend" or "console".`
  };
}

let emailProvider: NotificationProvider | null = null;

export function createEmailProvider(): NotificationProvider {
  if (emailProvider) return emailProvider;

  const choice = resolveEmailProviderChoice();
  if (choice.kind === "resend") {
    const config = resendConfig();
    // resolveEmailProviderChoice already checked this; belt and braces so a
    // missing key can never fall through to a provider that claims success.
    if (config) {
      emailProvider = new ResendEmailProvider(config);
      return emailProvider;
    }
  }

  emailProvider =
    choice.kind === "console" ? new ConsoleEmailProvider() : new UnconfiguredEmailProvider(choice.reason);

  return emailProvider;
}

/** Test seam: swap the provider to simulate failure or assert on captures. */
export function setEmailProvider(provider: NotificationProvider | null): void {
  emailProvider = provider;
}
