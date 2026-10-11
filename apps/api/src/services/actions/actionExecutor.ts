import type { ActionResult, AssistantAction, BusinessCapabilities } from "@veyra/shared";
import { prisma } from "../../db/client.js";
import { executeCalendarAction, isCalendarAction } from "./calendarActions.js";
import { emitDomainEvent } from "../notifications/events.js";
import { scheduleProcessing } from "../notifications/processor.js";

/**
 * The boundary between "what the AI decided should happen" and "what this
 * application is actually allowed and able to do".
 *
 * Only the structured `action` field reaches this layer — assistant prose never
 * triggers a side effect. Every action is re-validated here against the
 * business's own capabilities, regardless of what the model asked for.
 */

export interface ExecuteActionParams {
  action: AssistantAction | string;
  conversationId: string;
  businessId: string;
  capabilities: BusinessCapabilities;
  /** Caller text, recorded as the escalation reason. */
  callerText: string;
}

const KNOWN_ACTIONS: AssistantAction[] = [
  "none",
  "show_booking_form",
  "escalate_to_human",
  "check_calendar_availability",
  "confirm_calendar_booking",
  "cancel_calendar_booking",
  "reschedule_calendar_booking"
];

function isKnownAction(action: string): action is AssistantAction {
  return (KNOWN_ACTIONS as string[]).includes(action);
}

export async function executeAssistantAction(params: ExecuteActionParams): Promise<ActionResult> {
  const { action, conversationId, businessId, capabilities, callerText } = params;

  if (!isKnownAction(action)) {
    // A malformed or unrecognised action is never executed, and never silently
    // treated as success.
    return {
      action: "none",
      status: "failed",
      message: `Unrecognised action "${action}" was not executed.`
    };
  }

  // Calendar work is re-validated against capability *and* a healthy
  // connection inside this module, and every provider call happens there.
  if (isCalendarAction(action)) {
    return executeCalendarAction({
      action,
      conversationId,
      businessId,
      capabilities,
      callerText
    });
  }

  switch (action) {
    case "none":
      return { action, status: "not_required" };

    case "show_booking_form": {
      if (!capabilities.booking_requests) {
        return {
          action,
          status: "unsupported",
          message: "This business is not configured to take booking requests."
        };
      }
      // Surfacing the form is all that happens here; the request itself is only
      // created when the caller submits it.
      return {
        action,
        status: "ready",
        metadata: { calendarBooking: String(capabilities.calendar_booking) }
      };
    }

    case "escalate_to_human": {
      if (!capabilities.human_escalation) {
        return {
          action,
          status: "unsupported",
          message: "This business is not configured for human escalation."
        };
      }

      try {
        const escalation = await prisma.escalation.create({
          data: {
            conversationId,
            businessId,
            reason: callerText.slice(0, 500),
            status: "requested"
          }
        });
        await emitDomainEvent({
          businessId,
          type: "escalation.created",
          entityType: "escalation",
          entityId: escalation.id,
          payload: { reason: escalation.reason }
        });
        scheduleProcessing();

        // Recorded, but a human has not responded — that stays pending.
        return {
          action,
          status: "pending",
          metadata: { escalationId: escalation.id, escalationStatus: escalation.status }
        };
      } catch (err) {
        console.error("Failed to record escalation", err);
        return {
          action,
          status: "failed",
          message: "Escalation could not be recorded."
        };
      }
    }

    default:
      return { action: "none", status: "failed" };
  }
}
