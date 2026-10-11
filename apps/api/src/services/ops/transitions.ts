import type { AppointmentStatus, EscalationStatus } from "@veyra/shared";

/**
 * The single source of truth for operator status changes. The UI may disable
 * buttons, but validity is decided here — every mutation endpoint checks this.
 *
 * The AI never reaches this module: assistant actions can create a booking
 * request or an escalation, but only a human operator moves one along.
 */

export const BOOKING_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  draft: ["submitted", "cancelled"],
  submitted: ["reviewing", "confirmed", "declined", "cancelled"],
  reviewing: ["confirmed", "declined", "cancelled"],
  // Calendar mode: a held slot is confirmed by the caller, declined or dropped.
  awaiting_confirmation: ["confirmed", "declined", "cancelled"],
  confirmed: ["cancelled"],
  declined: [],
  cancelled: [],
  // A hold nobody confirmed. Terminal: it is history, not a live booking.
  expired: []
};

/**
 * Operator transitions for a calendar-backed booking. Confirming or cancelling
 * one has to go through CalendarService so the external event moves with it,
 * so the dashboard offers only cancellation — it never flips a calendar
 * booking's status directly.
 */
export const CALENDAR_BOOKING_TRANSITIONS: Record<string, AppointmentStatus[]> = {
  awaiting_confirmation: ["cancelled"],
  confirmed: ["cancelled"],
  declined: [],
  cancelled: [],
  expired: []
};

export function allowedBookingTransitionsFor(mode: string, from: string): AppointmentStatus[] {
  if (mode === "calendar") return CALENDAR_BOOKING_TRANSITIONS[from] ?? [];
  return BOOKING_TRANSITIONS[from as AppointmentStatus] ?? [];
}

export const ESCALATION_TRANSITIONS: Record<EscalationStatus, EscalationStatus[]> = {
  requested: ["assigned", "closed"],
  assigned: ["resolved", "closed"],
  resolved: ["closed"],
  closed: []
};

export function canTransitionBooking(from: string, to: string): boolean {
  const allowed = BOOKING_TRANSITIONS[from as AppointmentStatus];
  return Boolean(allowed?.includes(to as AppointmentStatus));
}

export function canTransitionEscalation(from: string, to: string): boolean {
  const allowed = ESCALATION_TRANSITIONS[from as EscalationStatus];
  return Boolean(allowed?.includes(to as EscalationStatus));
}

export function allowedBookingTransitions(from: string): AppointmentStatus[] {
  return BOOKING_TRANSITIONS[from as AppointmentStatus] ?? [];
}

export function allowedEscalationTransitions(from: string): EscalationStatus[] {
  return ESCALATION_TRANSITIONS[from as EscalationStatus] ?? [];
}
