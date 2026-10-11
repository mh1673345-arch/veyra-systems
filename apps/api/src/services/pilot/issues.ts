import {
  FEEDBACK_RATINGS,
  PILOT_ISSUE_CATEGORIES,
  PILOT_ISSUE_STATUSES,
  PILOT_ISSUE_TRANSITIONS,
  type ConversationFeedbackDto,
  type FeedbackRating,
  type PilotIssueCategory,
  type PilotIssueDto,
  type PilotIssueStatus
} from "@veyra/shared";
import { prisma } from "../../db/client.js";
import { HttpError } from "../../middleware/errorHandler.js";

/**
 * Operator feedback and the pilot issue queue.
 *
 * Both are append-only in spirit: reporting an issue or rating a reply records
 * a new opinion about what happened. Neither ever edits the conversation, the
 * reply or the booking it refers to, so the pilot's evidence stays exactly as
 * the caller experienced it.
 *
 * Everything is scoped to one business, and a reference that belongs to
 * another business is treated as if it does not exist.
 */

const MAX_NOTE = 1000;

function note(value: unknown, field = "note"): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(400, `${field} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > MAX_NOTE) throw new HttpError(400, `${field} must be ${MAX_NOTE} characters or fewer.`);
  return trimmed || null;
}

function toIssueDto(issue: {
  id: string;
  businessId: string;
  conversationId: string | null;
  messageId: string | null;
  category: string;
  note: string | null;
  status: string;
  resolutionNote: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  reportedBy?: { name: string | null; email: string } | null;
  resolvedBy?: { name: string | null; email: string } | null;
}): PilotIssueDto {
  return {
    id: issue.id,
    businessId: issue.businessId,
    conversationId: issue.conversationId,
    messageId: issue.messageId,
    category: issue.category as PilotIssueCategory,
    note: issue.note,
    status: issue.status as PilotIssueStatus,
    resolutionNote: issue.resolutionNote,
    reportedBy: issue.reportedBy?.name ?? issue.reportedBy?.email ?? null,
    resolvedBy: issue.resolvedBy?.name ?? issue.resolvedBy?.email ?? null,
    resolvedAt: issue.resolvedAt?.toISOString() ?? null,
    createdAt: issue.createdAt.toISOString(),
    updatedAt: issue.updatedAt.toISOString()
  };
}

const withActors = {
  reportedBy: { select: { name: true, email: true } },
  resolvedBy: { select: { name: true, email: true } }
} as const;

/**
 * Confirms a conversation/message pair really belongs to this business.
 * Cross-tenant references are refused as "not found" rather than 403, so the
 * queue can't be used to discover another business's conversation ids.
 */
async function assertReferences(businessId: string, conversationId?: string | null, messageId?: string | null) {
  if (conversationId) {
    const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, businessId }, select: { id: true } });
    if (!conversation) throw new HttpError(404, "Conversation not found");
  }
  if (messageId) {
    if (!conversationId) throw new HttpError(400, "A message reference needs its conversation.");
    const message = await prisma.message.findFirst({ where: { id: messageId, conversationId }, select: { id: true } });
    if (!message) throw new HttpError(404, "Message not found");
  }
}

export async function reportIssue(params: {
  businessId: string;
  actorUserId: string;
  category: unknown;
  conversationId?: string | null;
  messageId?: string | null;
  note?: unknown;
}): Promise<PilotIssueDto> {
  if (typeof params.category !== "string" || !(PILOT_ISSUE_CATEGORIES as string[]).includes(params.category)) {
    throw new HttpError(400, `category must be one of ${PILOT_ISSUE_CATEGORIES.join(", ")}.`);
  }
  await assertReferences(params.businessId, params.conversationId, params.messageId);

  const issue = await prisma.pilotIssue.create({
    data: {
      businessId: params.businessId,
      conversationId: params.conversationId ?? null,
      messageId: params.messageId ?? null,
      category: params.category,
      note: note(params.note),
      status: "open",
      reportedByUserId: params.actorUserId
    },
    include: withActors
  });
  return toIssueDto(issue);
}

export async function listIssues(params: {
  businessId: string;
  status?: string;
  conversationId?: string;
  limit?: number;
}): Promise<PilotIssueDto[]> {
  const status = params.status && (PILOT_ISSUE_STATUSES as string[]).includes(params.status) ? params.status : undefined;
  const issues = await prisma.pilotIssue.findMany({
    where: {
      businessId: params.businessId,
      ...(status ? { status } : {}),
      ...(params.conversationId ? { conversationId: params.conversationId } : {})
    },
    include: withActors,
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: Math.min(params.limit ?? 100, 500)
  });
  return issues.map(toIssueDto);
}

export async function updateIssueStatus(params: {
  businessId: string;
  issueId: string;
  actorUserId: string;
  status: unknown;
  resolutionNote?: unknown;
  now?: Date;
}): Promise<PilotIssueDto> {
  if (typeof params.status !== "string" || !(PILOT_ISSUE_STATUSES as string[]).includes(params.status)) {
    throw new HttpError(400, `status must be one of ${PILOT_ISSUE_STATUSES.join(", ")}.`);
  }
  const next = params.status as PilotIssueStatus;

  // Scoped lookup: another business's issue simply does not exist here.
  const existing = await prisma.pilotIssue.findFirst({ where: { id: params.issueId, businessId: params.businessId } });
  if (!existing) throw new HttpError(404, "Issue not found");

  const from = existing.status as PilotIssueStatus;
  if (from !== next && !PILOT_ISSUE_TRANSITIONS[from].includes(next)) {
    throw new HttpError(422, `An issue can't go from "${from}" to "${next}".`);
  }

  const now = params.now ?? new Date();
  const resolving = next === "resolved" || next === "dismissed";
  const issue = await prisma.pilotIssue.update({
    where: { id: existing.id },
    data: {
      status: next,
      resolutionNote: params.resolutionNote === undefined ? existing.resolutionNote : note(params.resolutionNote, "resolutionNote"),
      resolvedAt: resolving ? now : null,
      resolvedByUserId: resolving ? params.actorUserId : null
    },
    include: withActors
  });
  return toIssueDto(issue);
}

/* ------------------------------------------------------------------ *
 * Feedback on a reply
 * ------------------------------------------------------------------ */

export async function recordFeedback(params: {
  businessId: string;
  actorUserId: string;
  conversationId: string;
  messageId?: string | null;
  rating: unknown;
  note?: unknown;
}): Promise<ConversationFeedbackDto> {
  if (typeof params.rating !== "string" || !(FEEDBACK_RATINGS as string[]).includes(params.rating)) {
    throw new HttpError(400, `rating must be one of ${FEEDBACK_RATINGS.join(", ")}.`);
  }
  await assertReferences(params.businessId, params.conversationId, params.messageId);

  const feedback = await prisma.conversationFeedback.create({
    data: {
      businessId: params.businessId,
      conversationId: params.conversationId,
      messageId: params.messageId ?? null,
      rating: params.rating,
      note: note(params.note),
      actorUserId: params.actorUserId
    },
    include: { actor: { select: { name: true, email: true } } }
  });

  return {
    id: feedback.id,
    conversationId: feedback.conversationId,
    messageId: feedback.messageId,
    rating: feedback.rating as FeedbackRating,
    note: feedback.note,
    actor: feedback.actor?.name ?? feedback.actor?.email ?? null,
    createdAt: feedback.createdAt.toISOString()
  };
}

export async function listFeedback(businessId: string, conversationId: string): Promise<ConversationFeedbackDto[]> {
  const rows = await prisma.conversationFeedback.findMany({
    where: { businessId, conversationId },
    include: { actor: { select: { name: true, email: true } } },
    orderBy: { createdAt: "desc" }
  });
  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversationId,
    messageId: row.messageId,
    rating: row.rating as FeedbackRating,
    note: row.note,
    actor: row.actor?.name ?? row.actor?.email ?? null,
    createdAt: row.createdAt.toISOString()
  }));
}
