import { useState } from "react";
import {
  CONVERSATION_OUTCOMES,
  CONVERSATION_OUTCOME_LABELS,
  FEEDBACK_RATINGS,
  FEEDBACK_RATING_LABELS,
  PILOT_ISSUE_CATEGORIES,
  PILOT_ISSUE_CATEGORY_LABELS,
  type ConversationOutcome,
  type FeedbackRating,
  type PilotIssueCategory
} from "@veyra/shared";
import {
  getConversationOutcome,
  listConversationFeedback,
  rateConversation,
  reportPilotIssue,
  setConversationOutcome
} from "../opsClient";
import { StateBlock, formatDateTime } from "../components";
import { useAsync } from "../useAsync";
import { useAuth } from "../AuthContext";

/**
 * Pilot review of a single conversation: what Veyra concluded happened, what
 * the operator thinks of the answers, and a way to report that Veyra got it
 * wrong.
 *
 * None of this edits the conversation. The transcript above stays exactly as
 * the caller experienced it — feedback and issues are recorded alongside it.
 */
export function ConversationReview({ businessId, conversationId }: { businessId: string; conversationId: string }) {
  const { can } = useAuth();
  const canReport = can(businessId, "pilot:report");

  const outcome = useAsync(() => getConversationOutcome(businessId, conversationId), [businessId, conversationId]);
  const feedback = useAsync(() => listConversationFeedback(businessId, conversationId), [businessId, conversationId]);

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<PilotIssueCategory>("incorrect_answer");
  const [note, setNote] = useState("");
  const [reporting, setReporting] = useState(false);

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(message);
      outcome.reload();
      feedback.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ops-panel" data-testid="conversation-review">
      <h2>Pilot review</h2>

      {notice && (
        <p className="ops-banner ops-banner-success" role="status" data-testid="review-notice">
          {notice}
        </p>
      )}
      {error && (
        <p className="ops-banner" role="alert" data-testid="review-error">
          {error}
        </p>
      )}

      <StateBlock loading={outcome.loading && !outcome.data} error={outcome.error} onRetry={outcome.reload}>
        {outcome.data && (
          <>
            <dl className="ops-detail">
              <dt>Outcome</dt>
              <dd data-testid="conversation-outcome">
                {CONVERSATION_OUTCOME_LABELS[outcome.data.outcome]}
                <span className="ops-note"> · {outcome.data.source === "operator" ? "set by an operator" : "derived"}</span>
              </dd>
              <dt>Why</dt>
              <dd className="ops-note" data-testid="conversation-outcome-evidence">
                {outcome.data.evidence}
                {outcome.data.overriddenBy ? ` (${outcome.data.overriddenBy}, ${formatDateTime(outcome.data.overriddenAt ?? null)})` : ""}
              </dd>
            </dl>

            {canReport && (
              <div className="ops-actions" data-testid="outcome-override">
                <label>
                  Correct the outcome
                  <select
                    value={outcome.data.source === "operator" ? outcome.data.outcome : ""}
                    disabled={busy}
                    onChange={(event) =>
                      run(
                        () =>
                          setConversationOutcome(businessId, conversationId, {
                            outcome: (event.target.value || null) as ConversationOutcome | null
                          }),
                        event.target.value ? "Outcome corrected." : "Back to the derived outcome."
                      )
                    }
                  >
                    <option value="">Use what Veyra derived</option>
                    {CONVERSATION_OUTCOMES.map((value) => (
                      <option key={value} value={value}>
                        {CONVERSATION_OUTCOME_LABELS[value]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </>
        )}
      </StateBlock>

      {canReport && (
        <>
          <h3>Was this handled well?</h3>
          <div className="ops-actions" data-testid="feedback-actions">
            {FEEDBACK_RATINGS.map((rating: FeedbackRating) => (
              <button
                key={rating}
                type="button"
                disabled={busy}
                data-testid={`feedback-${rating}`}
                onClick={() => run(() => rateConversation(businessId, conversationId, { rating }), "Thanks — recorded.")}
              >
                {FEEDBACK_RATING_LABELS[rating]}
              </button>
            ))}
          </div>

          <h3>Veyra got this wrong</h3>
          {!reporting ? (
            <button type="button" onClick={() => setReporting(true)} data-testid="report-issue-open">
              Report issue
            </button>
          ) : (
            <div className="ops-actions" data-testid="report-issue-form">
              <label>
                What went wrong
                <select value={category} onChange={(event) => setCategory(event.target.value as PilotIssueCategory)}>
                  {PILOT_ISSUE_CATEGORIES.map((value) => (
                    <option key={value} value={value}>
                      {PILOT_ISSUE_CATEGORY_LABELS[value]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Note (optional)
                <input type="text" value={note} onChange={(event) => setNote(event.target.value)} data-testid="report-issue-note" />
              </label>
              <button
                type="button"
                disabled={busy}
                data-testid="report-issue-submit"
                onClick={() =>
                  run(async () => {
                    await reportPilotIssue(businessId, { category, conversationId, note: note || undefined });
                    setReporting(false);
                    setNote("");
                  }, "Issue reported. It's in the pilot issue queue.")
                }
              >
                Report it
              </button>
              <button type="button" onClick={() => setReporting(false)}>
                Cancel
              </button>
            </div>
          )}
        </>
      )}

      <StateBlock loading={feedback.loading && !feedback.data} error={feedback.error} onRetry={feedback.reload}>
        {feedback.data && feedback.data.length > 0 && (
          <>
            <h3>Operator feedback</h3>
            <ul className="ops-feature-list" data-testid="feedback-list">
              {feedback.data.map((entry) => (
                <li key={entry.id}>
                  {FEEDBACK_RATING_LABELS[entry.rating]}
                  <span className="ops-note">
                    {" "}
                    · {formatDateTime(entry.createdAt)}
                    {entry.actor ? ` · ${entry.actor}` : ""}
                  </span>
                  {entry.note && <p className="ops-note">{entry.note}</p>}
                </li>
              ))}
            </ul>
          </>
        )}
      </StateBlock>
    </section>
  );
}
