import type { MessagingChannel } from "@veyra/shared";
import { currentEnvironment } from "../../config/database.js";
import {
  FakeMessagingWebhookAdapter,
  FakeSmsProvider,
  FakeWhatsAppProvider,
  fakeMessagingSecret
} from "./providers/fakeMessaging.js";
import {
  MetaWhatsAppProvider,
  metaWhatsAppConfig,
  missingMetaWhatsAppConfig
} from "./providers/metaWhatsApp.js";
import {
  MetaWhatsAppWebhookAdapter,
  metaWebhookConfig
} from "./providers/metaWhatsAppWebhook.js";
import type { MessagingWebhookAdapter, SmsProvider, WhatsAppProvider } from "./types.js";

/**
 * Which adapter serves a channel.
 *
 * Two rules, both deliberate:
 *
 *  - the business row names a provider, but nothing here reads a credential
 *    from it. A tenant chooses *which* integration; the server owns the keys;
 *  - production may never select a simulated provider. A development
 *    stand-in that reached production would silently swallow every customer
 *    message while every status surface showed success.
 *
 * WhatsApp has a real adapter (Meta's Cloud API); SMS does not yet. An
 * unknown name fails closed with a reason rather than falling back to the
 * fake, and a real provider missing its credentials names the variables it
 * needs instead of pretending to be absent.
 */

export class MessagingProviderError extends Error {
  constructor(
    message: string,
    readonly code: "not_configured" | "unknown_provider" | "simulated_in_production"
  ) {
    super(message);
    this.name = "MessagingProviderError";
  }
}

/** The adapter names this build knows about, per channel. */
export const KNOWN_SMS_PROVIDERS = ["fake"] as const;
export const KNOWN_WHATSAPP_PROVIDERS = ["fake", "meta"] as const;

function guardSimulated(name: string, simulated: boolean): void {
  if (simulated && currentEnvironment() === "production") {
    throw new MessagingProviderError(
      `The "${name}" messaging provider is a development stand-in and cannot be used in production.`,
      "simulated_in_production"
    );
  }
}

export function smsProviderFor(name: string | null | undefined): SmsProvider {
  if (!name) {
    throw new MessagingProviderError("No SMS provider is configured for this business.", "not_configured");
  }
  switch (name) {
    case "fake": {
      const provider = new FakeSmsProvider();
      guardSimulated(provider.name, provider.simulated);
      return provider;
    }
    // A real carrier adapter is selected here once an account exists.
    default:
      throw new MessagingProviderError(`Unknown SMS provider "${name}".`, "unknown_provider");
  }
}

export function whatsAppProviderFor(name: string | null | undefined): WhatsAppProvider {
  if (!name) {
    throw new MessagingProviderError("No WhatsApp provider is configured for this business.", "not_configured");
  }
  switch (name) {
    case "fake": {
      const provider = new FakeWhatsAppProvider();
      guardSimulated(provider.name, provider.simulated);
      return provider;
    }
    case "meta": {
      const config = metaWhatsAppConfig();
      if (!config) {
        // Named variables rather than "not configured": a half-set-up Meta
        // app is the normal state, and knowing which half is missing is the
        // whole of the fix.
        throw new MessagingProviderError(
          `Meta WhatsApp is selected but ${missingMetaWhatsAppConfig().join(" and ")} ${
            missingMetaWhatsAppConfig().length === 1 ? "is" : "are"
          } not set.`,
          "not_configured"
        );
      }
      return new MetaWhatsAppProvider(config);
    }
    default:
      throw new MessagingProviderError(`Unknown WhatsApp provider "${name}".`, "unknown_provider");
  }
}

export function messagingProviderFor(
  channel: MessagingChannel,
  name: string | null | undefined
): SmsProvider | WhatsAppProvider {
  return channel === "sms" ? smsProviderFor(name) : whatsAppProviderFor(name);
}

/**
 * The webhook adapter for a provider. Returns null when this server has no
 * way to verify that provider's signatures — which is a refusal to accept the
 * webhook at all, not an invitation to skip verification.
 */
export function messagingWebhookAdapterFor(provider: string): MessagingWebhookAdapter | null {
  if (provider === "meta") {
    // Needs both the app secret (to prove a POST came from Meta) and the
    // verify token (for the subscription handshake). Without them there is
    // no way to tell a genuine webhook from a forged one, so none is
    // accepted at all.
    const config = metaWebhookConfig();
    return config ? new MetaWhatsAppWebhookAdapter(config) : null;
  }
  if (provider === "fake") {
    if (currentEnvironment() === "production") return null;
    const secret = fakeMessagingSecret();
    return secret ? new FakeMessagingWebhookAdapter(secret) : null;
  }
  return null;
}
