import { useCallback, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  PILOT_ISSUE_CATEGORY_LABELS,
  PILOT_SAFETY_KEYS,
  PILOT_SAFETY_LABELS,
  type PilotMetric,
  type PilotRangeKey,
  type PilotReport,
  type PilotSafetyKey,
  type PilotStatus,
  canTransitionPilot
} from "@veyra/shared";
import {
  getKnowledgeGaps,
  getPilotOverview,
  getPilotReport,
  getPilotSeries,
  getPilotTimeline,
  pilotExportUrl,
  setPilotSafety,
  setPilotStatus,
  setPilotTargets
} from "../opsClient";
import { StateBlock, formatDateTime } from "../components";
import { useAsync } from "../useAsync";
import { ActivityChart, BarList } from "./charts";

/**
 * Pilot operations in Veyra Console.
 *
 * Everything on this page is measured from records Veyra holds. A number that
 * cannot be derived shows as "Not available" rather than 0, every rate carries
 * the definition it was calculated from, and nothing here claims the pilot
 * succeeded — it reports what happened and leaves the judgement to people.
 */

const RANGES: { key: PilotRangeKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "last_7_days", label: "7 days" },
  { key: "last_30_days", label: "30 days" },
  { key: "pilot_lifetime", label: "Pilot lifetime" },
  { key: "custom", label: "Custom" }
];

const STATUS_LABELS: Record<PilotStatus, string> = {
  none: "No pilot",
  preparing: "Preparing",
  active: "Active",
  paused: "Paused",
  completed: "Completed"
};

const NEXT_STATUSES: PilotStatus[] = ["preparing", "active", "paused", "completed", "none"];

function formatMetric(metric: PilotMetric): string {
  if (metric.value === null) return "Not available";
  if (metric.unit === "percent") return `${Math.round(metric.value * 100)}%`;
  if (metric.unit === "seconds") {
    const seconds = metric.value;
    if (seconds < 90) return `${Math.round(seconds)}s`;
    if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
    return `${(seconds / 3600).toFixed(1)} h`;
  }
  return String(metric.value);
}

function MetricGrid({ metrics, testId }: { metrics: PilotMetric[]; testId: string }) {
  return (
    <dl className="ops-metric-grid" data-testid={testId}>
      {metrics.map((metric) => (
        <div key={metric.key} className="ops-metric" data-testid={`metric-${metric.key}`}>
          <dt>{metric.label}</dt>
          <dd className={metric.value === null ? "ops-metric-unavailable" : undefined}>{formatMetric(metric)}</dd>
          <p className="ops-note">
            {metric.definition}
            {metric.unavailableReason ? ` ${metric.unavailableReason}` : ""}
          </p>
        </div>
      ))}
    </dl>
  );
}

export function PilotPage() {
  const { businessId = "" } = useParams();
  const [range, setRange] = useState<PilotRangeKey>("last_7_days");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = range === "custom" ? { range, from: custom.from, to: custom.to } : { range };
  const ready = range !== "custom" || Boolean(custom.from && custom.to);

  const overview = useAsync(
    () => (ready ? getPilotOverview(businessId, query) : Promise.resolve(null)),
    [businessId, range, ready ? custom.from : "", ready ? custom.to : ""]
  );
  const series = useAsync(
    () => (ready ? getPilotSeries(businessId, query) : Promise.resolve(null)),
    [businessId, range, ready ? custom.from : "", ready ? custom.to : ""]
  );
  const gaps = useAsync(
    () => (ready ? getKnowledgeGaps(businessId, query) : Promise.resolve(null)),
    [businessId, range, ready ? custom.from : "", ready ? custom.to : ""]
  );
  const timeline = useAsync(
    () => (ready ? getPilotTimeline(businessId, query) : Promise.resolve(null)),
    [businessId, range, ready ? custom.from : "", ready ? custom.to : ""]
  );
  // Same query as the metrics above, so the report can never describe a
  // different period from the numbers it sits under.
  const report = useAsync(
    () => (ready ? getPilotReport(businessId, query) : Promise.resolve(null)),
    [businessId, range, ready ? custom.from : "", ready ? custom.to : ""]
  );

  const reload = useCallback(() => {
    overview.reload();
    series.reload();
    gaps.reload();
    timeline.reload();
    report.reload();
  }, [overview, series, gaps, timeline, report]);

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(message);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const data = overview.data;

  return (
    <section data-testid="pilot-page">
      <header className="ops-page-head">
        <h1>Pilot</h1>
        <div className="ops-actions" data-testid="pilot-range">
          {RANGES.map((option) => (
            <button
              key={option.key}
              type="button"
              className={range === option.key ? "ops-chip ops-chip-active" : "ops-chip"}
              onClick={() => setRange(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </header>

      {range === "custom" && (
        <div className="ops-actions" data-testid="pilot-custom-range">
          <label>
            From <input type="date" value={custom.from} onChange={(event) => setCustom({ ...custom, from: event.target.value })} />
          </label>
          <label>
            To <input type="date" value={custom.to} onChange={(event) => setCustom({ ...custom, to: event.target.value })} />
          </label>
          {!ready && <span className="ops-note">Pick both dates to see the period.</span>}
        </div>
      )}

      {notice && (
        <p className="ops-banner ops-banner-success" role="status" data-testid="pilot-notice">
          {notice}
        </p>
      )}
      {error && (
        <p className="ops-banner" role="alert" data-testid="pilot-error">
          {error}
        </p>
      )}

      <StateBlock loading={overview.loading && !data} error={overview.error} onRetry={overview.reload}>
        {data && (
          <>
            <p className="ops-note" data-testid="pilot-measurement-note">
              These are observed counts for {data.metrics.range.label.toLowerCase()}, in {data.timezone}. They show what
              happened during the pilot — not revenue, time saved or customer satisfaction, which only real pilot
              feedback can tell you.
            </p>

            {/* ---------------- status ---------------- */}
            <section className="ops-panel" data-testid="pilot-status-panel">
              <h2>Pilot status</h2>
              <div className="ops-plan-head">
                <div>
                  <div className="ops-plan-name" data-testid="pilot-status">
                    {STATUS_LABELS[data.pilot.status]}
                    {data.pilot.label ? ` · ${data.pilot.label}` : ""}
                  </div>
                  <p className="ops-note">
                    {data.pilot.startedAt ? `Started ${formatDateTime(data.pilot.startedAt)}. ` : "Not started. "}
                    {data.pilot.endedAt ? `Ended ${formatDateTime(data.pilot.endedAt)}. ` : ""}
                    Plan {data.plan ?? "none"} · subscription {data.subscriptionStatus} · Reception {data.receptionStatus}.
                  </p>
                </div>
                <span className={`ops-pill ops-pill-${data.pilot.status === "active" ? "enabled" : "warning"}`}>
                  {STATUS_LABELS[data.pilot.status]}
                </span>
              </div>

              {data.canManage ? (
                <div className="ops-actions" data-testid="pilot-status-actions">
                  {NEXT_STATUSES.filter((status) => canTransitionPilot(data.pilot.status, status)).map((status) => (
                    <button
                      key={status}
                      type="button"
                      disabled={busy}
                      data-testid={`pilot-set-${status}`}
                      onClick={() => run(() => setPilotStatus(businessId, status), `Pilot moved to ${STATUS_LABELS[status].toLowerCase()}.`)}
                    >
                      {status === "active" && data.pilot.status === "paused" ? "Resume pilot" : `Move to ${STATUS_LABELS[status].toLowerCase()}`}
                    </button>
                  ))}
                  {data.pilot.status === "completed" && <span className="ops-note">A completed pilot is final.</span>}
                </div>
              ) : (
                <p className="ops-note">Only an owner or admin can change the pilot's status.</p>
              )}
            </section>

            {/* ---------------- readiness ---------------- */}
            <section className="ops-panel" data-testid="pilot-readiness">
              <h2>Pilot readiness</h2>
              <p className="ops-note">
                Separate from Reception readiness: this asks whether a real pilot can be run and reviewed safely.
                {data.readiness.requiresLiveBooking
                  ? " This pilot expects live calendar booking, so the calendar has to be working."
                  : " This is a request-only pilot, so no calendar connection is needed."}
              </p>
              <ul className="ops-feature-list">
                {data.readiness.checks.map((check) => (
                  <li key={check.key} data-testid={`readiness-${check.key}`}>
                    <span className={`ops-pill ops-pill-${check.level === "ready" ? "enabled" : check.level === "warning" ? "warning" : "disabled"}`}>
                      {check.level}
                    </span>{" "}
                    {check.message}
                    {check.hint && <span className="ops-note"> {check.hint}</span>}
                  </li>
                ))}
              </ul>
            </section>

            {/* ---------------- alerts + health ---------------- */}
            {data.alerts.length > 0 && (
              <section className="ops-panel" data-testid="pilot-alerts">
                <h2>Needs attention</h2>
                {data.alerts.map((alert) => (
                  <p key={alert.key} className="ops-banner">
                    {alert.message} <span className="ops-note">{alert.threshold}</span>
                  </p>
                ))}
              </section>
            )}

            <section className="ops-panel" data-testid="pilot-health">
              <h2>Operational health</h2>
              <table className="ops-table">
                <tbody>
                  {data.health.map((item) => (
                    <tr key={item.key} data-testid={`health-${item.key}`}>
                      <td>{item.label}</td>
                      <td>
                        <span className={`ops-pill ops-pill-${item.level === "ok" ? "enabled" : item.level === "degraded" ? "warning" : "disabled"}`}>
                          {item.level.replace("_", " ")}
                        </span>
                      </td>
                      <td className="ops-note">{item.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            {/* ---------------- metrics ---------------- */}
            <section className="ops-panel" data-testid="pilot-metrics">
              <h2>Activity</h2>
              <MetricGrid metrics={data.metrics.activity} testId="pilot-activity-metrics" />
              <h2>Outcomes</h2>
              <MetricGrid metrics={data.metrics.outcomes} testId="pilot-outcome-metrics" />
              <h2>Derived</h2>
              <p className="ops-note">
                Each rate says exactly what it divides by. A rate needs a reasonable sample before it means anything —
                until then it reads "Not available".
              </p>
              <MetricGrid metrics={data.metrics.derived} testId="pilot-derived-metrics" />
            </section>

            {/* ---------------- charts ---------------- */}
            <section className="ops-panel" data-testid="pilot-charts">
              <h2>Over time</h2>
              <StateBlock loading={series.loading && !series.data} error={series.error} onRetry={series.reload}>
                {series.data && (
                  <>
                    <ActivityChart points={series.data.series} />
                    <h3>What callers asked about</h3>
                    <BarList
                      testId="pilot-intents"
                      rows={series.data.topIntents.map((intent) => ({ label: intent.label, count: intent.count }))}
                      emptyMessage="No caller messages in this period."
                    />
                    <h3>How conversations ended</h3>
                    <BarList
                      testId="pilot-outcomes"
                      rows={series.data.outcomes.map((outcome) => ({ label: outcome.label, count: outcome.count }))}
                      emptyMessage="No conversations in this period."
                    />
                  </>
                )}
              </StateBlock>
            </section>

            {/* ---------------- pilot report ---------------- */}
            <PilotReportSection businessId={businessId} state={report} />

            {/* ---------------- knowledge gaps ---------------- */}
            <section className="ops-panel" data-testid="pilot-knowledge-gaps">
              <h2>Knowledge gaps</h2>
              <p className="ops-note">
                Questions callers asked that this business hasn't told Veyra about. Counted once per conversation, from
                a fixed list of topics — never guessed from the caller's words.
              </p>
              <StateBlock loading={gaps.loading && !gaps.data} error={gaps.error} onRetry={gaps.reload}>
                {gaps.data &&
                  (gaps.data.gaps.length === 0 ? (
                    <p className="ops-note" data-testid="pilot-gaps-empty">
                      No knowledge gaps recorded in this period.
                    </p>
                  ) : (
                    <table className="ops-table" data-testid="pilot-gaps-table">
                      <thead>
                        <tr>
                          <th>Topic</th>
                          <th>Conversations</th>
                          <th>What would fix it</th>
                        </tr>
                      </thead>
                      <tbody>
                        {gaps.data.gaps.map((gap) => (
                          <tr key={`${gap.kind}-${gap.topic}-${gap.topicLabel}`}>
                            <td>{gap.topicLabel}</td>
                            <td>{gap.conversations}</td>
                            <td className="ops-note">{gap.suggestion}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ))}
              </StateBlock>
            </section>

            {/* ---------------- targets ---------------- */}
            <PilotTargetsPanel
              businessId={businessId}
              overview={data}
              busy={busy}
              onSave={(targets) => run(() => setPilotTargets(businessId, targets), "Pilot targets saved.")}
            />

            {/* ---------------- safety ---------------- */}
            <section className="ops-panel" data-testid="pilot-safety">
              <h2>Pilot safety controls</h2>
              <p className="ops-note">
                Operational brakes that sit below the plan. Switching one off stops Veyra doing that automatically;
                switching one on never grants a feature the plan doesn't include.
              </p>
              <table className="ops-table">
                <tbody>
                  {PILOT_SAFETY_KEYS.map((key: PilotSafetyKey) => {
                    const locked = data.safetyLockedByPlan.includes(key);
                    return (
                      <tr key={key} data-testid={`safety-${key}`}>
                        <td>{PILOT_SAFETY_LABELS[key]}</td>
                        <td>
                          <span className={`ops-pill ops-pill-${data.safety[key] ? "enabled" : "disabled"}`}>
                            {data.safety[key] ? "On" : "Off"}
                          </span>
                          {locked && <span className="ops-note"> · not in this plan anyway</span>}
                        </td>
                        <td>
                          {data.canManage && (
                            <button
                              type="button"
                              disabled={busy}
                              data-testid={`safety-toggle-${key}`}
                              onClick={() =>
                                run(
                                  () => setPilotSafety(businessId, { [key]: !data.safety[key] }),
                                  `${PILOT_SAFETY_LABELS[key]} switched ${data.safety[key] ? "off" : "on"}.`
                                )
                              }
                            >
                              Switch {data.safety[key] ? "off" : "on"}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>

            {/* ---------------- issues + export ---------------- */}
            <section className="ops-panel" data-testid="pilot-links">
              <h2>Review and export</h2>
              <p>
                <Link to={`/dashboard/${businessId}/pilot/issues`} data-testid="pilot-issues-link">
                  Reported issues
                </Link>{" "}
                <span className="ops-note">{data.openIssues} open.</span>
              </p>
              <div className="ops-actions" data-testid="pilot-exports">
                {(["conversations", "bookings", "escalations", "issues", "knowledge_gaps", "metrics"] as const).map((kind) => (
                  <a key={kind} className="ops-linkish" href={pilotExportUrl(businessId, kind, query)} data-testid={`export-${kind}`}>
                    {kind.replace("_", " ")} CSV
                  </a>
                ))}
              </div>
              <p className="ops-note">
                Exports contain counts, outcomes, timestamps and references — no message text, credentials or provider
                details.
              </p>
            </section>

            {/* ---------------- timeline ---------------- */}
            <section className="ops-panel" data-testid="pilot-timeline">
              <h2>Timeline</h2>
              <StateBlock loading={timeline.loading && !timeline.data} error={timeline.error} onRetry={timeline.reload}>
                {timeline.data &&
                  (timeline.data.entries.length === 0 ? (
                    <p className="ops-note">Nothing recorded in this period.</p>
                  ) : (
                    <ul className="ops-feature-list" data-testid="pilot-timeline-list">
                      {timeline.data.entries.map((entry, index) => (
                        <li key={`${entry.at}-${index}`}>
                          <span className="ops-note">{formatDateTime(entry.at)}</span> {entry.summary}
                          {entry.actor ? <span className="ops-note"> · {entry.actor}</span> : null}
                        </li>
                      ))}
                    </ul>
                  ))}
              </StateBlock>
            </section>
          </>
        )}
      </StateBlock>
    </section>
  );
}

/**
 * The pilot report, as an operator reads it.
 *
 * Everything here comes from GET /pilot/report for the *same* range as the
 * metrics above — the section states which period it covers, so a reader can
 * never attribute a recommendation to the wrong window.
 *
 * A recommendation is never shown without the evidence that produced it. That
 * is the whole point: these are arithmetic on the business's own counts, not
 * advice, and an operator should be able to check the sum.
 */
function PilotReportSection({
  businessId,
  state
}: {
  businessId: string;
  state: { data: PilotReport | null; loading: boolean; error: string | null; reload: () => void };
}) {
  const report = state.data;

  return (
    <section className="ops-panel" data-testid="pilot-report">
      <h2>Pilot report</h2>

      <StateBlock loading={state.loading && !report} error={state.error} onRetry={state.reload}>
        {report && (
          <>
            <p className="ops-note" data-testid="pilot-report-range">
              {report.range.label} · {new Date(report.range.from).toLocaleDateString()} –{" "}
              {new Date(new Date(report.range.to).getTime() - 1).toLocaleDateString()} ({report.range.timezone}).
              Generated {formatDateTime(report.generatedAt)}, from the same period as the metrics above.
            </p>

            <h3>What to do next</h3>
            {report.recommendations.length === 0 ? (
              <p className="ops-note" data-testid="pilot-recommendations-empty">
                No recommendations yet — more pilot activity is needed.
              </p>
            ) : (
              <ol className="ops-recommendations" data-testid="pilot-recommendations">
                {report.recommendations.map((recommendation, index) => (
                  <li key={`${recommendation.message}-${index}`} data-testid={`recommendation-${index}`}>
                    <p className="ops-recommendation-message">{recommendation.message}</p>
                    {/* The evidence is part of the recommendation, not a footnote. */}
                    <p className="ops-note" data-testid={`recommendation-evidence-${index}`}>
                      Because: {recommendation.evidence}
                    </p>
                  </li>
                ))}
              </ol>
            )}

            <h3>Reported issues by category</h3>
            {report.issuesByCategory.length === 0 ? (
              <p className="ops-note" data-testid="pilot-issue-categories-empty">
                No issues were reported in this period.
              </p>
            ) : (
              // A handful of counts reads better as a table than as a chart.
              <table className="ops-table" data-testid="pilot-issue-categories">
                <thead>
                  <tr>
                    <th>Category</th>
                    <th>Still open</th>
                    <th>Reported</th>
                  </tr>
                </thead>
                <tbody>
                  {report.issuesByCategory.map((row) => (
                    <tr key={row.category} data-testid={`issue-category-${row.category}`}>
                      <td>{row.label}</td>
                      <td>{row.open}</td>
                      <td>{row.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h3>Unresolved issues</h3>
            <p className="ops-note" data-testid="pilot-unresolved-scope">
              Everything still open or under review, whenever it was reported — unlike the counts above, this is not
              limited to the selected period.
            </p>
            {report.unresolvedIssues.length === 0 ? (
              <p className="ops-note" data-testid="pilot-unresolved-empty">
                No unresolved pilot issues.
              </p>
            ) : (
              <ul className="ops-feature-list" data-testid="pilot-unresolved-issues">
                {report.unresolvedIssues.map((issue) => (
                  <li key={issue.id} data-testid={`unresolved-issue-${issue.id}`}>
                    <span className={`ops-pill ops-pill-${issue.status === "reviewing" ? "warning" : "disabled"}`}>
                      {issue.status}
                    </span>{" "}
                    <Link to={`/dashboard/${businessId}/pilot/issues#issue-${issue.id}`} data-testid={`unresolved-issue-link-${issue.id}`}>
                      {PILOT_ISSUE_CATEGORY_LABELS[issue.category]}
                    </Link>
                    <span className="ops-note"> · reported {formatDateTime(issue.createdAt)}</span>
                    {/* A short note only. The conversation itself is one click away. */}
                    {issue.note && <p className="ops-note">{issue.note.length > 160 ? `${issue.note.slice(0, 160)}…` : issue.note}</p>}
                    {issue.conversationId && (
                      <p>
                        <Link
                          to={`/dashboard/${businessId}/conversations/${issue.conversationId}`}
                          data-testid={`unresolved-conversation-link-${issue.id}`}
                        >
                          Open the conversation
                        </Link>
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </StateBlock>
    </section>
  );
}

function PilotTargetsPanel({
  overview,
  busy,
  onSave
}: {
  businessId: string;
  overview: NonNullable<Awaited<ReturnType<typeof getPilotOverview>>>;
  busy: boolean;
  onSave: (targets: Record<string, number | null>) => void;
}) {
  const [form, setForm] = useState({
    targetConversations: overview.targets.targetConversations?.toString() ?? "",
    targetBookingRequests: overview.targets.targetBookingRequests?.toString() ?? "",
    targetConfirmedBookings: overview.targets.targetConfirmedBookings?.toString() ?? "",
    maxHumanInterventionRate:
      overview.targets.maxHumanInterventionRate === null ? "" : String(Math.round(overview.targets.maxHumanInterventionRate * 100)),
    maxUnresolvedIssues: overview.targets.maxUnresolvedIssues?.toString() ?? ""
  });

  const number = (value: string) => (value.trim() === "" ? null : Number(value));

  return (
    <section className="ops-panel" data-testid="pilot-targets">
      <h2>Pilot targets</h2>
      <p className="ops-note">
        Goals for this pilot, set by you. They are what you are aiming for — never a forecast, and never evidence that
        the pilot worked.
      </p>
      <div className="ops-actions">
        <label>
          Conversations
          <input
            type="number"
            min="0"
            value={form.targetConversations}
            disabled={!overview.canManage}
            onChange={(event) => setForm({ ...form, targetConversations: event.target.value })}
            data-testid="target-conversations"
          />
        </label>
        <label>
          Booking requests
          <input
            type="number"
            min="0"
            value={form.targetBookingRequests}
            disabled={!overview.canManage}
            onChange={(event) => setForm({ ...form, targetBookingRequests: event.target.value })}
          />
        </label>
        <label>
          Confirmed bookings
          <input
            type="number"
            min="0"
            value={form.targetConfirmedBookings}
            disabled={!overview.canManage}
            onChange={(event) => setForm({ ...form, targetConfirmedBookings: event.target.value })}
          />
        </label>
        <label>
          Max human intervention %
          <input
            type="number"
            min="0"
            max="100"
            value={form.maxHumanInterventionRate}
            disabled={!overview.canManage}
            onChange={(event) => setForm({ ...form, maxHumanInterventionRate: event.target.value })}
          />
        </label>
        <label>
          Max unresolved issues
          <input
            type="number"
            min="0"
            value={form.maxUnresolvedIssues}
            disabled={!overview.canManage}
            onChange={(event) => setForm({ ...form, maxUnresolvedIssues: event.target.value })}
          />
        </label>
        {overview.canManage && (
          <button
            type="button"
            disabled={busy}
            data-testid="pilot-save-targets"
            onClick={() =>
              onSave({
                targetConversations: number(form.targetConversations),
                targetBookingRequests: number(form.targetBookingRequests),
                targetConfirmedBookings: number(form.targetConfirmedBookings),
                maxHumanInterventionRate:
                  form.maxHumanInterventionRate.trim() === "" ? null : Number(form.maxHumanInterventionRate) / 100,
                maxUnresolvedIssues: number(form.maxUnresolvedIssues)
              })
            }
          >
            Save targets
          </button>
        )}
      </div>
    </section>
  );
}
