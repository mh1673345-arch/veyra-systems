import type { PilotExportKind, PilotRange } from "@veyra/shared";
import { PILOT_EXPORT_KINDS } from "@veyra/shared";
import { prisma } from "../../db/client.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { knowledgeGaps } from "./knowledgeGaps.js";
import { listIssues } from "./issues.js";
import { pilotMetrics } from "./metrics.js";
import { deriveOutcome } from "./outcomes.js";
import { rangeWindow } from "./range.js";

/**
 * CSV export of pilot data.
 *
 * Scoped to one business and deliberately narrow: counts, outcomes, timestamps
 * and references. No credentials, tokens, provider identifiers or prompts, and
 * no message text — a conversation row says what happened and gives its id, so
 * anyone who needs the words opens the conversation in the Console where
 * access is checked again.
 */

export function isExportKind(value: string): value is PilotExportKind {
  return (PILOT_EXPORT_KINDS as string[]).includes(value);
}

/** RFC 4180 quoting, plus a guard against spreadsheet formula injection. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(headers: string[], rows: unknown[][]): string {
  return [headers.join(","), ...rows.map((row) => row.map(cell).join(","))].join("\r\n") + "\r\n";
}

export async function pilotExport(businessId: string, kind: PilotExportKind, range: PilotRange): Promise<string> {
  const window = rangeWindow(range);

  switch (kind) {
    case "conversations": {
      const conversations = await prisma.conversation.findMany({
        where: { businessId, createdAt: window },
        select: {
          id: true,
          status: true,
          createdAt: true,
          outcomeOverride: true,
          outcomeOverrideNote: true,
          outcomeOverrideAt: true,
          messages: {
            orderBy: { createdAt: "asc" },
            select: { sender: true, intent: true, action: true, actionStatus: true, responder: true, fallbackReason: true, createdAt: true }
          },
          appointments: { select: { status: true, mode: true } },
          escalations: { select: { status: true } }
        },
        orderBy: { createdAt: "asc" }
      });
      const feedback = await prisma.conversationFeedback.findMany({
        where: { businessId, conversationId: { in: conversations.map((c) => c.id) } },
        select: { conversationId: true, rating: true }
      });
      const negative = new Set(
        feedback.filter((f) => f.rating === "incorrect" || f.rating === "needed_human").map((f) => f.conversationId)
      );

      return csv(
        ["conversation_id", "started_at", "status", "caller_messages", "replies", "fallback_replies", "outcome", "outcome_source", "outcome_evidence"],
        conversations.map((conversation) => {
          const outcome = deriveOutcome({
            conversation,
            messages: conversation.messages,
            appointments: conversation.appointments,
            escalations: conversation.escalations,
            hasNegativeFeedback: negative.has(conversation.id)
          });
          const replies = conversation.messages.filter((m) => m.sender === "receptionist");
          return [
            conversation.id,
            conversation.createdAt.toISOString(),
            conversation.status,
            conversation.messages.filter((m) => m.sender === "caller").length,
            replies.length,
            replies.filter((m) => m.responder === "rule_based" && m.fallbackReason && m.fallbackReason !== "no_api_key").length,
            outcome.outcome,
            outcome.source,
            outcome.evidence
          ];
        })
      );
    }

    case "bookings": {
      const bookings = await prisma.appointment.findMany({
        where: { businessId, createdAt: window },
        select: {
          id: true,
          conversationId: true,
          mode: true,
          status: true,
          serviceName: true,
          requestedTime: true,
          startTime: true,
          timezone: true,
          createdAt: true,
          confirmedAt: true,
          cancelledAt: true,
          externalEventStatus: true
        },
        orderBy: { createdAt: "asc" }
      });
      return csv(
        ["booking_id", "conversation_id", "mode", "status", "service", "requested_time", "start_time", "timezone", "created_at", "confirmed_at", "cancelled_at", "calendar_event_status"],
        bookings.map((booking) => [
          booking.id,
          booking.conversationId,
          booking.mode,
          booking.status,
          booking.serviceName,
          booking.requestedTime,
          booking.startTime?.toISOString() ?? "",
          booking.timezone ?? "",
          booking.createdAt.toISOString(),
          booking.confirmedAt?.toISOString() ?? "",
          booking.cancelledAt?.toISOString() ?? "",
          booking.externalEventStatus ?? ""
        ])
      );
    }

    case "escalations": {
      const escalations = await prisma.escalation.findMany({
        where: { businessId, createdAt: window },
        select: { id: true, conversationId: true, status: true, reason: true, createdAt: true, assignedAt: true, resolvedAt: true },
        orderBy: { createdAt: "asc" }
      });
      return csv(
        ["escalation_id", "conversation_id", "status", "reason", "created_at", "assigned_at", "resolved_at", "resolution_seconds"],
        escalations.map((escalation) => [
          escalation.id,
          escalation.conversationId,
          escalation.status,
          escalation.reason,
          escalation.createdAt.toISOString(),
          escalation.assignedAt?.toISOString() ?? "",
          escalation.resolvedAt?.toISOString() ?? "",
          escalation.resolvedAt ? Math.round((escalation.resolvedAt.getTime() - escalation.createdAt.getTime()) / 1000) : ""
        ])
      );
    }

    case "issues": {
      const issues = await listIssues({ businessId, limit: 500 });
      const inRange = issues.filter((issue) => {
        const created = new Date(issue.createdAt);
        return created >= window.gte && created < window.lt;
      });
      return csv(
        ["issue_id", "created_at", "category", "status", "conversation_id", "message_id", "reported_by", "resolved_by", "resolved_at", "note", "resolution_note"],
        inRange.map((issue) => [
          issue.id,
          issue.createdAt,
          issue.category,
          issue.status,
          issue.conversationId ?? "",
          issue.messageId ?? "",
          issue.reportedBy ?? "",
          issue.resolvedBy ?? "",
          issue.resolvedAt ?? "",
          issue.note ?? "",
          issue.resolutionNote ?? ""
        ])
      );
    }

    case "knowledge_gaps": {
      const gaps = await knowledgeGaps(businessId, range, 200);
      return csv(
        ["kind", "topic", "topic_label", "conversations", "last_seen_at", "suggestion"],
        gaps.map((gap) => [gap.kind, gap.topic, gap.topicLabel, gap.conversations, gap.lastSeenAt, gap.suggestion])
      );
    }

    case "metrics": {
      const metrics = await pilotMetrics(businessId, range);
      const rows = [...metrics.activity, ...metrics.outcomes, ...metrics.derived].map((item) => [
        item.key,
        item.label,
        // "Not available" is exported as such: an empty cell would read as zero
        // in a spreadsheet, which is exactly the claim we must not make.
        item.value === null ? "not_available" : item.value,
        item.unit ?? "count",
        item.definition,
        item.unavailableReason ?? ""
      ]);
      return csv(["metric", "label", "value", "unit", "definition", "unavailable_reason"], rows);
    }

    default:
      throw new HttpError(400, "Unknown export.");
  }
}

export function exportFilename(businessName: string, kind: PilotExportKind, range: PilotRange): string {
  const slug = businessName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "business";
  return `veyra-${slug}-${kind}-${range.from.slice(0, 10)}-to-${range.to.slice(0, 10)}.csv`;
}
