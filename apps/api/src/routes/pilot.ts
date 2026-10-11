import { Router } from "express";
import type { PilotOverview, PilotReport, PilotStatus } from "@veyra/shared";
import { PILOT_STATUSES } from "@veyra/shared";
import { prisma } from "../db/client.js";
import { HttpError } from "../middleware/errorHandler.js";
import { requireAuth, requireBusinessPermission } from "../middleware/auth.js";
import { requireCsrfToken } from "../middleware/csrf.js";
import { roleHasPermission } from "../services/auth/permissions.js";
import { accessFor } from "../services/access/accessService.js";
import { releaseExpiredHolds } from "../services/calendar/holds.js";
import { pilotAlerts, pilotHealth } from "../services/pilot/health.js";
import { exportFilename, isExportKind, pilotExport } from "../services/pilot/export.js";
import { knowledgeGaps } from "../services/pilot/knowledgeGaps.js";
import { listFeedback, listIssues, recordFeedback, reportIssue, updateIssueStatus } from "../services/pilot/issues.js";
import { outcomeBreakdown, pilotMetrics, pilotSeries, topIntents } from "../services/pilot/metrics.js";
import { deriveOutcome, isConversationOutcome } from "../services/pilot/outcomes.js";
import { resolveRange } from "../services/pilot/range.js";
import { evaluatePilotReadiness } from "../services/pilot/readiness.js";
import { buildPilotReport } from "../services/pilot/report.js";
import {
  pilotStateOf,
  pilotTargetsOf,
  safetyLockedByPlan,
  safetyOf,
  setPilotStatus,
  updatePilotSafety,
  updatePilotTargets
} from "../services/pilot/state.js";
import { pilotTimeline } from "../services/pilot/timeline.js";

/**
 * Pilot operations.
 *
 * Every route is scoped to one business and gated on a pilot permission, so a
 * member of another workspace gets 404 rather than a hint that the business
 * exists. Reads are open to all four roles; anything that changes what Veyra
 * does to real callers (status, targets, safety controls) needs pilot:manage.
 *
 * These routes report what happened. None of them claims it was good.
 */

export const pilotRouter = Router();

const read = [requireAuth, requireBusinessPermission("pilot:read")] as const;
const manage = [requireAuth, requireCsrfToken, requireBusinessPermission("pilot:manage")] as const;
const report = [requireAuth, requireCsrfToken, requireBusinessPermission("pilot:report")] as const;
const triage = [requireAuth, requireCsrfToken, requireBusinessPermission("pilot:triage")] as const;

async function businessOr404(businessId: string) {
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) throw new HttpError(404, "Business not found");
  return business;
}

/** Every analytics route reads its window the same way. */
async function rangeFor(businessId: string, query: Record<string, unknown>) {
  const business = await businessOr404(businessId);
  return resolveRange({
    key: typeof query.range === "string" ? query.range : undefined,
    from: typeof query.from === "string" ? query.from : undefined,
    to: typeof query.to === "string" ? query.to : undefined,
    timezone: business.timezone,
    pilotStartedAt: business.pilotStartedAt,
    pilotEndedAt: business.pilotEndedAt
  });
}

/* --------------------------------- overview -------------------------------- */

pilotRouter.get("/ops/businesses/:businessId/pilot", ...read, async (req, res, next) => {
  try {
    const businessId = req.params.businessId;
    const business = await businessOr404(businessId);
    // Dead holds are released before anything is counted, so the dashboard
    // never shows a slot as pending that has already lapsed.
    await releaseExpiredHolds({ businessId });

    const range = await rangeFor(businessId, req.query as Record<string, unknown>);
    const role = req.membership!.role;

    const [readiness, metrics, health, gaps, access, targets, locked, openIssues] = await Promise.all([
      evaluatePilotReadiness(businessId),
      pilotMetrics(businessId, range),
      pilotHealth(businessId),
      knowledgeGaps(businessId, range),
      accessFor(businessId),
      pilotTargetsOf(businessId),
      safetyLockedByPlan(businessId),
      prisma.pilotIssue.count({ where: { businessId, status: { in: ["open", "reviewing"] } } })
    ]);
    const alerts = await pilotAlerts({ businessId, range, raw: metrics.raw, gaps, health });

    const body: PilotOverview = {
      businessId,
      businessName: business.name,
      timezone: business.timezone,
      pilot: pilotStateOf(business),
      targets,
      safety: safetyOf(business),
      safetyLockedByPlan: locked,
      plan: access.plan,
      subscriptionStatus: access.status,
      receptionStatus: business.receptionStatus,
      readiness,
      health,
      alerts,
      metrics: { range: metrics.range, activity: metrics.activity, outcomes: metrics.outcomes, derived: metrics.derived },
      openIssues,
      canManage: roleHasPermission(role, "pilot:manage"),
      canReport: roleHasPermission(role, "pilot:report"),
      canTriage: roleHasPermission(role, "pilot:triage")
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

pilotRouter.get("/ops/businesses/:businessId/pilot/readiness", ...read, async (req, res, next) => {
  try {
    res.json(await evaluatePilotReadiness(req.params.businessId));
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------- charts --------------------------------- */

pilotRouter.get("/ops/businesses/:businessId/pilot/series", ...read, async (req, res, next) => {
  try {
    const businessId = req.params.businessId;
    const range = await rangeFor(businessId, req.query as Record<string, unknown>);
    const [series, intents, metrics] = await Promise.all([
      pilotSeries(businessId, range),
      topIntents(businessId, range),
      pilotMetrics(businessId, range)
    ]);
    res.json({ range, series, topIntents: intents, outcomes: outcomeBreakdown(metrics.raw) });
  } catch (err) {
    next(err);
  }
});

pilotRouter.get("/ops/businesses/:businessId/pilot/knowledge-gaps", ...read, async (req, res, next) => {
  try {
    const businessId = req.params.businessId;
    const range = await rangeFor(businessId, req.query as Record<string, unknown>);
    res.json({ range, gaps: await knowledgeGaps(businessId, range) });
  } catch (err) {
    next(err);
  }
});

pilotRouter.get("/ops/businesses/:businessId/pilot/timeline", ...read, async (req, res, next) => {
  try {
    const businessId = req.params.businessId;
    const range = await rangeFor(businessId, req.query as Record<string, unknown>);
    res.json({ range, entries: await pilotTimeline(businessId, range) });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------- report --------------------------------- */

pilotRouter.get("/ops/businesses/:businessId/pilot/report", ...read, async (req, res, next) => {
  try {
    const businessId = req.params.businessId;
    const range = await rangeFor(businessId, req.query as Record<string, unknown>);
    const body: PilotReport = await buildPilotReport(businessId, range);
    res.json(body);
  } catch (err) {
    next(err);
  }
});

pilotRouter.get("/ops/businesses/:businessId/pilot/export/:kind", ...read, async (req, res, next) => {
  try {
    const businessId = req.params.businessId;
    const business = await businessOr404(businessId);
    if (!isExportKind(req.params.kind)) throw new HttpError(404, "Unknown export");
    const range = await rangeFor(businessId, req.query as Record<string, unknown>);

    const csv = await pilotExport(businessId, req.params.kind, range);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${exportFilename(business.name, req.params.kind, range)}"`);
    // An export is a file to save, never something a browser should render.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------- pilot state ------------------------------- */

pilotRouter.post("/ops/businesses/:businessId/pilot/status", ...manage, async (req, res, next) => {
  try {
    const status = req.body?.status;
    if (typeof status !== "string" || !(PILOT_STATUSES as string[]).includes(status)) {
      throw new HttpError(400, `status must be one of ${PILOT_STATUSES.join(", ")}.`);
    }
    const state = await setPilotStatus({
      businessId: req.params.businessId,
      status: status as PilotStatus,
      actorUserId: req.auth!.user.id,
      label: typeof req.body?.label === "string" ? req.body.label.trim().slice(0, 80) : undefined,
      notes: typeof req.body?.notes === "string" ? req.body.notes.trim().slice(0, 1000) : undefined
    });
    res.json(state);
  } catch (err) {
    next(err);
  }
});

pilotRouter.put("/ops/businesses/:businessId/pilot/targets", ...manage, async (req, res, next) => {
  try {
    res.json(
      await updatePilotTargets({
        businessId: req.params.businessId,
        actorUserId: req.auth!.user.id,
        targets: req.body ?? {}
      })
    );
  } catch (err) {
    next(err);
  }
});

pilotRouter.put("/ops/businesses/:businessId/pilot/safety", ...manage, async (req, res, next) => {
  try {
    res.json(
      await updatePilotSafety({
        businessId: req.params.businessId,
        actorUserId: req.auth!.user.id,
        controls: req.body ?? {}
      })
    );
  } catch (err) {
    next(err);
  }
});

/* --------------------------------- issues ---------------------------------- */

pilotRouter.get("/ops/businesses/:businessId/pilot/issues", ...read, async (req, res, next) => {
  try {
    res.json(
      await listIssues({
        businessId: req.params.businessId,
        status: typeof req.query.status === "string" ? req.query.status : undefined,
        conversationId: typeof req.query.conversationId === "string" ? req.query.conversationId : undefined
      })
    );
  } catch (err) {
    next(err);
  }
});

pilotRouter.post("/ops/businesses/:businessId/pilot/issues", ...report, async (req, res, next) => {
  try {
    const issue = await reportIssue({
      businessId: req.params.businessId,
      actorUserId: req.auth!.user.id,
      category: req.body?.category,
      conversationId: req.body?.conversationId ?? null,
      messageId: req.body?.messageId ?? null,
      note: req.body?.note
    });
    res.status(201).json(issue);
  } catch (err) {
    next(err);
  }
});

pilotRouter.patch("/ops/businesses/:businessId/pilot/issues/:issueId", ...triage, async (req, res, next) => {
  try {
    res.json(
      await updateIssueStatus({
        businessId: req.params.businessId,
        issueId: req.params.issueId,
        actorUserId: req.auth!.user.id,
        status: req.body?.status,
        resolutionNote: req.body?.resolutionNote
      })
    );
  } catch (err) {
    next(err);
  }
});

/* -------------------------------- feedback --------------------------------- */

pilotRouter.get("/ops/businesses/:businessId/conversations/:conversationId/feedback", ...read, async (req, res, next) => {
  try {
    res.json(await listFeedback(req.params.businessId, req.params.conversationId));
  } catch (err) {
    next(err);
  }
});

pilotRouter.post("/ops/businesses/:businessId/conversations/:conversationId/feedback", ...report, async (req, res, next) => {
  try {
    const feedback = await recordFeedback({
      businessId: req.params.businessId,
      actorUserId: req.auth!.user.id,
      conversationId: req.params.conversationId,
      messageId: req.body?.messageId ?? null,
      rating: req.body?.rating,
      note: req.body?.note
    });
    res.status(201).json(feedback);
  } catch (err) {
    next(err);
  }
});

/* ------------------------- conversation outcome ---------------------------- */

pilotRouter.get("/ops/businesses/:businessId/conversations/:conversationId/outcome", ...read, async (req, res, next) => {
  try {
    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.conversationId, businessId: req.params.businessId },
      include: {
        messages: { orderBy: { createdAt: "asc" } },
        appointments: { select: { status: true, mode: true } },
        escalations: { select: { status: true } },
        outcomeOverrideUser: { select: { name: true, email: true } }
      }
    });
    if (!conversation) throw new HttpError(404, "Conversation not found");

    const feedback = await prisma.conversationFeedback.findMany({
      where: { conversationId: conversation.id },
      select: { rating: true }
    });

    res.json(
      deriveOutcome({
        conversation,
        messages: conversation.messages,
        appointments: conversation.appointments,
        escalations: conversation.escalations,
        hasNegativeFeedback: feedback.some((row) => row.rating === "incorrect" || row.rating === "needed_human"),
        overriddenBy: conversation.outcomeOverrideUser?.name ?? conversation.outcomeOverrideUser?.email ?? null
      })
    );
  } catch (err) {
    next(err);
  }
});

/** An operator correcting what Veyra concluded. The conversation itself is never edited. */
pilotRouter.put("/ops/businesses/:businessId/conversations/:conversationId/outcome", ...report, async (req, res, next) => {
  try {
    const outcome = req.body?.outcome;
    const clearing = outcome === null || outcome === "";
    if (!clearing && (typeof outcome !== "string" || !isConversationOutcome(outcome))) {
      throw new HttpError(400, "outcome must be a known conversation outcome, or null to go back to the derived one.");
    }
    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.conversationId, businessId: req.params.businessId },
      select: { id: true }
    });
    if (!conversation) throw new HttpError(404, "Conversation not found");

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        outcomeOverride: clearing ? null : outcome,
        outcomeOverrideNote: clearing ? null : typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 1000) : null,
        outcomeOverrideAt: clearing ? null : new Date(),
        outcomeOverrideUserId: clearing ? null : req.auth!.user.id
      }
    });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
