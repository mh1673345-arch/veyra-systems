import {
  PILOT_ALERT_DEFAULTS,
  PILOT_ISSUE_CATEGORY_LABELS,
  type PilotIssueCategory,
  type PilotRange,
  type PilotReport
} from "@veyra/shared";
import { prisma } from "../../db/client.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { knowledgeGaps } from "./knowledgeGaps.js";
import { listIssues } from "./issues.js";
import { outcomeBreakdown, pilotMetrics, pilotSeries, topIntents } from "./metrics.js";
import { rangeWindow } from "./range.js";

/**
 * The pilot report.
 *
 * Every recommendation is generated from a count this report already shows,
 * and carries the evidence that produced it. There is no advice here that
 * isn't arithmetic on the business's own records — no strategy, no projected
 * savings, no "customers love X". If the data doesn't support a sentence, the
 * sentence isn't written.
 */

export async function buildPilotReport(businessId: string, range: PilotRange): Promise<PilotReport> {
  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { id: true, name: true } });
  if (!business) throw new HttpError(404, "Business not found");

  const [metrics, series, intents, gaps, issues] = await Promise.all([
    pilotMetrics(businessId, range),
    pilotSeries(businessId, range),
    topIntents(businessId, range),
    knowledgeGaps(businessId, range),
    listIssues({ businessId, limit: 500 })
  ]);

  const window = rangeWindow(range);
  const inRange = issues.filter((issue) => {
    const created = new Date(issue.createdAt);
    return created >= window.gte && created < window.lt;
  });
  const unresolved = issues.filter((issue) => issue.status === "open" || issue.status === "reviewing");

  const categories = new Map<PilotIssueCategory, { open: number; total: number }>();
  for (const issue of inRange) {
    const entry = categories.get(issue.category) ?? { open: 0, total: 0 };
    entry.total += 1;
    if (issue.status === "open" || issue.status === "reviewing") entry.open += 1;
    categories.set(issue.category, entry);
  }

  const raw = metrics.raw;
  const recommendations: { message: string; evidence: string }[] = [];

  // Knowledge gaps: the clearest, most actionable signal there is.
  for (const gap of gaps.slice(0, 5)) {
    if (gap.conversations < 2) continue;
    recommendations.push({
      message: gap.suggestion,
      evidence: `${gap.topicLabel} came up in ${gap.conversations} separate conversations with nothing on file.`
    });
  }

  // Fallback rate, only when there are enough replies to mean anything.
  if (raw.receptionistReplies >= PILOT_ALERT_DEFAULTS.minimumSampleForRates) {
    const rate = raw.fallbackReplies / raw.receptionistReplies;
    if (rate > PILOT_ALERT_DEFAULTS.fallbackRateWarning) {
      recommendations.push({
        message: "Check the AI provider configuration: a large share of replies came from the deterministic responder.",
        evidence: `${raw.fallbackReplies} of ${raw.receptionistReplies} replies fell back.`
      });
    }
  }

  if (raw.escalations > 0 && raw.resolvedEscalations < raw.escalations) {
    const open = raw.escalations - raw.resolvedEscalations;
    recommendations.push({
      message: "Work through the open handoffs — each one is a caller still waiting for a person.",
      evidence: `${open} of ${raw.escalations} handoffs created in this period are unresolved.`
    });
  }

  if (unresolved.length > 0) {
    recommendations.push({
      message: "Review the reported issues so the pilot's findings are based on triaged evidence.",
      evidence: `${unresolved.length} issue${unresolved.length === 1 ? " is" : "s are"} still open or under review.`
    });
  }

  if (raw.outcomes.out_of_scope > 0 && raw.conversationsWithCallerMessage > 0) {
    const share = raw.outcomes.out_of_scope / raw.conversationsWithCallerMessage;
    if (share >= 0.2) {
      recommendations.push({
        message: "Add more business information: a fifth or more of conversations ended with nothing on file to answer from.",
        evidence: `${raw.outcomes.out_of_scope} of ${raw.conversationsWithCallerMessage} conversations ended out of scope.`
      });
    }
  }

  if (raw.conversationsWithCallerMessage === 0) {
    recommendations.push({
      message: "No callers reached Reception in this period, so nothing can be concluded yet.",
      evidence: "Zero conversations had a caller message in the selected range."
    });
  }

  return {
    businessId: business.id,
    businessName: business.name,
    generatedAt: new Date().toISOString(),
    range,
    metrics: { range: metrics.range, activity: metrics.activity, outcomes: metrics.outcomes, derived: metrics.derived },
    series,
    topIntents: intents,
    knowledgeGaps: gaps,
    issuesByCategory: [...categories.entries()]
      .map(([category, counts]) => ({ category, label: PILOT_ISSUE_CATEGORY_LABELS[category], ...counts }))
      .sort((a, b) => b.total - a.total),
    unresolvedIssues: unresolved.slice(0, 50),
    outcomes: outcomeBreakdown(raw),
    recommendations
  };
}
