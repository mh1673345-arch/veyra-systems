import type { PlanCode } from "./plans.js";

/**
 * Voice — the Max channel.
 *
 * Veyra answers the phone with the same brain it answers everything else
 * with. These types describe the channel: how a business configures it, what
 * happened on a call, and what the Console may show. Nothing here re-describes
 * services, prices, calendars or plans.
 */

export type CallDirection = "inbound" | "outbound";

export type CallStatus = "initiated" | "ringing" | "active" | "transferring" | "completed" | "failed" | "missed";

export const CALL_STATUS_LABELS: Record<CallStatus, string> = {
  initiated: "Starting",
  ringing: "Ringing",
  active: "In progress",
  transferring: "Transferring",
  completed: "Completed",
  failed: "Failed",
  missed: "Not answered"
};

/** The voices a business may pick. Never free text — a voice setting must never become an instruction. */
export const VOICE_PROFILES = ["neutral", "warm", "bright"] as const;
export type VoiceProfileName = (typeof VOICE_PROFILES)[number];

export const AFTER_HOURS_BEHAVIORS = ["continue", "booking_request", "callback", "voicemail", "handoff"] as const;
export type AfterHoursBehavior = (typeof AFTER_HOURS_BEHAVIORS)[number];

export const AFTER_HOURS_LABELS: Record<AfterHoursBehavior, string> = {
  continue: "Keep answering as usual",
  booking_request: "Take a booking request",
  callback: "Take callback details",
  voicemail: "Play a message and hang up",
  handoff: "Put the caller through to the on-call number"
};

export const TRANSCRIPT_POLICIES = ["store", "metadata_only"] as const;
export type TranscriptPolicy = (typeof TRANSCRIPT_POLICIES)[number];

export const RECORDING_POLICIES = ["disabled", "enabled"] as const;
export type RecordingPolicy = (typeof RECORDING_POLICIES)[number];

export interface VoiceSettingsDto {
  businessId: string;
  enabled: boolean;
  provider: string | null;
  businessPhoneNumber: string | null;
  callerId: string | null;
  language: string;
  voiceProfile: VoiceProfileName;
  greeting: string | null;
  afterHoursBehavior: AfterHoursBehavior;
  handoffNumber: string | null;
  voicemailGreeting: string | null;
  maxCallSeconds: number;
  recordingPolicy: RecordingPolicy;
  transcriptPolicy: TranscriptPolicy;
}

/** What the Console needs to render the Voice section honestly. */
export interface VoiceOverview {
  businessId: string;
  /** The plan includes voice. */
  entitled: boolean;
  requiredPlan: PlanCode | null;
  plan: PlanCode | null;
  settings: VoiceSettingsDto | null;
  /** A provider is configured on the server, and what it reports. */
  provider: { name: string | null; configured: boolean; healthy: boolean; detail: string; simulated: boolean };
  /** Speech recognition and synthesis, which are configured separately from the carrier. */
  speech: {
    stt: { name: string | null; configured: boolean; healthy: boolean; detail: string; simulated: boolean };
    tts: { name: string | null; configured: boolean; healthy: boolean; detail: string; simulated: boolean };
  };
  /**
   * True only when a plan, configuration and a healthy provider all line up —
   * i.e. Veyra would really answer a call right now.
   */
  live: boolean;
  /**
   * Why voice isn't live, when it isn't. Shown to the operator as-is.
   */
  blockedReason: string | null;
  usage: { minutesThisPeriod: number; limit: number | null; calls: number };
  canManage: boolean;
}

export interface CallSummary {
  id: string;
  businessId: string;
  conversationId: string | null;
  direction: CallDirection;
  status: CallStatus;
  /** Partly masked: enough to recognise a caller, not enough to leak a full number. */
  callerNumber: string | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  handoffOccurred: boolean;
  /** What the call produced, derived from the records it created. */
  outcome: "booking" | "handoff" | "answered" | "missed" | "failed" | "no_outcome";
  bookingId: string | null;
  escalationId: string | null;
}

export interface CallTurnDto {
  at: string;
  speaker: "caller" | "veyra";
  text: string | null;
  intent: string | null;
  action: string | null;
  /** Where the time went, in milliseconds. Operator-facing only. */
  latency: { responderMs: number | null; actionMs: number | null; ttsMs: number | null; totalMs: number | null } | null;
  interrupted: boolean;
}

export interface CallDetail extends CallSummary {
  businessNumber: string | null;
  hangupReason: string | null;
  provider: string;
  /** Empty when the business keeps metadata only. */
  turns: CallTurnDto[];
  transcriptStored: boolean;
  recordingEnabled: boolean;
  latencySummary: { turns: number; medianTotalMs: number | null; p95TotalMs: number | null };
}

/**
 * Shown wherever Max's voice features are listed, until a real call has been
 * made through a real carrier. Max grants the entitlement; the phone line
 * still has to be set up and proven.
 */
export const VOICE_ROLLOUT_NOTE = "Voice setup / rollout required";
