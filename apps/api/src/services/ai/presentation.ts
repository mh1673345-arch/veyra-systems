import type { AssistantIntent, ClosingStyle, ReceptionTone } from "@veyra/shared";

/**
 * Reception presentation, from structured settings only.
 *
 * A business chooses a tone, an assistant name and a closing style; it never
 * writes instructions for the model. These fixed phrasings are what the
 * deterministic responder uses, and the tone's fixed description is what the
 * AI prompt is given — so nothing a customer types becomes a system prompt.
 */

export const TONE_GUIDANCE: Record<ReceptionTone, string> = {
  professional: "clear, courteous and to the point",
  warm: "friendly and reassuring, without being over-familiar",
  concise: "as brief as possible while staying polite",
  premium: "polished, attentive and unhurried"
};

export function greetingFor(params: {
  businessName: string;
  assistantName?: string | null;
  tone?: ReceptionTone;
}): string {
  const { businessName, assistantName } = params;
  switch (params.tone ?? "professional") {
    case "warm":
      return `Hi there! Thanks for reaching out to ${businessName}${assistantName ? ` — I'm ${assistantName}` : ""}. What can I do for you today?`;
    case "concise":
      return `${businessName}${assistantName ? `, ${assistantName} speaking` : ""}. How can I help?`;
    case "premium":
      return `Good day, and thank you for contacting ${businessName}.${assistantName ? ` My name is ${assistantName}.` : ""} How may I assist you?`;
    default:
      return `Hi! You've reached ${businessName}${assistantName ? ` — this is ${assistantName}` : ""}. How can I help you today?`;
  }
}

/** Intents that answer a question, where a closing line reads naturally. */
const CLOSABLE: AssistantIntent[] = ["business_information", "service", "service_list", "pricing", "faq"];

export function withClosing(
  message: string,
  intent: AssistantIntent,
  closingStyle: ClosingStyle | undefined,
  businessName: string
): string {
  if (!closingStyle || closingStyle === "none" || !CLOSABLE.includes(intent)) return message;
  const closing =
    closingStyle === "offer_help"
      ? "Is there anything else I can help with?"
      : `Thanks for getting in touch with ${businessName}.`;
  return message.includes(closing) ? message : `${message} ${closing}`;
}

/**
 * What a caller hears while Reception is paused or still being set up: the
 * business's own fallback message if it wrote one, otherwise a plain pointer
 * to the real contact details. No automation runs.
 */
export function unavailableMessage(business: {
  name: string;
  escalationFallbackMessage: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  escalationPhone: string | null;
  escalationEmail: string | null;
}): string {
  if (business.escalationFallbackMessage) return business.escalationFallbackMessage;
  const phone = business.escalationPhone ?? business.contactPhone;
  const email = business.escalationEmail ?? business.contactEmail;
  const reach = [phone ? `by phone at ${phone}` : null, email ? `by email at ${email}` : null].filter(Boolean);
  return (
    `${business.name} isn't taking messages here right now.` +
    (reach.length > 0 ? ` Please contact them directly ${reach.join(" or ")}.` : " Please contact them directly.")
  );
}
