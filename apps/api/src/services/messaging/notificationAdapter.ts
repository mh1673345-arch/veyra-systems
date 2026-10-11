import type { MessagingChannel } from "@veyra/shared";
import { prisma } from "../../db/client.js";
import type { DeliveryResult, NotificationProvider, OutboundMessage } from "../notifications/providers.js";
import { formatForChannel } from "./format.js";
import { messagingProviderFor, MessagingProviderError } from "./registry.js";
import { outboundModeFor, resolveTemplate, TemplateUnavailableError } from "./templates.js";
import { canSendToCustomer } from "./consent.js";
import type { MessagingResult } from "./types.js";

/**
 * Lets the notification worker deliver an SMS or WhatsApp message without
 * knowing anything about either.
 *
 * The worker speaks NotificationProvider; the messaging layer speaks
 * SmsProvider / WhatsAppProvider. This translates, and it is the only place
 * the two vocabularies meet.
 *
 * The checks that ran when the message was queued are re-run here on purpose.
 * A notification can sit in the queue through a retry schedule measured in
 * hours, and in that time a customer can text STOP, an operator can switch
 * the channel off, or a plan can lapse. Sending on the strength of a decision
 * made an hour ago is how someone receives a message after opting out.
 */

function mapResult(providerName: string, result: MessagingResult): DeliveryResult {
  if (result.accepted) {
    return {
      delivered: true,
      providerName,
      detail: result.detail,
      providerMessageId: result.providerMessageId,
      // Never "delivered": the provider has taken the message, that is all.
      deliveryStatus: result.status
    };
  }
  return {
    delivered: false,
    providerName,
    reason: result.detail,
    retryable: result.retryable,
    deliveryStatus: result.status
  };
}

/** A permanent refusal, shaped so the worker stops rather than retrying. */
function permanent(providerName: string, reason: string): DeliveryResult {
  return { delivered: false, providerName, reason, retryable: false, deliveryStatus: "failed" };
}

export function messagingNotificationProvider(channel: MessagingChannel, businessId: string): NotificationProvider {
  return {
    name: `messaging:${channel}`,
    supportsIdempotency: true,

    async send(message: OutboundMessage): Promise<DeliveryResult> {
      const settings = await prisma.messagingSettings.findUnique({ where: { businessId } });
      const enabled = channel === "sms" ? settings?.smsEnabled : settings?.whatsappEnabled;
      const providerName = channel === "sms" ? settings?.smsProvider : settings?.whatsappProvider;
      const sender = channel === "sms" ? settings?.smsSender : settings?.whatsappSender;

      if (!settings || !enabled) {
        return permanent(`messaging:${channel}`, `${channel} is switched off for this business.`);
      }
      if (!sender) {
        return permanent(`messaging:${channel}`, `No ${channel} sender is configured for this business.`);
      }

      let provider;
      try {
        provider = messagingProviderFor(channel, providerName);
      } catch (error) {
        // An unknown or production-forbidden provider will not become known
        // by trying again.
        return permanent(
          `messaging:${channel}`,
          error instanceof MessagingProviderError ? error.message : "No usable messaging provider."
        );
      }

      // Consent, re-checked at the moment of sending.
      const permission = await canSendToCustomer({
        businessId,
        channel,
        phone: message.to,
        transactional: true
      });
      if (!permission.allowed) return permanent(provider.name, permission.reason);

      const body = formatForChannel(channel, message.body);

      if (provider.channel === "sms") {
        const result = await provider.sendSms({
          to: message.to,
          from: sender,
          body,
          idempotencyKey: message.idempotencyKey,
          signal: message.signal
        });
        return mapResult(provider.name, result);
      }

      // WhatsApp: free-form only inside a window the customer opened.
      const mode = await outboundModeFor({ businessId, channel, customerRef: message.to });
      if (mode.mode === "session") {
        const result = await provider.sendWhatsAppMessage({
          kind: "session",
          to: message.to,
          from: sender,
          body,
          idempotencyKey: message.idempotencyKey,
          signal: message.signal
        });
        return mapResult(provider.name, result);
      }

      // Outside the window an approved template is the only way through. The
      // subject carries Veyra's template key; without one there is nothing
      // legitimate to send, and saying so beats a provider rejection.
      try {
        const { template, orderedVariables } = await resolveTemplate({
          businessId,
          channel,
          key: message.subject,
          variables: { body }
        });
        const result = await provider.sendWhatsAppMessage({
          kind: "template",
          to: message.to,
          from: sender,
          templateName: template.providerTemplateId,
          templateLanguage: template.language,
          templateVariables: orderedVariables,
          body,
          idempotencyKey: message.idempotencyKey,
          signal: message.signal
        });
        return mapResult(provider.name, result);
      } catch (error) {
        if (error instanceof TemplateUnavailableError) return permanent(provider.name, error.message);
        throw error;
      }
    }
  };
}
