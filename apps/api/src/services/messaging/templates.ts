import { prisma } from "../../db/client.js";
import type { MessagingChannel } from "@veyra/shared";

/**
 * WhatsApp's conversation rules, expressed once.
 *
 * Meta allows free-form text only inside a window opened by the customer
 * messaging first. Outside it, a business-initiated message must use a
 * template the platform has approved. Veyra models that distinction rather
 * than discovering it from a rejected API call, because the failure mode
 * otherwise is a confirmation that silently never arrives.
 *
 * Nothing Meta-specific lives in the domain: callers ask "may I send
 * free-form, or do I need a template?" and get an answer in Veyra's terms.
 */

/** Meta's customer service window. Conservative by an hour. */
export const WHATSAPP_SESSION_WINDOW_MS = 23 * 60 * 60 * 1000;

export type OutboundPermission =
  | { mode: "session"; reason: string }
  | { mode: "template"; reason: string }
  | { mode: "blocked"; reason: string };

/**
 * SMS has no session concept — a carrier will carry any message — so it is
 * always "session" in Veyra's vocabulary, meaning free-form is fine.
 */
export async function outboundModeFor(params: {
  businessId: string;
  channel: MessagingChannel;
  customerRef: string;
  now?: Date;
}): Promise<OutboundPermission> {
  if (params.channel === "sms") {
    return { mode: "session", reason: "SMS has no session window." };
  }

  const now = params.now ?? new Date();
  const lastInbound = await prisma.message.findFirst({
    where: {
      sender: "caller",
      conversation: {
        businessId: params.businessId,
        channel: "whatsapp",
        customerRef: params.customerRef
      }
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true }
  });

  if (!lastInbound) {
    return {
      mode: "template",
      reason: "This customer has never messaged on WhatsApp, so only an approved template may open the conversation."
    };
  }

  const age = now.getTime() - lastInbound.createdAt.getTime();
  return age <= WHATSAPP_SESSION_WINDOW_MS
    ? { mode: "session", reason: "The customer messaged recently, so free-form text is allowed." }
    : {
        mode: "template",
        reason: "The customer service window has closed, so only an approved template may be sent."
      };
}

export interface ResolvedTemplate {
  key: string;
  providerTemplateId: string;
  language: string;
  variables: string[];
}

export class TemplateUnavailableError extends Error {
  constructor(
    message: string,
    readonly code: "missing" | "not_approved" | "variable_mismatch"
  ) {
    super(message);
    this.name = "TemplateUnavailableError";
  }
}

/**
 * Finds an approved template and checks the caller supplied exactly the
 * variables it declares. A mismatch is refused here rather than sent: the
 * provider would reject it anyway, and a rejected template send is a
 * permanent failure that would otherwise consume the whole retry schedule.
 */
export async function resolveTemplate(params: {
  businessId: string;
  channel: MessagingChannel;
  key: string;
  language?: string;
  variables: Record<string, string>;
}): Promise<{ template: ResolvedTemplate; orderedVariables: string[] }> {
  // Language is a property of the registered template, not something the
  // send path knows: a provider's code may be "en_US" where Veyra's key is
  // language-agnostic. Defaulting to "en" meant an approved en_US template
  // was never found, and the send failed permanently with "no template
  // registered" while the template sat there approved — so an unspecified
  // language now means "whichever approved one exists" rather than a guess.
  const scope = { businessId: params.businessId, channel: params.channel, key: params.key };
  const row = params.language
    ? await prisma.messageTemplate.findUnique({
        where: { businessId_channel_key_language: { ...scope, language: params.language } }
      })
    : ((await prisma.messageTemplate.findFirst({ where: { ...scope, status: "approved" } })) ??
      // Fall back to any row so the error can say *why* it is unusable
      // rather than claiming none exists.
      (await prisma.messageTemplate.findFirst({ where: scope })));

  if (!row) {
    throw new TemplateUnavailableError(
      `No "${params.key}" template is registered for ${params.channel}${
        params.language ? ` in ${params.language}` : ""
      }.`,
      "missing"
    );
  }
  if (row.status !== "approved" || !row.providerTemplateId) {
    throw new TemplateUnavailableError(
      `The "${params.key}" template is ${row.status} and cannot be sent until the provider approves it.`,
      "not_approved"
    );
  }

  const declared = JSON.parse(row.variables) as string[];
  const missing = declared.filter((name) => params.variables[name] === undefined);
  if (missing.length > 0) {
    throw new TemplateUnavailableError(
      `The "${params.key}" template needs ${missing.join(", ")}.`,
      "variable_mismatch"
    );
  }

  return {
    template: {
      key: row.key,
      providerTemplateId: row.providerTemplateId,
      language: row.language,
      variables: declared
    },
    // Positional, in the order the approved template declares them.
    orderedVariables: declared.map((name) => params.variables[name])
  };
}
