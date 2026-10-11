import type {
  AiResponder,
  AssistantResult,
  BusinessContext,
  BusinessFaqContext,
  BusinessServiceContext,
  RespondParams
} from "./types.js";
import { greetingFor } from "./presentation.js";

/**
 * Deterministic offline responder, and the safety net behind the Anthropic one.
 *
 * Every message is classified independently against the caller's current text
 * plus the business context. There is deliberately no carried-over "active
 * intent" or workflow state: a previous booking turn must never stop the next
 * message from being understood as a pricing or service question.
 *
 * Matching is intentionally fuzzy (word/substring overlap, not just exact
 * phrase containment) so realistic phrasing — "how much do u guys charge for
 * whitening" — still resolves against a service named "Teeth whitening".
 */

export type Topic =
  | { kind: "escalation" }
  | { kind: "booking" }
  | { kind: "greeting" }
  | { kind: "acknowledgement" }
  | { kind: "hours" }
  | { kind: "location" }
  | { kind: "contact" }
  | { kind: "service"; service: BusinessServiceContext; pricing: boolean }
  | { kind: "service_list" }
  | { kind: "pricing_unspecified" }
  | { kind: "faq"; faq: BusinessFaqContext }
  | { kind: "channel"; channel: "whatsapp" | "sms" | "email_notifications" }
  | { kind: "out_of_scope" };

const ESCALATION_KEYWORDS = [
  "real person",
  "to a person",
  "with a person",
  "talk to someone",
  "speak to someone",
  "speak to a",
  "speak with",
  "talk to a",
  "human",
  "staff member",
  "call me back",
  "somebody call",
  "someone call",
  "representative",
  "manager"
];

/** Verbs that actively ask to be booked in. */
const BOOKING_ACTION_KEYWORDS = [
  "book",
  "booking",
  "schedule",
  "reservation",
  "come in",
  "come by",
  "see someone",
  "get my teeth cleaned",
  "get a cleaning"
];

/**
 * The bare noun is a weaker signal — "what should I bring to my first
 * appointment" mentions one without asking to make one.
 */
const APPOINTMENT_NOUN_KEYWORDS = ["appointment"];

/**
 * Temporal hints only imply booking alongside something else — on their own
 * "what times are you open tomorrow" is an hours question, not a booking.
 */
const WEAK_BOOKING_KEYWORDS = ["next week", "tomorrow", "this week", "today"];

/**
 * Cues that the caller is dropping a booking they mentioned in the same breath
 * ("actually forget booking, how much are implants") — the booking word is
 * present but must not steer the answer.
 */
const ABANDON_CUES = ["forget", "never mind", "nevermind", "instead", "not interested", "skip"];

const HOURS_KEYWORDS = ["hours", "open", "close", "closing", "what time"];
const CHANNEL_KEYWORDS: { channel: "whatsapp" | "sms" | "email_notifications"; words: string[] }[] = [
  { channel: "whatsapp", words: ["whatsapp", "whats app"] },
  { channel: "sms", words: ["sms", "text me", "text message", "by text"] },
  { channel: "email_notifications", words: ["email me", "by email", "email confirmation"] }
];
const LOCATION_KEYWORDS = [
  "located",
  "location",
  "address",
  "where are you",
  "wheres your",
  "where is your",
  "your office",
  "directions"
];
const CONTACT_KEYWORDS = ["phone", "email", "contact", "call you", "number"];
const PRICING_KEYWORDS = [
  "price",
  "prices",
  "pricing",
  "cost",
  "how much",
  "fee",
  "charge",
  "rates",
  "expensive"
];
const SERVICE_LIST_KEYWORDS = [
  "what services",
  "which services",
  "services do you",
  "what do you offer",
  "what do you do",
  "treatments"
];
const GREETING_PHRASES = ["hi", "hello", "hey", "good morning", "good afternoon", "good evening"];
const ACKNOWLEDGEMENT_PHRASES = [
  "ok",
  "okay",
  "thanks",
  "thank you",
  "great",
  "cool",
  "sounds good",
  "perfect",
  "got it",
  "alright",
  "no thanks",
  "that's all",
  "thats all",
  "bye",
  "goodbye"
];

/**
 * Cross-vocabulary hints: if the caller's text contains the key, treat it as
 * if the value word were also present, before doing word-overlap matching.
 * Kept small and conservative — this is phrasing help, not medical judgment.
 * Also carries common informal spellings so chat-style input still lands.
 */
const SYNONYM_HINTS: Record<string, string> = {
  aligners: "invisalign",
  urgent: "emergency",
  hurts: "emergency",
  hurt: "emergency",
  pain: "emergency",
  checkup: "cleaning",
  "check-up": "cleaning",
  "check up": "cleaning",
  clean: "cleaning",
  cleaned: "cleaning",
  teeth: "teeth",
  whiten: "whitening",
  whitning: "whitening",
  wightening: "whitening",
  implant: "implants",
  inplants: "implants"
};

/**
 * Filtered out before word-overlap matching: without this, a question like
 * "What is the population of Mars?" matches the FAQ "What should I bring to
 * my first appointment?" purely on the word "what".
 */
const STOP_WORDS = new Set([
  "what",
  "when",
  "where",
  "which",
  "does",
  "your",
  "yours",
  "have",
  "with",
  "this",
  "that",
  "they",
  "them",
  "there",
  "here",
  "from",
  "would",
  "could",
  "should",
  "will",
  "can",
  "are",
  "the",
  "and",
  "for",
  "any",
  "some",
  "please",
  "tell",
  "need",
  "want",
  "know",
  "much",
  "many",
  "into",
  "than",
  "then",
  "also",
  "just",
  "like",
  "very",
  "more",
  "most",
  "been",
  "being",
  "over",
  "only",
  "other",
  "about",
  "guys",
  "yall",
  "still",
  "sometime",
  "actually",
  "forget",
  "pls"
]);

function matchesAny(lower: string, keywords: string[]): boolean {
  return keywords.some((kw) => lower.includes(kw));
}

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Words meaningful enough to match on: long enough, and not a generic filler word. */
function contentWords(text: string): string[] {
  return normalizeWords(text).filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
}

function expandWithSynonyms(lower: string, words: string[]): string[] {
  const extra = Object.entries(SYNONYM_HINTS)
    .filter(([key]) => lower.includes(key))
    .map(([, value]) => value);
  return [...words, ...extra];
}

/** True if two normalized words are a meaningful match: equal, or one contains the other. */
function wordsOverlap(a: string, b: string, minLen: number): boolean {
  if (a.length < minLen || b.length < minLen) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function countOverlap(wordsA: string[], wordsB: string[], minLen: number): number {
  let count = 0;
  for (const a of wordsA) {
    if (wordsB.some((b) => wordsOverlap(a, b, minLen))) {
      count += 1;
    }
  }
  return count;
}

function findServiceMatches(
  lower: string,
  callerWords: string[],
  context: BusinessContext
): BusinessServiceContext[] {
  const exact = context.services.filter((s) => lower.includes(s.name.toLowerCase()));
  if (exact.length > 0) return exact;

  const scored: { service: BusinessServiceContext; score: number }[] = [];
  for (const service of context.services) {
    const nameWords = contentWords(service.name);
    const score = countOverlap(callerWords, nameWords, 4);
    if (score > 0) scored.push({ service, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.service);
}

function scoreFaqMatch(
  callerWords: string[],
  context: BusinessContext
): { faq: BusinessFaqContext; score: number } | null {
  let best: { faq: BusinessFaqContext; score: number } | null = null;
  for (const faq of context.faqs) {
    const questionWords = contentWords(faq.question);
    const score = countOverlap(callerWords, questionWords, 4);
    if (score > 0 && (!best || score > best.score)) {
      best = { faq, score };
    }
  }
  return best;
}

/** Short standalone pleasantries only — "hi there" counts, "hi, how much is whitening" does not. */
function isShortPhraseMatch(lower: string, phrases: string[]): boolean {
  const stripped = lower.replace(/[^a-z0-9\s]/g, "").trim();
  const words = stripped.split(/\s+/).filter(Boolean);
  if (words.length > 4) return false;
  return phrases.some((phrase) => stripped === phrase || stripped.startsWith(`${phrase} `));
}

/**
 * Returns every topic the message plausibly raises, most dominant first, so a
 * multi-intent message ("how much is cleaning and do you accept insurance")
 * can be answered without silently dropping half the question.
 */
export function classifyMessage(callerText: string, context: BusinessContext): Topic[] {
  const lower = callerText.toLowerCase();
  const callerWords = expandWithSynonyms(lower, contentWords(lower));
  const faqMatch = scoreFaqMatch(callerWords, context);
  const wantsPricing = matchesAny(lower, PRICING_KEYWORDS);
  const topics: Topic[] = [];

  // Escalation always dominates: a caller asking for a person gets a person.
  if (matchesAny(lower, ESCALATION_KEYWORDS)) return [{ kind: "escalation" }];

  // Channel requests are answered strictly from configured capabilities.
  const channelMatch = CHANNEL_KEYWORDS.find((c) => matchesAny(lower, c.words));
  if (channelMatch) return [{ kind: "channel", channel: channelMatch.channel }];

  // A strong FAQ hit outranks a bare keyword: "What should I bring to my first
  // appointment?" is an FAQ question, not a request to book something.
  const strongFaq = faqMatch && faqMatch.score >= 2 ? faqMatch.faq : null;
  const services = findServiceMatches(lower, callerWords, context);
  // "How much is cleaning and do you accept insurance" leads with the price;
  // "What should I bring to my first appointment" leads with the FAQ.
  const pricedServiceLeads = wantsPricing && services.length > 0;

  if (strongFaq && !pricedServiceLeads) topics.push({ kind: "faq", faq: strongFaq });

  // Booking outranks a service named inside the same sentence: "book a cleaning"
  // is a booking request that happens to mention a service, not a service query.
  // A bare "appointment" doesn't count when an FAQ already answers the question.
  const abandonsBooking = matchesAny(lower, ABANDON_CUES);
  const wantsBooking =
    matchesAny(lower, BOOKING_ACTION_KEYWORDS) ||
    (matchesAny(lower, APPOINTMENT_NOUN_KEYWORDS) && !strongFaq);
  if (wantsBooking && !abandonsBooking) topics.push({ kind: "booking" });

  for (const service of services.slice(0, 2)) {
    topics.push({ kind: "service", service, pricing: wantsPricing });
  }

  if (strongFaq && pricedServiceLeads) topics.push({ kind: "faq", faq: strongFaq });

  if (matchesAny(lower, HOURS_KEYWORDS)) topics.push({ kind: "hours" });
  if (matchesAny(lower, LOCATION_KEYWORDS) && context.location) topics.push({ kind: "location" });
  if (matchesAny(lower, SERVICE_LIST_KEYWORDS) && context.services.length > 0) {
    topics.push({ kind: "service_list" });
  }

  // Pricing words with no service named: ask which treatment rather than
  // guessing a price or pretending to have recorded something.
  if (wantsPricing && services.length === 0) topics.push({ kind: "pricing_unspecified" });

  if (matchesAny(lower, CONTACT_KEYWORDS) && (context.contactPhone || context.contactEmail)) {
    topics.push({ kind: "contact" });
  }

  // A one-word FAQ overlap is too weak to tack onto an answer that already
  // stands on its own — only use it when nothing else matched.
  if (topics.length === 0 && faqMatch) topics.push({ kind: "faq", faq: faqMatch.faq });

  if (topics.length === 0) {
    // A bare "...tomorrow?" with nothing else to go on reads as a booking attempt.
    if (matchesAny(lower, WEAK_BOOKING_KEYWORDS)) return [{ kind: "booking" }];
    if (isShortPhraseMatch(lower, GREETING_PHRASES)) return [{ kind: "greeting" }];
    if (isShortPhraseMatch(lower, ACKNOWLEDGEMENT_PHRASES)) return [{ kind: "acknowledgement" }];
    return [{ kind: "out_of_scope" }];
  }

  return topics;
}

const CHANNEL_LABELS: Record<"whatsapp" | "sms" | "email_notifications", string> = {
  whatsapp: "WhatsApp",
  sms: "text message",
  email_notifications: "email"
};

/** The team's direct line, when the business configured one for handoffs. */
function escalationContactSentence(context: BusinessContext): string {
  const contact = context.escalationContact;
  if (!contact) return "";
  const parts = [
    contact.phone ? `by phone at ${contact.phone}` : null,
    contact.email ? `by email at ${contact.email}` : null
  ].filter(Boolean);
  return parts.length > 0 ? ` If it's urgent, you can also reach the team ${parts.join(" or ")}.` : "";
}

/** Offers the real contact details, when there are any, rather than a dead end. */
function contactSentence(context: BusinessContext): string {
  const parts = [
    context.contactPhone ? `by phone at ${context.contactPhone}` : null,
    context.contactEmail ? `by email at ${context.contactEmail}` : null
  ].filter(Boolean);
  if (parts.length === 0) return "";
  return ` You can reach ${context.name} directly ${parts.join(" or ")}.`;
}

function describeService(service: BusinessServiceContext, pricing: boolean): string {
  if (pricing) {
    const price = service.priceLabel
      ? `${service.name} is ${service.priceLabel}.`
      : `I don't have a price on file for ${service.name}.`;
    const description = service.description ? ` ${service.description}` : "";
    return `${price}${description}`.trim();
  }
  const price = service.priceLabel ? ` It's ${service.priceLabel}.` : "";
  const description = service.description ? ` ${service.description}` : "";
  return `Yes, we offer ${service.name}.${price}${description}`.trim();
}

interface TopicAnswer {
  intent: AssistantResult["intent"];
  message: string;
  confidence: number;
  action: AssistantResult["action"];
  requiresClarification: boolean;
}

function answerTopic(topic: Topic, context: BusinessContext): TopicAnswer {
  switch (topic.kind) {
    case "escalation": {
      if (!context.capabilities.human_escalation) {
        const reach = contactSentence(context);
        return {
          intent: "escalation",
          // The business's own fallback wording, when it wrote one.
          message: context.fallbackMessage ?? `I'm not able to put you through to someone from here.${reach}`,
          confidence: 0.8,
          action: "none",
          requiresClarification: false
        };
      }
      return {
        intent: "escalation",
        message:
          `Of course — I'll pass this to someone from ${context.name} to follow up with you.` +
          escalationContactSentence(context),
        confidence: 0.9,
        action: "escalate_to_human",
        requiresClarification: false
      };
    }

    case "booking": {
      if (!context.capabilities.booking_requests) {
        const reach = contactSentence(context);
        return {
          intent: "booking",
          message: `I'm not able to take appointment requests here.${reach}`,
          confidence: 0.8,
          action: "none",
          requiresClarification: false
        };
      }
      // Without a live calendar we can collect a request but never confirm a slot.
      const message = context.capabilities.calendar_booking
        ? "I'd be happy to help with that. Please use the booking request below with your preferred day and time."
        : "I can submit an appointment request for the team to review, but I can't confirm live " +
          "availability yet. Please use the booking request below with your preferred day and time.";
      return {
        intent: "booking",
        message,
        confidence: 0.85,
        action: "show_booking_form",
        requiresClarification: false
      };
    }

    case "channel": {
      const enabled = context.capabilities[topic.channel];
      const label = CHANNEL_LABELS[topic.channel];
      if (enabled) {
        return {
          intent: "business_information",
          message: `Yes — we can follow up by ${label}.`,
          confidence: 0.8,
          action: "none",
          requiresClarification: false
        };
      }
      const reach = contactSentence(context);
      return {
        intent: "business_information",
        message: `We don't offer ${label} follow-up at the moment.${reach}`,
        confidence: 0.8,
        action: "none",
        requiresClarification: false
      };
    }

    case "hours":
      return {
        intent: "business_information",
        message: `We're open ${context.hours}.`,
        confidence: 0.85,
        action: "none",
        requiresClarification: false
      };

    case "location":
      return {
        intent: "business_information",
        message: `We're located at ${context.location}.`,
        confidence: 0.85,
        action: "none",
        requiresClarification: false
      };

    case "contact": {
      const parts = [
        context.contactPhone ? `by phone at ${context.contactPhone}` : null,
        context.contactEmail ? `by email at ${context.contactEmail}` : null
      ].filter(Boolean);
      return {
        intent: "business_information",
        message: `You can reach ${context.name} ${parts.join(" or ")}.`,
        confidence: 0.85,
        action: "none",
        requiresClarification: false
      };
    }

    case "service_list": {
      const names = context.services.map((s) => s.name).join(", ");
      return {
        intent: "service_list",
        message: `We offer ${names}. Which one would you like to know more about?`,
        confidence: 0.8,
        action: "none",
        requiresClarification: false
      };
    }

    case "service":
      return {
        intent: topic.pricing ? "pricing" : "service",
        message: describeService(topic.service, topic.pricing),
        confidence: 0.8,
        action: "none",
        requiresClarification: false
      };

    case "pricing_unspecified": {
      const names = context.services.map((s) => s.name).join(", ");
      const options = names ? ` We offer ${names}.` : "";
      return {
        intent: "pricing",
        message: `Sure — which treatment would you like pricing for?${options}`,
        confidence: 0.6,
        action: "none",
        requiresClarification: true
      };
    }

    case "faq":
      return {
        intent: "faq",
        message: topic.faq.answer,
        confidence: 0.75,
        action: "none",
        requiresClarification: false
      };

    case "greeting":
      return {
        intent: "greeting",
        message: greetingFor({
          businessName: context.name,
          assistantName: context.assistantName,
          tone: context.tone
        }),
        confidence: 0.9,
        action: "none",
        requiresClarification: false
      };

    case "acknowledgement":
      return {
        intent: "acknowledgement",
        message: "You're welcome! Is there anything else I can help you with?",
        confidence: 0.8,
        action: "none",
        requiresClarification: false
      };

    case "out_of_scope":
    default:
      return {
        intent: "out_of_scope",
        message:
          `I don't have that information on file. I can have someone from ${context.name} ` +
          "follow up with the details — would that help?",
        confidence: 0.5,
        action: "none",
        requiresClarification: false
      };
  }
}

/** Answers at most two topics so a compound question isn't half-ignored. */
const MAX_TOPICS_ANSWERED = 2;

export class RuleBasedResponder implements AiResponder {
  readonly name = "rule-based" as const;

  async respond({ callerText, context }: RespondParams): Promise<AssistantResult> {
    const topics = classifyMessage(callerText, context);
    const answers = topics.slice(0, MAX_TOPICS_ANSWERED).map((t) => answerTopic(t, context));
    const [primary, ...rest] = answers;

    const message = [primary.message, ...rest.map((a) => a.message)].join(" ");

    return {
      intent: primary.intent,
      message,
      // Two topics answered from one message is inherently a bit less certain.
      confidence: rest.length > 0 ? Math.min(primary.confidence, 0.7) : primary.confidence,
      action: answers.find((a) => a.action !== "none")?.action ?? "none",
      requiresClarification: answers.some((a) => a.requiresClarification)
    };
  }
}
