import type { HealthItem, PilotAlert, PilotRange } from "@veyra/shared";
import { PILOT_ALERT_DEFAULTS } from "@veyra/shared";
import { prisma } from "../../db/client.js";
import { providerHealthSnapshot } from "../ai/telemetry.js";
import { calendarStatus } from "../calendar/service.js";
import { billingProvider } from "../billing/registry.js";
import { createEmailProvider } from "../notifications/providers.js";
import type { RawCounts } from "./metrics.js";
import type { KnowledgeGapRow } from "@veyra/shared";
import { rangeWindow } from "./range.js";

/**
 * Operational health, as an operator needs to see it during a pilot.
 *
 * Degraded optional integrations are reported, never enforced: Reception keeps
 * answering callers when the AI provider, the calendar or email are down, and
 * this panel exists so a human knows about it — not so the product switches
 * itself off. No secret, key or endpoint appears here.
 */
export async function pilotHealth(businessId: string): Promise<HealthItem[]> {
  const [calendar, failedNotifications] = await Promise.all([
    calendarStatus(businessId),
    prisma.notification.count({ where: { businessId, status: "failed" } })
  ]);
  const provider = providerHealthSnapshot();
  const items: HealthItem[] = [];

  items.push(
    !process.env.ANTHROPIC_API_KEY
      ? {
          key: "responder",
          label: "Reception responder",
          level: "not_configured",
          detail: "No AI provider configured. Reception answers deterministically from the business's own information."
        }
      : provider.degraded
        ? { key: "responder", label: "Reception responder", level: "degraded", detail: "The provider is failing; replies are falling back to the deterministic responder." }
        : { key: "responder", label: "Reception responder", level: "ok", detail: "Answering normally." }
  );

  items.push(
    !calendar.entitled
      ? { key: "calendar", label: "Calendar", level: "not_configured", detail: "Live calendar booking isn't included in this plan." }
      : calendar.live
        ? { key: "calendar", label: "Calendar", level: "ok", detail: "Connected and live." }
        : calendar.connection?.status === "needs_reauth"
          ? { key: "calendar", label: "Calendar", level: "degraded", detail: "The connection needs to be re-authorised." }
          : calendar.connection
            ? { key: "calendar", label: "Calendar", level: "degraded", detail: "Connected, but not usable yet — no calendar selected, or booking is switched off." }
            : { key: "calendar", label: "Calendar", level: "not_configured", detail: "No calendar connected." }
  );

  items.push(
    failedNotifications === 0
      ? { key: "notifications", label: "Notifications", level: "ok", detail: "No failed deliveries." }
      : {
          key: "notifications",
          label: "Notifications",
          level: failedNotifications >= PILOT_ALERT_DEFAULTS.notificationFailureWarning ? "degraded" : "ok",
          detail: `${failedNotifications} notification${failedNotifications === 1 ? "" : "s"} failed to deliver.`
        }
  );

  const billing = billingProvider();
  items.push({
    key: "billing",
    label: "Billing",
    level: billing ? "ok" : "not_configured",
    detail: billing
      ? billing.name === "fake"
        ? "Development billing provider — no real payments are taken."
        : "Payment provider configured."
      : "No payment provider configured; plans can't be bought in the Console."
  });

  const email = createEmailProvider().name;
  items.push({
    key: "email",
    label: "Email",
    level: email === "unconfigured" ? "not_configured" : email === "console" ? "degraded" : "ok",
    detail:
      email === "console"
        ? "Development email: messages are written to the server log, not sent."
        : email === "unconfigured"
          ? "No email provider configured; email notifications are recorded as failed rather than sent."
          : "Email provider configured."
  });

  return items;
}

/**
 * Non-invasive warnings. Every threshold comes from PILOT_ALERT_DEFAULTS and
 * is quoted in the alert, so nothing fires from a number buried in the code.
 * These are development defaults, not conclusions from real pilots.
 */
export async function pilotAlerts(params: {
  businessId: string;
  range: PilotRange;
  raw: RawCounts;
  gaps: KnowledgeGapRow[];
  health: HealthItem[];
}): Promise<PilotAlert[]> {
  const { businessId, range, raw, gaps, health } = params;
  const alerts: PilotAlert[] = [];

  if (raw.receptionistReplies >= PILOT_ALERT_DEFAULTS.minimumSampleForRates) {
    const fallbackRate = raw.fallbackReplies / raw.receptionistReplies;
    if (fallbackRate > PILOT_ALERT_DEFAULTS.fallbackRateWarning) {
      alerts.push({
        key: "fallback_rate",
        level: "warning",
        message: `${Math.round(fallbackRate * 100)}% of replies fell back to the deterministic responder.`,
        threshold: `Warns above ${Math.round(PILOT_ALERT_DEFAULTS.fallbackRateWarning * 100)}% over at least ${PILOT_ALERT_DEFAULTS.minimumSampleForRates} replies.`
      });
    }
  }

  for (const gap of gaps.filter((row) => row.conversations >= PILOT_ALERT_DEFAULTS.knowledgeGapWarning)) {
    alerts.push({
      key: `knowledge_gap:${gap.kind}:${gap.topic}`,
      level: "warning",
      message: `${gap.topicLabel} came up in ${gap.conversations} conversations with nothing on file. ${gap.suggestion}`,
      threshold: `Warns at ${PILOT_ALERT_DEFAULTS.knowledgeGapWarning} conversations in the period.`
    });
  }

  const [unresolvedEscalations, openIssues] = await Promise.all([
    prisma.escalation.count({ where: { businessId, status: { in: ["requested", "assigned"] } } }),
    prisma.pilotIssue.count({ where: { businessId, status: { in: ["open", "reviewing"] } } })
  ]);

  if (unresolvedEscalations >= PILOT_ALERT_DEFAULTS.unresolvedEscalationsWarning) {
    alerts.push({
      key: "unresolved_escalations",
      level: "warning",
      message: `${unresolvedEscalations} handoffs are still waiting for someone.`,
      threshold: `Warns at ${PILOT_ALERT_DEFAULTS.unresolvedEscalationsWarning} open handoffs.`
    });
  }
  if (openIssues >= PILOT_ALERT_DEFAULTS.openIssuesWarning) {
    alerts.push({
      key: "open_issues",
      level: "warning",
      message: `${openIssues} reported issues are unresolved.`,
      threshold: `Warns at ${PILOT_ALERT_DEFAULTS.openIssuesWarning} open issues.`
    });
  }

  const calendar = health.find((item) => item.key === "calendar");
  if (calendar?.level === "degraded") {
    alerts.push({
      key: "calendar_degraded",
      level: "critical",
      message: `Calendar: ${calendar.detail}`,
      threshold: "Fires whenever a connected calendar stops being usable."
    });
  }
  if (raw.failedNotifications >= PILOT_ALERT_DEFAULTS.notificationFailureWarning) {
    alerts.push({
      key: "notification_failures",
      level: "warning",
      message: `${raw.failedNotifications} notifications failed to deliver in ${range.label.toLowerCase()}.`,
      threshold: `Warns at ${PILOT_ALERT_DEFAULTS.notificationFailureWarning} failures.`
    });
  }

  const targets = await prisma.pilotTarget.findUnique({ where: { businessId } });
  if (targets?.maxHumanInterventionRate != null && raw.conversationsWithCallerMessage >= PILOT_ALERT_DEFAULTS.minimumSampleForRates) {
    const actual = raw.humanInterventions / raw.conversationsWithCallerMessage;
    if (actual > targets.maxHumanInterventionRate) {
      alerts.push({
        key: "intervention_target",
        level: "warning",
        message: `Human intervention is at ${Math.round(actual * 100)}%, above the pilot's own target.`,
        threshold: `This business's target: at most ${Math.round(targets.maxHumanInterventionRate * 100)}%.`
      });
    }
  }
  if (targets?.maxUnresolvedIssues != null && openIssues > targets.maxUnresolvedIssues) {
    alerts.push({
      key: "issue_target",
      level: "warning",
      message: `${openIssues} unresolved issues, above the pilot's own target.`,
      threshold: `This business's target: at most ${targets.maxUnresolvedIssues}.`
    });
  }

  // Expired-but-unreleased holds would silently block slots; surfaced rather
  // than fixed behind the operator's back.
  const staleHolds = await prisma.appointment.count({
    where: { businessId, status: "awaiting_confirmation", confirmationExpiresAt: { lt: new Date(range.to) } }
  });
  if (staleHolds > 0) {
    alerts.push({
      key: "stale_holds",
      level: "warning",
      message: `${staleHolds} held slot${staleHolds === 1 ? " has" : "s have"} passed their confirmation window and will be released.`,
      threshold: "Fires for any hold past confirmationExpiresAt."
    });
  }

  return alerts;
}
