import type {
  ChannelHealth,
  MessagingChannel,
  MessagingChannelStatus,
  MessagingOverview
} from "@veyra/shared";
import { prisma } from "../../db/client.js";
import { accessFor } from "../access/accessService.js";
import { maskPhone } from "./phone.js";
import {
  messagingProviderFor,
  messagingWebhookAdapterFor,
  MessagingProviderError
} from "./registry.js";

/**
 * What the Console shows about messaging.
 *
 * The rule that shapes this file: nothing may read as live that has not been
 * proven live. A configured channel with a development adapter behind it is
 * "configured", never "healthy", and the simulated flag travels with it so
 * the UI can say so in words rather than leaving an operator to assume.
 */

async function channelStatus(
  businessId: string,
  channel: MessagingChannel,
  settings: {
    smsEnabled: boolean;
    whatsappEnabled: boolean;
    smsProvider: string | null;
    whatsappProvider: string | null;
    smsSender: string | null;
    whatsappSender: string | null;
  } | null,
  entitled: boolean
): Promise<MessagingChannelStatus> {
  const enabled = channel === "sms" ? (settings?.smsEnabled ?? false) : (settings?.whatsappEnabled ?? false);
  const providerName = channel === "sms" ? (settings?.smsProvider ?? null) : (settings?.whatsappProvider ?? null);
  const sender = channel === "sms" ? (settings?.smsSender ?? null) : (settings?.whatsappSender ?? null);

  // Can this server even receive a message on this channel? Outbound working
  // says nothing about inbound, and the two fail independently.
  const webhookConfigured = providerName ? messagingWebhookAdapterFor(providerName) !== null : false;
  const routed =
    providerName !== null &&
    (await prisma.messagingNumber.count({ where: { businessId, channel, provider: providerName } })) > 0;
  const inbound = {
    configured: webhookConfigured,
    routed,
    detail: !providerName
      ? "No provider is configured."
      : !webhookConfigured
        ? `This server cannot verify ${providerName} webhooks, so inbound messages are refused.`
        : routed
          ? "Inbound is configured. Whether the provider can reach this server is not something Veyra can see from here."
          : `No ${label(channel)} number is mapped to this business, so an inbound message has nowhere to land.`
  };

  const warnings: string[] = [];
  // A Meta dashboard token lasts 24 hours. Saying so is the difference
  // between an operator expecting a failure and being surprised by one.
  if (providerName === "meta" && process.env.META_WHATSAPP_TOKEN_IS_TEMPORARY !== "false") {
    warnings.push(
      "The Meta access token in use is temporary and expires roughly 24 hours after it was issued. " +
        "Outbound messages and automatic replies will start failing when it does. This is not a production setup."
    );
  }

  const base = {
    channel,
    enabled,
    entitled,
    provider: providerName,
    sender: maskPhone(sender),
    simulated: false,
    inbound,
    warnings
  };

  if (!entitled) {
    return { ...base, health: "not_configured", detail: `${label(channel)} is not included in this plan.` };
  }
  if (!providerName) {
    return { ...base, health: "not_configured", detail: `No ${label(channel)} provider is configured.` };
  }
  if (!sender) {
    return { ...base, health: "not_configured", detail: `No ${label(channel)} sender number is configured.` };
  }

  let provider;
  try {
    provider = messagingProviderFor(channel, providerName);
  } catch (error) {
    return {
      ...base,
      health: "unavailable",
      detail:
        error instanceof MessagingProviderError
          ? error.message
          : `The ${label(channel)} provider could not be loaded.`
    };
  }

  const health = await provider.health().catch(() => ({ ok: false, detail: "The provider could not be reached." }));

  // A development stand-in is never reported as healthy, however cheerfully
  // it answers: "healthy" would tell an operator messages are going out.
  const state: ChannelHealth = provider.simulated
    ? "configured"
    : health.ok
      ? enabled
        ? "healthy"
        : "configured"
      : "unavailable";

  return {
    ...base,
    simulated: provider.simulated,
    health: state,
    detail: provider.simulated
      ? `${health.detail} Nothing is delivered to a real handset.`
      : health.detail
  };
}

export async function messagingOverview(businessId: string, canManage: boolean): Promise<MessagingOverview> {
  const [settings, access] = await Promise.all([
    prisma.messagingSettings.findUnique({ where: { businessId } }),
    accessFor(businessId)
  ]);

  const [sms, whatsapp, smsCount, whatsappCount] = await Promise.all([
    channelStatus(businessId, "sms", settings, access.entitlements.has("sms")),
    channelStatus(businessId, "whatsapp", settings, access.entitlements.has("whatsapp")),
    prisma.notification.count({ where: { businessId, channel: "sms" } }),
    prisma.notification.count({ where: { businessId, channel: "whatsapp" } })
  ]);

  return {
    businessId,
    sms,
    whatsapp,
    customerMessagingEnabled: settings?.customerMessagingEnabled ?? false,
    operatorMessagingEnabled: settings?.operatorMessagingEnabled ?? false,
    defaultCountry: settings?.defaultCountry ?? null,
    // Counted from real rows. Zero messages reads as "nothing yet", not as a
    // measured zero, so the Console can say "Not available".
    usage: {
      smsMessages: smsCount === 0 ? null : smsCount,
      whatsappMessages: whatsappCount === 0 ? null : whatsappCount
    },
    canManage
  };
}

function label(channel: MessagingChannel): string {
  return channel === "sms" ? "SMS" : "WhatsApp";
}
