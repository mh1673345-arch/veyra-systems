import { prisma } from "../../db/client.js";
import { messagingWebhookAdapterFor } from "./registry.js";
import { handleDeliveryReceipt, handleInboundMessage } from "./inbound.js";
import { isDeliveryReceipt, type DeliveryReceiptEvent, type InboundMessageEvent } from "./types.js";

/**
 * Messaging webhooks.
 *
 * Same discipline as the billing and voice webhooks:
 *   1. the adapter verifies the signature over the exact bytes received, and
 *      an unverifiable request is refused rather than trusted;
 *   2. the provider's event id is claimed in the database before any work,
 *      so a provider that delivers the same event twice changes nothing the
 *      second time;
 *   3. the claim is released if processing throws, so a genuine retry is
 *      still possible — a crash must not permanently swallow an event.
 */

export class MessagingWebhookVerificationError extends Error {
  constructor(message = "The webhook signature could not be verified.") {
    super(message);
    this.name = "MessagingWebhookVerificationError";
  }
}

export interface WebhookProcessResult {
  outcome: "processed" | "ignored" | "duplicate";
  detail: string;
}

/**
 * Proves a request came from the provider and turns it into Veyra's own
 * events. Throws rather than returning empty on a bad signature, so a caller
 * cannot mistake "forged" for "nothing happened".
 *
 * Separate from processing because a provider should not be kept waiting for
 * an AI turn and a second provider call: Meta retries a webhook it considers
 * slow, and a retry storm is worse than a late reply.
 */
export async function verifyMessagingWebhook(params: {
  provider: string;
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}): Promise<(InboundMessageEvent | DeliveryReceiptEvent)[]> {
  const adapter = messagingWebhookAdapterFor(params.provider);
  if (!adapter) {
    // No verifier means no way to know this is genuine. Refusing is the only
    // safe answer; "accept it in development" would mean the verification
    // path is exercised by nothing.
    throw new MessagingWebhookVerificationError(
      `No verified webhook adapter is configured for "${params.provider}".`
    );
  }

  const events = await adapter.verifyAndParse({
    rawBody: params.rawBody,
    headers: params.headers
  });
  if (events === null) throw new MessagingWebhookVerificationError();
  return events;
}

/** Claims and handles events that have already been proven genuine. */
export async function processVerifiedEvents(
  provider: string,
  events: (InboundMessageEvent | DeliveryReceiptEvent)[]
): Promise<WebhookProcessResult[]> {
  const results: WebhookProcessResult[] = [];
  for (const event of events) results.push(await processOne(provider, event));
  return results;
}

export async function processMessagingWebhook(params: {
  provider: string;
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}): Promise<WebhookProcessResult[]> {
  return processVerifiedEvents(params.provider, await verifyMessagingWebhook(params));
}

async function processOne(
  provider: string,
  event: InboundMessageEvent | DeliveryReceiptEvent
): Promise<WebhookProcessResult> {
  const type = isDeliveryReceipt(event) ? "delivery_receipt" : "inbound_message";
  const eventAt = isDeliveryReceipt(event) ? event.occurredAt : event.receivedAt;

  // Claim first. The unique (provider, externalEventId) index is what makes a
  // redelivery a no-op rather than a second reply to the customer.
  let claimId: string;
  try {
    const claimed = await prisma.messagingWebhookEvent.create({
      data: {
        provider,
        externalEventId: event.externalEventId,
        type,
        outcome: "processed",
        eventAt
      }
    });
    claimId = claimed.id;
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return { outcome: "duplicate", detail: "This event has already been processed." };
    }
    throw error;
  }

  try {
    if (isDeliveryReceipt(event)) {
      const result = await handleDeliveryReceipt(event);
      await prisma.messagingWebhookEvent.update({
        where: { id: claimId },
        data: {
          outcome: result.outcome,
          detail: result.detail,
          notificationId: result.notificationId ?? null
        }
      });
      return { outcome: result.outcome, detail: result.detail };
    }

    const result = await handleInboundMessage(event);
    await prisma.messagingWebhookEvent.update({
      where: { id: claimId },
      data: { outcome: result.outcome, detail: result.detail }
    });
    return { outcome: result.outcome, detail: result.detail };
  } catch (error) {
    // Release the claim so the provider's retry can genuinely retry.
    await prisma.messagingWebhookEvent.delete({ where: { id: claimId } }).catch(() => undefined);
    throw error;
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "P2002"
  );
}
