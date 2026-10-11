/**
 * Self-service setup: onboarding steps, industry templates and the Console
 * DTOs for configuring a workspace.
 *
 * Templates only ever *suggest*: a question worth answering, a service worth
 * listing, a sensible notice period. They never carry an answer, a price or a
 * duration, because those are facts only the business can supply.
 */

/* ------------------------------------------------------------------ *
 * Onboarding
 * ------------------------------------------------------------------ */

export type OnboardingStep =
  | "business_details"
  | "services"
  | "knowledge"
  | "hours"
  | "booking"
  | "escalation"
  | "team"
  | "integrations"
  | "review"
  | "go_live";

export interface OnboardingStepDefinition {
  key: OnboardingStep;
  label: string;
  /** Required steps cannot be skipped. */
  required: boolean;
}

export const ONBOARDING_STEPS: OnboardingStepDefinition[] = [
  { key: "business_details", label: "Business details", required: true },
  { key: "services", label: "Services", required: false },
  { key: "knowledge", label: "FAQs & knowledge", required: false },
  { key: "hours", label: "Working hours", required: false },
  { key: "booking", label: "Booking setup", required: false },
  { key: "escalation", label: "Escalation", required: false },
  { key: "team", label: "Team", required: false },
  { key: "integrations", label: "Integrations", required: false },
  { key: "review", label: "Review", required: true },
  { key: "go_live", label: "Go live", required: true }
];

export function isOnboardingStep(value: string): value is OnboardingStep {
  return ONBOARDING_STEPS.some((step) => step.key === value);
}

export interface OnboardingState {
  businessId: string;
  steps: {
    key: OnboardingStep;
    label: string;
    required: boolean;
    status: "complete" | "skipped" | "pending";
  }[];
  /** The first step that is neither complete nor skipped. */
  nextStep: OnboardingStep | null;
  completedAt: string | null;
}

/* ------------------------------------------------------------------ *
 * Industry templates
 * ------------------------------------------------------------------ */

export type Industry =
  | "dental"
  | "salon"
  | "clinic"
  | "real_estate"
  | "legal"
  | "restaurant"
  | "general";

export interface IndustryTemplate {
  key: Industry;
  label: string;
  /** Names to start from. No prices or durations: those are the business's facts. */
  suggestedServices: string[];
  /** Questions callers commonly ask. Never pre-answered. */
  suggestedQuestions: { question: string; category: string }[];
  /** Safe starting booking rules, applied at workspace creation, all editable. */
  bookingDefaults: {
    minNoticeMinutes: number;
    maxHorizonDays: number;
    slotIntervalMinutes: number;
    bufferAfterMinutes: number;
  };
  /** Advice shown next to escalation settings, not a rule. */
  escalationHint: string;
}

export const INDUSTRY_TEMPLATES: Record<Industry, IndustryTemplate> = {
  dental: {
    key: "dental",
    label: "Dental practice",
    suggestedServices: ["Check-up and clean", "Teeth whitening", "Emergency appointment", "Fillings"],
    suggestedQuestions: [
      { question: "Do you accept insurance?", category: "Payments" },
      { question: "Do you see children?", category: "Patients" },
      { question: "What should I bring to my first appointment?", category: "Visits" },
      { question: "Is there parking nearby?", category: "Location" }
    ],
    bookingDefaults: { minNoticeMinutes: 120, maxHorizonDays: 60, slotIntervalMinutes: 30, bufferAfterMinutes: 10 },
    escalationHint: "Callers in pain or with a dental emergency usually need a person quickly."
  },
  salon: {
    key: "salon",
    label: "Salon or spa",
    suggestedServices: ["Haircut", "Colour", "Blow-dry", "Manicure"],
    suggestedQuestions: [
      { question: "Do you take walk-ins?", category: "Bookings" },
      { question: "What is your cancellation policy?", category: "Bookings" },
      { question: "Do you sell gift vouchers?", category: "Payments" }
    ],
    bookingDefaults: { minNoticeMinutes: 60, maxHorizonDays: 45, slotIntervalMinutes: 15, bufferAfterMinutes: 5 },
    escalationHint: "Complaints about a recent appointment are best handled by a person."
  },
  clinic: {
    key: "clinic",
    label: "Medical or therapy clinic",
    suggestedServices: ["Initial consultation", "Follow-up appointment"],
    suggestedQuestions: [
      { question: "Do I need a referral?", category: "Patients" },
      { question: "Do you accept insurance?", category: "Payments" },
      { question: "How long is a first appointment?", category: "Visits" }
    ],
    bookingDefaults: { minNoticeMinutes: 240, maxHorizonDays: 60, slotIntervalMinutes: 30, bufferAfterMinutes: 10 },
    escalationHint: "Anything that sounds urgent or clinical should go to a person — Reception never gives medical advice."
  },
  real_estate: {
    key: "real_estate",
    label: "Real estate",
    suggestedServices: ["Property viewing", "Valuation", "Letting consultation"],
    suggestedQuestions: [
      { question: "Which areas do you cover?", category: "Coverage" },
      { question: "What are your fees?", category: "Payments" }
    ],
    bookingDefaults: { minNoticeMinutes: 240, maxHorizonDays: 30, slotIntervalMinutes: 30, bufferAfterMinutes: 15 },
    escalationHint: "Offers and negotiations should always go to an agent."
  },
  legal: {
    key: "legal",
    label: "Legal practice",
    suggestedServices: ["Initial consultation"],
    suggestedQuestions: [
      { question: "Which areas of law do you cover?", category: "Services" },
      { question: "Do you offer a free first consultation?", category: "Payments" }
    ],
    bookingDefaults: { minNoticeMinutes: 1440, maxHorizonDays: 30, slotIntervalMinutes: 30, bufferAfterMinutes: 15 },
    escalationHint: "Reception never gives legal advice; case questions should go to the team."
  },
  restaurant: {
    key: "restaurant",
    label: "Restaurant",
    suggestedServices: ["Table reservation", "Private dining"],
    suggestedQuestions: [
      { question: "Do you cater for allergies?", category: "Food" },
      { question: "Do you take large group bookings?", category: "Bookings" },
      { question: "Is there a dress code?", category: "Visits" }
    ],
    bookingDefaults: { minNoticeMinutes: 60, maxHorizonDays: 30, slotIntervalMinutes: 15, bufferAfterMinutes: 0 },
    escalationHint: "Allergy questions beyond what you've written down should go to a person."
  },
  general: {
    key: "general",
    label: "Other business",
    suggestedServices: [],
    suggestedQuestions: [
      { question: "Where are you located?", category: "Location" },
      { question: "How can I pay?", category: "Payments" }
    ],
    bookingDefaults: { minNoticeMinutes: 120, maxHorizonDays: 60, slotIntervalMinutes: 30, bufferAfterMinutes: 0 },
    escalationHint: "Decide which questions should always reach a person."
  }
};

export function isIndustry(value: string): value is Industry {
  return value in INDUSTRY_TEMPLATES;
}

/* ------------------------------------------------------------------ *
 * Reception presentation — structured choices, never free prompts
 * ------------------------------------------------------------------ */

export type ReceptionStatus = "draft" | "active" | "paused";
export type ReceptionTone = "professional" | "warm" | "concise" | "premium";
export type ClosingStyle = "none" | "offer_help" | "thank_you";

export const RECEPTION_TONES: { key: ReceptionTone; label: string; description: string }[] = [
  { key: "professional", label: "Professional", description: "Clear, courteous and to the point." },
  { key: "warm", label: "Warm", description: "Friendly and reassuring." },
  { key: "concise", label: "Concise", description: "As short as possible." },
  { key: "premium", label: "Premium", description: "Polished, attentive and unhurried." }
];

export const CLOSING_STYLES: { key: ClosingStyle; label: string; example: string }[] = [
  { key: "none", label: "No closing line", example: "" },
  { key: "offer_help", label: "Offer more help", example: "Is there anything else I can help with?" },
  { key: "thank_you", label: "Thank the caller", example: "Thanks for getting in touch." }
];

/* ------------------------------------------------------------------ *
 * Console DTOs
 * ------------------------------------------------------------------ */

export interface SignupRequest {
  name: string;
  email: string;
  password: string;
}

export interface CreateWorkspaceRequest {
  name: string;
  industry: Industry;
  timezone: string;
  email: string;
  phone: string;
  website?: string;
  address?: string;
}

export interface BusinessProfile {
  businessId: string;
  name: string;
  industry: Industry;
  timezone: string;
  contactPhone: string | null;
  contactEmail: string | null;
  website: string | null;
  address: string;
  description: string;
}

export interface ConfigService {
  id: string;
  name: string;
  description: string;
  price: string;
  priceNote: string | null;
  durationMinutes: number | null;
  bookable: boolean;
  active: boolean;
  sortOrder: number;
  /** Bookings that reference it; archived services with bookings are kept, never deleted. */
  bookingCount: number;
}

export interface ServiceInput {
  name: string;
  description?: string;
  price?: string;
  priceNote?: string | null;
  durationMinutes?: number | null;
  bookable?: boolean;
}

export interface ConfigFaq {
  id: string;
  question: string;
  answer: string;
  category: string | null;
  active: boolean;
  sortOrder: number;
}

export interface FaqInput {
  question: string;
  answer: string;
  category?: string | null;
}

/** "HH:MM" in the business timezone. */
export interface HoursPeriod {
  opens: string;
  closes: string;
}

export interface WorkingDay {
  /** ISO weekday: 1 = Monday ... 7 = Sunday. */
  dayOfWeek: number;
  /** Empty = closed. */
  periods: HoursPeriod[];
  /** Whether bookings may be taken on this day. */
  bookable: boolean;
}

export interface WorkingHours {
  timezone: string;
  days: WorkingDay[];
}

export interface BookingSettings {
  bookingRequestsEnabled: boolean;
  minNoticeMinutes: number;
  maxHorizonDays: number;
  slotIntervalMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  /** Only meaningful, and only editable, when the plan includes live calendar. */
  calendarBookingEnabled: boolean;
  calendarEntitled: boolean;
  calendarRequiredPlan: "STARTER" | "PRO" | "MAX" | null;
}

export interface EscalationSettings {
  humanEscalationEnabled: boolean;
  escalationPhone: string | null;
  escalationEmail: string | null;
  fallbackMessage: string | null;
}

export interface ReceptionSettings {
  status: ReceptionStatus;
  statusChangedAt: string | null;
  assistantName: string | null;
  greeting: string;
  tone: ReceptionTone;
  closingStyle: ClosingStyle;
}

export type ReadinessLevel = "ready" | "warning" | "blocking";

export type ReadinessCheckKey =
  | "business_profile"
  | "contact_method"
  | "services"
  | "knowledge"
  | "working_hours"
  | "booking_configuration"
  | "escalation_configuration";

export interface ReadinessCheck {
  key: ReadinessCheckKey;
  level: ReadinessLevel;
  message: string;
}

export interface ReadinessReport {
  businessId: string;
  /** No blocking checks: Reception may be activated. */
  canActivate: boolean;
  status: ReceptionStatus;
  checks: ReadinessCheck[];
}

/** What Reception currently knows — the facts, never the prompt. */
export interface KnowledgePreview {
  business: {
    name: string;
    industry: string;
    description: string;
    address: string;
    phone: string | null;
    email: string | null;
    website: string | null;
    timezone: string;
  };
  presentation: { assistantName: string | null; greeting: string; tone: ReceptionTone; closingStyle: ClosingStyle };
  hoursSummary: string;
  services: { name: string; price: string; priceNote: string | null; durationMinutes: number | null; bookable: boolean }[];
  faqs: { question: string; answer: string; category: string | null }[];
  booking: { requestsEnabled: boolean; liveCalendar: boolean; minNoticeMinutes: number; maxHorizonDays: number };
  escalation: { enabled: boolean; phone: string | null; email: string | null };
  /** Integrations that are live, and features the plan does not include. */
  integrations: { calendar: "live" | "not_connected" | "not_in_plan" };
  planRestrictions: string[];
  status: ReceptionStatus;
}
