import type { PlanCode, SubscriptionStatus } from "./plans.js";
import type { ReadinessLevel } from "./setup.js";

/**
 * Pilot operations: the vocabulary Veyra uses to run, measure and review a
 * real pilot.
 *
 * Two rules shape everything here:
 *
 *   1. Nothing is invented. A number is only reported when it can be derived
 *      from records Veyra actually holds; anything else is `null`, which the
 *      Console renders as "Not available" — never as 0.
 *   2. Measurement is not proof. These types describe *observed activity*
 *      during a pilot. They say nothing about revenue, time saved or customer
 *      satisfaction, and no field here should ever be presented as such.
 */

/* ------------------------------------------------------------------ *
 * Pilot state
 * ------------------------------------------------------------------ */

/** Deliberately separate from SubscriptionStatus: a Pro business may run no pilot at all. */
export type PilotStatus = "none" | "preparing" | "active" | "paused" | "completed";

export const PILOT_STATUSES: PilotStatus[] = ["none", "preparing", "active", "paused", "completed"];

/** Which moves are allowed from each state. A completed pilot is final. */
export const PILOT_TRANSITIONS: Record<PilotStatus, PilotStatus[]> = {
  none: ["preparing"],
  preparing: ["active", "none"],
  active: ["paused", "completed"],
  paused: ["active", "completed"],
  completed: []
};

export function canTransitionPilot(from: PilotStatus, to: PilotStatus): boolean {
  return PILOT_TRANSITIONS[from].includes(to);
}

export interface PilotState {
  status: PilotStatus;
  startedAt: string | null;
  endedAt: string | null;
  label: string | null;
  notes: string | null;
}

/**
 * Operational brakes that sit BELOW entitlements. Each one can only ever
 * withhold something; none can grant a feature the plan excludes.
 */
export interface PilotSafetyControls {
  allowAutoBooking: boolean;
  allowAutoReschedule: boolean;
  allowAutoCancellation: boolean;
  allowEscalation: boolean;
  allowNotifications: boolean;
}

export type PilotSafetyKey = keyof PilotSafetyControls;

export const PILOT_SAFETY_KEYS: PilotSafetyKey[] = [
  "allowAutoBooking",
  "allowAutoReschedule",
  "allowAutoCancellation",
  "allowEscalation",
  "allowNotifications"
];

export const PILOT_SAFETY_LABELS: Record<PilotSafetyKey, string> = {
  allowAutoBooking: "Automatic booking",
  allowAutoReschedule: "Automatic rescheduling",
  allowAutoCancellation: "Automatic cancellation",
  allowEscalation: "Human handoff",
  allowNotifications: "Notifications"
};

/** Goals an operator sets for a pilot. Targets, not forecasts or guarantees. */
export interface PilotTargets {
  targetConversations: number | null;
  targetBookingRequests: number | null;
  targetConfirmedBookings: number | null;
  /** 0..1 */
  maxHumanInterventionRate: number | null;
  maxUnresolvedIssues: number | null;
}

/* ------------------------------------------------------------------ *
 * Pilot readiness
 * ------------------------------------------------------------------ */

/**
 * Distinct from Reception readiness ("can this business go live?"). This asks
 * "can we safely *monitor* this business as a real pilot?".
 */
export type PilotReadinessKey =
  | "reception_live"
  | "owner"
  | "services"
  | "knowledge"
  | "working_hours"
  | "escalation_contact"
  | "subscription"
  | "entitlements"
  | "notifications"
  | "calendar"
  | "responder"
  | "configuration"
  | "audit";

export interface PilotReadinessCheck {
  key: PilotReadinessKey;
  level: ReadinessLevel;
  message: string;
  /** What would fix it, when there is a concrete step. */
  hint?: string;
}

export interface PilotReadinessReport {
  businessId: string;
  /** No blocking checks: the pilot can be activated and monitored. */
  canActivate: boolean;
  /** True when the pilot needs live calendar booking, which raises the bar. */
  requiresLiveBooking: boolean;
  level: ReadinessLevel;
  checks: PilotReadinessCheck[];
}

/* ------------------------------------------------------------------ *
 * Metrics
 * ------------------------------------------------------------------ */

export type PilotRangeKey = "today" | "last_7_days" | "last_30_days" | "pilot_lifetime" | "custom";

export interface PilotRange {
  key: PilotRangeKey;
  /** Inclusive start, ISO. Resolved in the business's timezone. */
  from: string;
  /** Exclusive end, ISO. */
  to: string;
  timezone: string;
  label: string;
}

/**
 * A measured value. `value: null` means "not measurable from what Veyra
 * holds" — the Console must render that as "Not available", never 0.
 */
export interface PilotMetric {
  key: string;
  label: string;
  value: number | null;
  /** Plain-English definition, shown as helper text next to the number. */
  definition: string;
  /** Set when the value could not be derived. */
  unavailableReason?: string;
  unit?: "count" | "percent" | "seconds";
}

export interface PilotMetrics {
  range: PilotRange;
  activity: PilotMetric[];
  outcomes: PilotMetric[];
  /** Derived rates, only where the denominator is explicit. */
  derived: PilotMetric[];
}

/** Conversation outcome. Derived from evidence, or corrected by an operator. */
export type ConversationOutcome =
  | "answered"
  | "booking_requested"
  | "booking_confirmed"
  | "escalated"
  | "human_intervention"
  | "out_of_scope"
  | "abandoned"
  | "failed"
  /** Not enough evidence to classify — never guessed. */
  | "undetermined";

export const CONVERSATION_OUTCOMES: ConversationOutcome[] = [
  "answered",
  "booking_requested",
  "booking_confirmed",
  "escalated",
  "human_intervention",
  "out_of_scope",
  "abandoned",
  "failed",
  "undetermined"
];

export const CONVERSATION_OUTCOME_LABELS: Record<ConversationOutcome, string> = {
  answered: "Answered",
  booking_requested: "Booking requested",
  booking_confirmed: "Booking confirmed",
  escalated: "Escalated",
  human_intervention: "Human intervention",
  out_of_scope: "Out of scope",
  abandoned: "Abandoned",
  failed: "Failed",
  undetermined: "Undetermined"
};

export interface ConversationOutcomeState {
  outcome: ConversationOutcome;
  source: "derived" | "operator";
  /** Why the derivation landed here — the evidence, in one line. */
  evidence: string;
  overriddenBy?: string | null;
  overriddenAt?: string | null;
  note?: string | null;
}

/* ------------------------------------------------------------------ *
 * Feedback and issues
 * ------------------------------------------------------------------ */

export type FeedbackRating = "correct" | "partially_correct" | "incorrect" | "needed_human";

export const FEEDBACK_RATINGS: FeedbackRating[] = ["correct", "partially_correct", "incorrect", "needed_human"];

export const FEEDBACK_RATING_LABELS: Record<FeedbackRating, string> = {
  correct: "Correct",
  partially_correct: "Partially correct",
  incorrect: "Incorrect",
  needed_human: "Needed a human"
};

export type PilotIssueCategory =
  | "incorrect_answer"
  | "missing_business_information"
  | "wrong_business_information"
  | "bad_tone"
  | "booking_issue"
  | "escalation_issue"
  | "needed_human"
  | "other";

export const PILOT_ISSUE_CATEGORIES: PilotIssueCategory[] = [
  "incorrect_answer",
  "missing_business_information",
  "wrong_business_information",
  "bad_tone",
  "booking_issue",
  "escalation_issue",
  "needed_human",
  "other"
];

export const PILOT_ISSUE_CATEGORY_LABELS: Record<PilotIssueCategory, string> = {
  incorrect_answer: "Veyra answered incorrectly",
  missing_business_information: "Business information missing",
  wrong_business_information: "Business information wrong",
  bad_tone: "Tone was wrong",
  booking_issue: "Booking problem",
  escalation_issue: "Handoff problem",
  needed_human: "Should have involved a person",
  other: "Something else"
};

export type PilotIssueStatus = "open" | "reviewing" | "resolved" | "dismissed";

export const PILOT_ISSUE_STATUSES: PilotIssueStatus[] = ["open", "reviewing", "resolved", "dismissed"];

export const PILOT_ISSUE_TRANSITIONS: Record<PilotIssueStatus, PilotIssueStatus[]> = {
  open: ["reviewing", "resolved", "dismissed"],
  reviewing: ["resolved", "dismissed", "open"],
  resolved: ["open"],
  dismissed: ["open"]
};

export interface PilotIssueDto {
  id: string;
  businessId: string;
  conversationId: string | null;
  messageId: string | null;
  category: PilotIssueCategory;
  note: string | null;
  status: PilotIssueStatus;
  resolutionNote: string | null;
  reportedBy: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationFeedbackDto {
  id: string;
  conversationId: string;
  messageId: string | null;
  rating: FeedbackRating;
  note: string | null;
  actor: string | null;
  createdAt: string;
}

/* ------------------------------------------------------------------ *
 * Knowledge gaps
 * ------------------------------------------------------------------ */

export type KnowledgeGapKind =
  | "missing_service"
  | "missing_price"
  | "missing_faq"
  | "missing_hours"
  | "missing_location"
  | "missing_contact"
  | "missing_policy"
  | "unknown_topic";

export const KNOWLEDGE_GAP_LABELS: Record<KnowledgeGapKind, string> = {
  missing_service: "Service not on file",
  missing_price: "Price not on file",
  missing_faq: "No answer on file",
  missing_hours: "Opening hours not on file",
  missing_location: "Location not on file",
  missing_contact: "Contact details not on file",
  missing_policy: "Policy not on file",
  unknown_topic: "Topic Veyra knows nothing about"
};

export interface KnowledgeGapRow {
  kind: KnowledgeGapKind;
  /** Normalised topic from a fixed vocabulary, e.g. "parking". */
  topic: string;
  topicLabel: string;
  /** How many separate conversations raised it in the range. */
  conversations: number;
  lastSeenAt: string;
  /** What the business could add to close it. Deterministic, not advice. */
  suggestion: string;
}

/* ------------------------------------------------------------------ *
 * Health, alerts, timeline
 * ------------------------------------------------------------------ */

export type HealthLevel = "ok" | "degraded" | "unavailable" | "not_configured";

export interface HealthItem {
  key: "responder" | "calendar" | "notifications" | "billing" | "email";
  label: string;
  level: HealthLevel;
  detail: string;
}

export interface PilotAlert {
  key: string;
  level: "warning" | "critical";
  message: string;
  /** The threshold that produced it, so nothing looks like a silent rule. */
  threshold: string;
}

export interface PilotTimelineEntry {
  at: string;
  kind: string;
  summary: string;
  /** operator | system | billing_provider | caller */
  actorType: string;
  actor: string | null;
  reference?: { type: "conversation" | "booking" | "escalation" | "issue"; id: string } | null;
}

/* ------------------------------------------------------------------ *
 * Console payloads
 * ------------------------------------------------------------------ */

export interface PilotOverview {
  businessId: string;
  businessName: string;
  timezone: string;
  pilot: PilotState;
  targets: PilotTargets;
  safety: PilotSafetyControls;
  /** Safety controls the plan does not include anyway; shown as unavailable. */
  safetyLockedByPlan: PilotSafetyKey[];
  plan: PlanCode | null;
  subscriptionStatus: SubscriptionStatus | "none";
  receptionStatus: string;
  readiness: PilotReadinessReport;
  health: HealthItem[];
  alerts: PilotAlert[];
  metrics: PilotMetrics;
  openIssues: number;
  /** What this viewer may do, decided by the server. */
  canManage: boolean;
  canReport: boolean;
  canTriage: boolean;
}

export interface PilotSeriesPoint {
  /** Local date in the business timezone, YYYY-MM-DD. */
  date: string;
  conversations: number;
  bookings: number;
  escalations: number;
}

export interface PilotIntentCount {
  intent: string;
  label: string;
  count: number;
}

export interface PilotReport {
  businessId: string;
  businessName: string;
  generatedAt: string;
  range: PilotRange;
  metrics: PilotMetrics;
  series: PilotSeriesPoint[];
  topIntents: PilotIntentCount[];
  knowledgeGaps: KnowledgeGapRow[];
  issuesByCategory: { category: PilotIssueCategory; label: string; open: number; total: number }[];
  unresolvedIssues: PilotIssueDto[];
  outcomes: { outcome: ConversationOutcome; label: string; count: number }[];
  /** Grounded in the counts above — each one names the evidence that produced it. */
  recommendations: { message: string; evidence: string }[];
}

export type PilotExportKind =
  | "conversations"
  | "bookings"
  | "escalations"
  | "issues"
  | "knowledge_gaps"
  | "metrics";

export const PILOT_EXPORT_KINDS: PilotExportKind[] = [
  "conversations",
  "bookings",
  "escalations",
  "issues",
  "knowledge_gaps",
  "metrics"
];

/* ------------------------------------------------------------------ *
 * Thresholds
 * ------------------------------------------------------------------ */

/**
 * Development defaults for pilot alerts, in one place so no threshold is
 * buried in a component. These are starting points chosen for development,
 * not findings from real pilots.
 */
export const PILOT_ALERT_DEFAULTS = {
  /** Share of receptionist replies that fell back to the deterministic responder. */
  fallbackRateWarning: 0.3,
  /** Minimum replies before a rate is worth reporting at all. */
  minimumSampleForRates: 20,
  /** Separate conversations raising the same knowledge gap. */
  knowledgeGapWarning: 5,
  unresolvedEscalationsWarning: 5,
  openIssuesWarning: 10,
  notificationFailureWarning: 3
} as const;

/* ------------------------------------------------------------------ *
 * Demo
 * ------------------------------------------------------------------ */

/** Which business the public Reception demo talks to, and why that one. */
export interface DemoBusinessInfo {
  businessId: string | null;
  name: string | null;
  /** configured: VEYRA_DEMO_BUSINESS_ID. fallback: oldest eligible business. */
  source: "configured" | "fallback" | "none";
  /** True when a demo business is explicitly configured on the server. */
  pinned: boolean;
}
