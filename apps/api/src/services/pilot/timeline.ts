import type { PilotRange, PilotTimelineEntry } from "@veyra/shared";
import { PILOT_ISSUE_CATEGORY_LABELS, type PilotIssueCategory } from "@veyra/shared";
import { prisma } from "../../db/client.js";
import { rangeWindow } from "./range.js";

/**
 * A pilot's important moments, assembled from the audit trails Veyra already
 * keeps — ConfigAuditEvent, StatusEvent, SubscriptionEvent and the pilot issue
 * queue. Nothing is duplicated into a new event table just to draw this list,
 * so the timeline cannot disagree with the records it summarises.
 *
 * It carries references, not content: a line says a booking was confirmed, and
 * the operator opens the booking to see the details.
 */

const CONFIG_SUMMARIES: Record<string, string> = {
  "reception_status:activated": "Reception activated",
  "reception_status:paused": "Reception paused",
  "pilot:preparing": "Pilot moved to preparing",
  "pilot:active": "Pilot activated",
  "pilot:paused": "Pilot paused",
  "pilot:completed": "Pilot completed",
  "pilot:none": "Pilot cleared",
  "pilot_targets:updated": "Pilot targets updated",
  "pilot_safety:updated": "Pilot safety controls changed"
};

function actorName(user: { name: string | null; email: string } | null | undefined): string | null {
  return user?.name ?? user?.email ?? null;
}

export async function pilotTimeline(businessId: string, range: PilotRange, limit = 60): Promise<PilotTimelineEntry[]> {
  const window = rangeWindow(range);
  const [config, statuses, subscription, issues] = await Promise.all([
    prisma.configAuditEvent.findMany({ where: { businessId, createdAt: window }, orderBy: { createdAt: "desc" }, take: limit }),
    prisma.statusEvent.findMany({
      where: { businessId, createdAt: window },
      include: { actorUser: { select: { name: true, email: true } } },
      orderBy: { createdAt: "desc" },
      take: limit
    }),
    prisma.subscriptionEvent.findMany({ where: { businessId, createdAt: window }, orderBy: { createdAt: "desc" }, take: limit }),
    prisma.pilotIssue.findMany({
      where: { businessId, OR: [{ createdAt: window }, { resolvedAt: window }] },
      include: { reportedBy: { select: { name: true, email: true } }, resolvedBy: { select: { name: true, email: true } } },
      orderBy: { createdAt: "desc" },
      take: limit
    })
  ]);

  const actorIds = [...new Set(config.map((row) => row.actorUserId).filter((id): id is string => Boolean(id)))];
  const actors = actorIds.length
    ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true } })
    : [];
  const actorById = new Map(actors.map((user) => [user.id, user]));

  const entries: PilotTimelineEntry[] = [];

  for (const row of config) {
    const summary = CONFIG_SUMMARIES[`${row.entityType}:${row.changeType}`];
    // Only the moments worth a timeline line; ordinary config edits stay in
    // the configuration audit rather than crowding this out.
    if (!summary) continue;
    entries.push({
      at: row.createdAt.toISOString(),
      kind: row.entityType,
      summary,
      actorType: "operator",
      actor: actorName(actorById.get(row.actorUserId ?? "") ?? null)
    });
  }

  for (const row of statuses) {
    const noun = row.entityType === "booking" ? "Booking" : row.entityType === "escalation" ? "Handoff" : row.entityType;
    entries.push({
      at: row.createdAt.toISOString(),
      kind: `${row.entityType}_status`,
      summary: `${noun} ${row.fromStatus} → ${row.toStatus}${row.note ? ` (${row.note})` : ""}`,
      actorType: row.actorType,
      actor: actorName(row.actorUser),
      reference:
        row.entityType === "booking"
          ? { type: "booking", id: row.entityId }
          : row.entityType === "escalation"
            ? { type: "escalation", id: row.entityId }
            : null
    });
  }

  for (const row of subscription) {
    entries.push({
      at: row.createdAt.toISOString(),
      kind: "subscription",
      summary: row.reason ?? `Plan ${row.previousPlan ?? "—"} → ${row.newPlan}`,
      actorType: row.actorType,
      actor: null
    });
  }

  for (const row of issues) {
    const label = PILOT_ISSUE_CATEGORY_LABELS[row.category as PilotIssueCategory] ?? row.category;
    if (row.createdAt >= window.gte && row.createdAt < window.lt) {
      entries.push({
        at: row.createdAt.toISOString(),
        kind: "issue_reported",
        summary: `Issue reported: ${label}`,
        actorType: "operator",
        actor: actorName(row.reportedBy),
        reference: { type: "issue", id: row.id }
      });
    }
    if (row.resolvedAt && row.resolvedAt >= window.gte && row.resolvedAt < window.lt) {
      entries.push({
        at: row.resolvedAt.toISOString(),
        kind: "issue_closed",
        summary: `Issue ${row.status}: ${label}`,
        actorType: "operator",
        actor: actorName(row.resolvedBy),
        reference: { type: "issue", id: row.id }
      });
    }
  }

  return entries.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
