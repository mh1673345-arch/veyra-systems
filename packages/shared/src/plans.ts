/**
 * The single definition of Veyra's plans, entitlements and limits.
 *
 * The backend enforces access from this catalog, and the Console's plan
 * comparison is rendered from the same data the API derives from it — so there
 * is exactly one feature matrix, never a marketing copy that drifts from what
 * the server actually allows.
 *
 * Deliberately absent: prices. They are not decided yet, and nothing here
 * pretends otherwise.
 */

export type PlanCode = "STARTER" | "PRO" | "MAX";

/** Ordered lowest to highest; used to name the lowest plan that includes a feature. */
export const PLAN_ORDER: PlanCode[] = ["STARTER", "PRO", "MAX"];

export type Entitlement =
  // Answer — the core receptionist
  | "core_reception"
  | "business_knowledge"
  | "service_answers"
  | "pricing_answers"
  | "booking_requests"
  | "human_escalation"
  | "console_access"
  | "email_notifications"
  // Act — live calendar and integrations
  | "calendar_availability"
  | "calendar_booking"
  | "calendar_reschedule"
  | "calendar_cancellation"
  | "advanced_integrations"
  // Customer messaging channels — defined, not yet assigned to a plan
  | "whatsapp"
  | "sms"
  // Speak — voice (not built)
  | "voice_reception"
  | "voice_inbound"
  | "voice_outbound"
  | "advanced_automation";

export type EntitlementGroup = "answer" | "act" | "channels" | "speak";

export interface EntitlementDefinition {
  key: Entitlement;
  label: string;
  description: string;
  group: EntitlementGroup;
  /**
   * Whether Veyra actually implements this today. A plan can include a
   * feature that is not built yet; the Console must say so rather than imply
   * it works.
   */
  implemented: boolean;
}

export const ENTITLEMENT_DEFINITIONS: EntitlementDefinition[] = [
  { key: "core_reception", label: "AI receptionist", description: "Answers callers around the clock.", group: "answer", implemented: true },
  { key: "business_knowledge", label: "Business knowledge", description: "Hours, location and contact details from your settings.", group: "answer", implemented: true },
  { key: "service_answers", label: "Service answers", description: "Explains the services you offer.", group: "answer", implemented: true },
  { key: "pricing_answers", label: "Pricing answers", description: "Quotes the prices you have configured.", group: "answer", implemented: true },
  { key: "booking_requests", label: "Booking requests", description: "Collects appointment requests for your team to review.", group: "answer", implemented: true },
  { key: "human_escalation", label: "Human handoff", description: "Routes callers to your team when they need a person.", group: "answer", implemented: true },
  { key: "console_access", label: "Veyra Console", description: "Conversations, bookings, escalations and your work queue.", group: "answer", implemented: true },
  { key: "email_notifications", label: "Email alerts", description: "Emails your team about new requests (once an email provider is connected).", group: "answer", implemented: true },

  { key: "calendar_availability", label: "Live availability", description: "Checks your calendar before offering a time.", group: "act", implemented: true },
  { key: "calendar_booking", label: "Automatic booking", description: "Books confirmed appointments straight into your calendar.", group: "act", implemented: true },
  { key: "calendar_reschedule", label: "Rescheduling", description: "Moves existing appointments to a free slot.", group: "act", implemented: true },
  { key: "calendar_cancellation", label: "Cancellations", description: "Cancels appointments and frees the slot.", group: "act", implemented: true },
  { key: "advanced_integrations", label: "Advanced integrations", description: "Connections to the tools your business already uses.", group: "act", implemented: false },

  { key: "whatsapp", label: "WhatsApp", description: "Answer customers on WhatsApp.", group: "channels", implemented: false },
  { key: "sms", label: "SMS", description: "Answer customers by text message.", group: "channels", implemented: false },

  { key: "voice_reception", label: "Voice reception", description: "Veyra answers the phone.", group: "speak", implemented: false },
  { key: "voice_inbound", label: "Inbound calls", description: "Takes incoming phone calls.", group: "speak", implemented: false },
  { key: "voice_outbound", label: "Outbound calls", description: "Places confirmation and follow-up calls.", group: "speak", implemented: false },
  { key: "advanced_automation", label: "Advanced automation", description: "Multi-step workflows across your tools.", group: "speak", implemented: false }
];

export type LimitKey =
  | "team_members"
  | "monthly_conversations"
  | "business_locations"
  | "calendar_connections"
  | "monthly_voice_minutes";

/** A limit is a number, or explicitly unlimited — never an implied Infinity. */
export type LimitValue = { kind: "count"; value: number } | { kind: "unlimited" };

export interface LimitDefinition {
  key: LimitKey;
  label: string;
  /**
   * How this limit is treated today:
   *  - enforced: the backend refuses to exceed it
   *  - tracked:  real usage is counted and shown, but not blocked
   *  - planned:  the contract exists; no reliable counter yet
   */
  enforcement: "enforced" | "tracked" | "planned";
}

export const LIMIT_DEFINITIONS: LimitDefinition[] = [
  { key: "team_members", label: "Team members", enforcement: "enforced" },
  // Never enforced by cutting off callers mid-month; shown so it can be priced.
  { key: "monthly_conversations", label: "Conversations per month", enforcement: "tracked" },
  { key: "calendar_connections", label: "Calendar connections", enforcement: "tracked" },
  { key: "business_locations", label: "Locations", enforcement: "planned" },
  // Counted from completed calls. Going over blocks NEW calls; a call already
  // in progress is never cut off to enforce a limit.
  { key: "monthly_voice_minutes", label: "Voice minutes per month", enforcement: "enforced" }
];

export interface PlanDefinition {
  code: PlanCode;
  name: string;
  /** The one-word promise: Answer, Act, Speak. */
  tagline: string;
  description: string;
  entitlements: Entitlement[];
  /** Development defaults, not pricing commitments. */
  limits: Record<LimitKey, LimitValue>;
}

const count = (value: number): LimitValue => ({ kind: "count", value });
const UNLIMITED: LimitValue = { kind: "unlimited" };

const ANSWER: Entitlement[] = [
  "core_reception",
  "business_knowledge",
  "service_answers",
  "pricing_answers",
  "booking_requests",
  "human_escalation",
  "console_access",
  // Operator email alerts are part of the core workflow: a request-only
  // business depends on its team hearing about new requests.
  "email_notifications"
];

const ACT: Entitlement[] = [
  "calendar_availability",
  "calendar_booking",
  "calendar_reschedule",
  "calendar_cancellation",
  "advanced_integrations"
];

const SPEAK: Entitlement[] = ["voice_reception", "voice_inbound", "voice_outbound", "advanced_automation"];

/**
 * Entitlements that belong to no plan yet.
 *
 * SMS and WhatsApp are built but their plan placement is a product and
 * pricing decision nobody has made, so they are not quietly folded into
 * Starter, Pro or Max. They can only be switched on per business by an
 * explicit, audited rollout grant — which is a deliberate act with a name
 * against it, not a configuration checkbox.
 *
 * A grant may only ever name an entitlement on this list. Nothing here can
 * be used to hand out a paid plan feature for free.
 */
export const ROLLOUT_ENTITLEMENTS: Entitlement[] = ["sms", "whatsapp"];

export function isRolloutEntitlement(entitlement: Entitlement): boolean {
  return ROLLOUT_ENTITLEMENTS.includes(entitlement);
}

export const PLAN_CATALOG: Record<PlanCode, PlanDefinition> = {
  STARTER: {
    code: "STARTER",
    name: "Starter",
    tagline: "Answer",
    description: "An AI receptionist that answers callers and collects booking requests for your team.",
    entitlements: [...ANSWER],
    limits: {
      team_members: count(3),
      monthly_conversations: count(500),
      business_locations: count(1),
      calendar_connections: count(0),
      monthly_voice_minutes: count(0)
    }
  },
  PRO: {
    code: "PRO",
    name: "Pro",
    tagline: "Act",
    description: "Everything in Starter, plus live calendar availability and automatic booking.",
    entitlements: [...ANSWER, ...ACT],
    limits: {
      team_members: count(10),
      monthly_conversations: count(2000),
      business_locations: count(3),
      calendar_connections: count(1),
      monthly_voice_minutes: count(0)
    }
  },
  MAX: {
    code: "MAX",
    name: "Max",
    tagline: "Speak",
    description: "Everything in Pro, plus voice reception and advanced automation.",
    entitlements: [...ANSWER, ...ACT, ...SPEAK],
    limits: {
      team_members: UNLIMITED,
      monthly_conversations: UNLIMITED,
      business_locations: count(10),
      calendar_connections: count(5),
      monthly_voice_minutes: count(1000)
    }
  }
};

/**
 * What a business keeps when its subscription is cancelled or expired (or it
 * has none): the core receptionist, so callers are never abandoned, and the
 * Console, so the owner can see what happened. Paid automation switches off.
 */
export const DEGRADED_ENTITLEMENTS: Entitlement[] = [...ANSWER];

export function planIncludes(plan: PlanCode, entitlement: Entitlement): boolean {
  return PLAN_CATALOG[plan].entitlements.includes(entitlement);
}

/** The lowest plan that includes an entitlement, or null if no plan does yet. */
export function lowestPlanWith(entitlement: Entitlement): PlanCode | null {
  return PLAN_ORDER.find((plan) => planIncludes(plan, entitlement)) ?? null;
}

export function isPlanCode(value: string): value is PlanCode {
  return (PLAN_ORDER as string[]).includes(value);
}

export function isEntitlement(value: string): value is Entitlement {
  return ENTITLEMENT_DEFINITIONS.some((definition) => definition.key === value);
}

/* ------------------------------------------------------------------ *
 * Subscription
 * ------------------------------------------------------------------ */

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "cancelled" | "expired";

/**
 * How each status maps to access (see AccessService):
 *  - trialing, active: the plan's entitlements
 *  - past_due:         the plan's entitlements, flagged for billing attention —
 *                      Reception is not cut off over a late payment
 *  - cancelled, expired, or no subscription: DEGRADED_ENTITLEMENTS only
 */
export const FULL_ACCESS_STATUSES: SubscriptionStatus[] = ["trialing", "active", "past_due"];

/** The stable error body for a feature the subscription doesn't include. */
export interface EntitlementRequiredError {
  error: string;
  code: "ENTITLEMENT_REQUIRED";
  entitlement: Entitlement;
  /** Lowest plan that includes it; null when no plan includes it yet. */
  requiredPlan: PlanCode | null;
}

export interface PlanLimitReachedError {
  error: string;
  code: "PLAN_LIMIT_REACHED";
  limit: LimitKey;
  allowed: number;
  requiredPlan: PlanCode | null;
}

/* ------------------------------------------------------------------ *
 * Console DTOs
 * ------------------------------------------------------------------ */

export interface OpsLimitUsage {
  key: LimitKey;
  label: string;
  limit: LimitValue;
  /** Real usage where a reliable counter exists; null otherwise. */
  used: number | null;
  enforcement: LimitDefinition["enforcement"];
}

export interface OpsEntitlementState {
  key: Entitlement;
  label: string;
  description: string;
  group: EntitlementGroup;
  implemented: boolean;
  /** Included in the business's effective access right now. */
  included: boolean;
  /** Lowest plan that would include it, for a locked feature. */
  requiredPlan: PlanCode | null;
}

export interface OpsPlanSummary {
  code: PlanCode;
  name: string;
  tagline: string;
  description: string;
  entitlements: Entitlement[];
  limits: Record<LimitKey, LimitValue>;
}

/** GET /api/ops/businesses/:id/subscription */
export interface OpsSubscription {
  businessId: string;
  businessName: string;
  plan: OpsPlanSummary | null;
  status: SubscriptionStatus | "none";
  /** True when paid features are switched off because of the status. */
  degraded: boolean;
  /** Past due: service continues, but the owner should know. */
  billingAttention: boolean;
  startsAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  cancelledAt: string | null;
  entitlements: OpsEntitlementState[];
  limits: OpsLimitUsage[];
  /** Every plan, from the same catalog the server enforces. */
  plans: OpsPlanSummary[];
  /** True when a billing provider is configured and plans can be bought in-app. */
  billingAvailable: boolean;
  billing: OpsBilling;
}

/* ------------------------------------------------------------------ *
 * Billing
 * ------------------------------------------------------------------ */

/** A plan's price as the Console shows it. Provider price ids never leave the server. */
export interface OpsPlanPrice {
  plan: PlanCode;
  currency: string;
  interval: "month" | "year";
  amountMinor: number;
  displayAmount: string;
  /** False while pricing is provisional — the Console labels it. */
  final: boolean;
}

export interface OpsOverLimit {
  key: LimitKey;
  label: string;
  used: number;
  allowed: number;
}

export interface OpsBilling {
  available: boolean;
  provider: "fake" | "stripe" | null;
  /** The development provider: nothing is charged. The Console must say so. */
  simulated: boolean;
  prices: OpsPlanPrice[];
  billingInterval: string | null;
  /** A paid subscription exists at the provider. */
  hasPaidSubscription: boolean;
  cancelAtPeriodEnd: boolean;
  scheduledPlan: PlanCode | null;
  scheduledChangeAt: string | null;
  /** The viewer holds billing:manage (OWNER). */
  canManage: boolean;
  /** What the server will accept right now — the Console shows only these. */
  actions: {
    checkout: PlanCode[];
    changePlan: PlanCode[];
    portal: boolean;
    cancel: boolean;
    resume: boolean;
  };
  /** A checkout started in the last hour that no webhook has confirmed yet. */
  pendingCheckout: { targetPlan: PlanCode; createdAt: string } | null;
  /** Usage above the current plan's limits (e.g. after a downgrade). Nothing is deleted. */
  overLimit: OpsOverLimit[];
  trialDays: number | null;
}

/** POST checkout / change-plan / portal responses. */
export interface BillingRedirect {
  url: string;
}

export interface BillingChangeResult {
  /** Always "pending": the plan changes only once the provider's webhook confirms it. */
  state: "pending";
  message: string;
}
