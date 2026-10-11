import type { KnowledgeGapKind, KnowledgeGapRow, PilotRange } from "@veyra/shared";
import { KNOWLEDGE_GAP_LABELS } from "@veyra/shared";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/client.js";
import type { BusinessContext } from "../ai/types.js";
import { rangeWindow } from "./range.js";

/**
 * What callers asked that the business has never told Veyra.
 *
 * Detection is deterministic and conservative. A signal is only recorded when
 * BOTH of these hold:
 *
 *   1. Veyra actually failed to answer from the business's information — the
 *      reply's intent was `out_of_scope`, or a price/hours/location/contact
 *      answer had nothing on file; and
 *   2. the caller's words match a fixed topic vocabulary, or the missing thing
 *      is named by the business's own record (e.g. a service with no price).
 *
 * The model is never asked to classify anything here, and free text is never
 * stored as a topic: an unmatched question becomes the topic "other". That
 * keeps the dashboard honest — it can say "parking was asked 8 times" because
 * "parking" is a word we looked for, not a label something inferred.
 */

interface TopicDefinition {
  topic: string;
  label: string;
  kind: KnowledgeGapKind;
  keywords: string[];
  suggestion: string;
}

/**
 * The vocabulary. Small on purpose: every entry is a question businesses
 * genuinely get, and each maps to something the business can actually add.
 */
const TOPIC_VOCABULARY: TopicDefinition[] = [
  { topic: "parking", label: "Parking", kind: "missing_faq", keywords: ["parking", "park my car", "car park", "where do i park"], suggestion: "Add an FAQ describing parking options." },
  { topic: "insurance", label: "Insurance", kind: "missing_faq", keywords: ["insurance", "insurer", "covered by", "coverage", "nhs", "medicare", "medicaid"], suggestion: "Add an FAQ explaining which insurers you accept." },
  { topic: "payment_methods", label: "Payment methods", kind: "missing_faq", keywords: ["payment plan", "pay by card", "credit card", "cash only", "do you take card", "financing", "installments", "instalments", "afterpay", "klarna"], suggestion: "Add an FAQ covering accepted payment methods." },
  { topic: "cancellation_policy", label: "Cancellation policy", kind: "missing_policy", keywords: ["cancellation policy", "cancellation fee", "late fee", "no show", "no-show", "reschedule policy", "refund"], suggestion: "Add your cancellation and refund policy as an FAQ." },
  { topic: "accessibility", label: "Accessibility", kind: "missing_faq", keywords: ["wheelchair", "accessible", "step free", "step-free", "disabled access", "lift", "elevator"], suggestion: "Add an FAQ about accessibility at your location." },
  { topic: "weekend_hours", label: "Weekend and holiday hours", kind: "missing_hours", keywords: ["weekend", "saturday", "sunday", "bank holiday", "public holiday", "open late", "after hours", "out of hours"], suggestion: "Add weekend and holiday opening hours to your working hours." },
  { topic: "children", label: "Children and families", kind: "missing_faq", keywords: ["children", "kids", "child", "paediatric", "pediatric", "family appointment"], suggestion: "Add an FAQ about whether you see children." },
  { topic: "pets", label: "Pets and assistance animals", kind: "missing_faq", keywords: ["dog", "pet", "assistance animal", "guide dog"], suggestion: "Add an FAQ about pets and assistance animals." },
  { topic: "languages", label: "Languages spoken", kind: "missing_faq", keywords: ["speak spanish", "speak french", "translator", "interpreter", "another language", "habla"], suggestion: "Add an FAQ listing the languages your team speaks." },
  { topic: "emergency", label: "Urgent and emergency care", kind: "missing_faq", keywords: ["emergency", "urgent", "same day", "right now", "asap"], suggestion: "Add an FAQ explaining how urgent cases are handled." },
  { topic: "waiting_time", label: "Waiting times", kind: "missing_faq", keywords: ["how long is the wait", "waiting list", "waiting time", "how long will it take", "next available"], suggestion: "Add an FAQ about typical waiting times." },
  { topic: "location_directions", label: "Directions and transport", kind: "missing_location", keywords: ["directions", "how do i get there", "nearest station", "bus", "subway", "tube"], suggestion: "Add your address and directions to the business profile." }
];

export interface GapDetectionInput {
  businessId: string;
  conversationId: string;
  messageId: string;
  callerText: string;
  /** The intent of the reply Veyra actually gave. */
  intent: string | null;
  context: Pick<BusinessContext, "hours" | "location" | "contactPhone" | "contactEmail" | "services" | "faqs">;
}

export interface DetectedGap {
  kind: KnowledgeGapKind;
  topic: string;
  detail: string | null;
}

/** Pure detection, so it can be unit-tested without a database. */
export function detectGap(input: GapDetectionInput): DetectedGap | null {
  const text = input.callerText.toLowerCase();

  // A price question about a service the business listed without a price:
  // named by the business's own record, so no guessing at all.
  if (input.intent === "pricing") {
    const unpriced = input.context.services.find(
      (service) => !service.priceLabel.trim() && text.includes(service.name.toLowerCase())
    );
    if (unpriced) return { kind: "missing_price", topic: "service_price", detail: unpriced.name };
  }

  // Everything below only counts when Veyra actually failed to answer.
  if (input.intent !== "out_of_scope") return null;

  const match = TOPIC_VOCABULARY.find((definition) => definition.keywords.some((keyword) => text.includes(keyword)));
  if (match) {
    // Only a real gap: if the business has hours on file, a weekend question
    // is an FAQ gap rather than missing hours.
    if (match.kind === "missing_hours" && !input.context.hours.trim()) {
      return { kind: "missing_hours", topic: match.topic, detail: null };
    }
    if (match.kind === "missing_location" && !input.context.location.trim()) {
      return { kind: "missing_location", topic: match.topic, detail: null };
    }
    return { kind: match.kind === "missing_hours" || match.kind === "missing_location" ? "missing_faq" : match.kind, topic: match.topic, detail: null };
  }

  // Unanswerable and outside the vocabulary: recorded as an unknown topic so
  // the count is honest, without pretending to know what was asked.
  if (input.context.services.length === 0) {
    return { kind: "missing_service", topic: "other", detail: null };
  }
  return { kind: "unknown_topic", topic: "other", detail: null };
}

/**
 * Records a gap if there is one. Never throws into the caller's path: a
 * failure to log analytics must not break someone's phone call.
 */
export async function recordKnowledgeGap(input: GapDetectionInput): Promise<DetectedGap | null> {
  const gap = detectGap(input);
  if (!gap) return null;
  try {
    await prisma.knowledgeGapSignal.create({
      data: {
        businessId: input.businessId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        kind: gap.kind,
        topic: gap.topic,
        detail: gap.detail
      }
    });
  } catch (err) {
    // The unique index means the same caller asking twice in one conversation
    // is one gap, not two. Anything else is logged and swallowed.
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) {
      console.error("[veyra:pilot] could not record a knowledge gap", err);
    }
  }
  return gap;
}

const SUGGESTIONS: Record<KnowledgeGapKind, string> = {
  missing_service: "Add the services you offer so Reception can answer for them.",
  missing_price: "Add a price to this service so Reception can quote it.",
  missing_faq: "Add an FAQ covering this question.",
  missing_hours: "Add your opening hours.",
  missing_location: "Add your address to the business profile.",
  missing_contact: "Add a phone number or email callers can use.",
  missing_policy: "Add this policy as an FAQ.",
  unknown_topic: "Review these conversations and add an FAQ if the question keeps coming up."
};

function topicLabel(kind: KnowledgeGapKind, topic: string, detail: string | null): string {
  if (detail) return detail;
  const known = TOPIC_VOCABULARY.find((definition) => definition.topic === topic);
  if (known) return known.label;
  return topic === "other" ? "Questions Veyra couldn't answer" : KNOWLEDGE_GAP_LABELS[kind];
}

/** Aggregated gaps for the range, most-asked first. */
export async function knowledgeGaps(businessId: string, range: PilotRange, limit = 20): Promise<KnowledgeGapRow[]> {
  const signals = await prisma.knowledgeGapSignal.findMany({
    where: { businessId, createdAt: rangeWindow(range) },
    orderBy: { createdAt: "desc" }
  });

  const grouped = new Map<string, { kind: KnowledgeGapKind; topic: string; detail: string | null; conversations: Set<string>; lastSeenAt: Date }>();
  for (const signal of signals) {
    const key = `${signal.kind}:${signal.topic}:${signal.detail ?? ""}`;
    const existing = grouped.get(key);
    const conversationKey = signal.conversationId ?? signal.id;
    if (existing) {
      existing.conversations.add(conversationKey);
      if (signal.createdAt > existing.lastSeenAt) existing.lastSeenAt = signal.createdAt;
    } else {
      grouped.set(key, {
        kind: signal.kind as KnowledgeGapKind,
        topic: signal.topic,
        detail: signal.detail,
        conversations: new Set([conversationKey]),
        lastSeenAt: signal.createdAt
      });
    }
  }

  return [...grouped.values()]
    .map((row) => ({
      kind: row.kind,
      topic: row.topic,
      topicLabel: topicLabel(row.kind, row.topic, row.detail),
      conversations: row.conversations.size,
      lastSeenAt: row.lastSeenAt.toISOString(),
      suggestion: row.detail ? `Add a price for ${row.detail}.` : SUGGESTIONS[row.kind]
    }))
    .sort((a, b) => b.conversations - a.conversations || b.lastSeenAt.localeCompare(a.lastSeenAt))
    .slice(0, limit);
}

/** Exposed for tests and documentation of what the vocabulary covers. */
export const knowledgeGapVocabulary = TOPIC_VOCABULARY.map(({ topic, label, kind }) => ({ topic, label, kind }));
