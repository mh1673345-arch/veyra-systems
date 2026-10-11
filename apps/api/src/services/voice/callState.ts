import type { CallStatus } from "@prisma/client";

/**
 * The call state machine.
 *
 * A phone call is the one part of Veyra where events arrive out of order,
 * twice, or late from a carrier. Every status change goes through here so an
 * impossible move — a completed call going back to active, say — is refused
 * rather than quietly corrupting the record a pilot review depends on.
 */

export const CALL_TRANSITIONS: Record<CallStatus, CallStatus[]> = {
  initiated: ["ringing", "active", "failed", "missed", "completed"],
  ringing: ["active", "missed", "failed", "completed"],
  active: ["transferring", "completed", "failed"],
  transferring: ["completed", "failed"],
  // Terminal.
  completed: [],
  failed: [],
  missed: []
};

export const TERMINAL_CALL_STATUSES: CallStatus[] = ["completed", "failed", "missed"];

export function isTerminalCallStatus(status: CallStatus): boolean {
  return TERMINAL_CALL_STATUSES.includes(status);
}

export function canTransitionCall(from: CallStatus, to: CallStatus): boolean {
  return CALL_TRANSITIONS[from].includes(to);
}

export class CallTransitionError extends Error {
  constructor(
    readonly from: CallStatus,
    readonly to: CallStatus
  ) {
    super(`A call can't go from "${from}" to "${to}".`);
    this.name = "CallTransitionError";
  }
}

export function assertCallTransition(from: CallStatus, to: CallStatus): void {
  if (from === to) return;
  if (!canTransitionCall(from, to)) throw new CallTransitionError(from, to);
}
