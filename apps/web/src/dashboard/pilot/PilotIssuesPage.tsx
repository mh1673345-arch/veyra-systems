import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  PILOT_ISSUE_CATEGORY_LABELS,
  PILOT_ISSUE_STATUSES,
  PILOT_ISSUE_TRANSITIONS,
  type PilotIssueDto,
  type PilotIssueStatus
} from "@veyra/shared";
import { listPilotIssues, updatePilotIssue } from "../opsClient";
import { StateBlock, formatDateTime } from "../components";
import { useAsync } from "../useAsync";
import { useAuth } from "../AuthContext";

/**
 * The pilot issue queue: everything an operator reported as wrong, and what
 * happened about it.
 *
 * Resolving an issue records a verdict; it never edits the conversation or the
 * reply that was reported, so the pilot's evidence stays as the caller
 * experienced it.
 */

const FILTERS: { key: string; label: string }[] = [
  { key: "", label: "All" },
  { key: "open", label: "Open" },
  { key: "reviewing", label: "Reviewing" },
  { key: "resolved", label: "Resolved" },
  { key: "dismissed", label: "Dismissed" }
];

export function PilotIssuesPage() {
  const { businessId = "" } = useParams();
  const { can } = useAuth();
  const canTriage = can(businessId, "pilot:triage");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const state = useAsync(() => listPilotIssues(businessId, filter || undefined), [businessId, filter]);

  async function move(issue: PilotIssueDto, status: PilotIssueStatus) {
    setBusy(true);
    setError(null);
    try {
      await updatePilotIssue(businessId, issue.id, { status, resolutionNote: notes[issue.id] || undefined });
      state.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="pilot-issues-page">
      <header className="ops-page-head">
        <h1>Pilot issues</h1>
        <Link to={`/dashboard/${businessId}/pilot`} className="ops-linkish">
          Back to pilot
        </Link>
      </header>

      <div className="ops-actions" data-testid="issue-filters">
        {FILTERS.map((option) => (
          <button
            key={option.key || "all"}
            type="button"
            className={filter === option.key ? "ops-chip ops-chip-active" : "ops-chip"}
            onClick={() => setFilter(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {error && (
        <p className="ops-banner" role="alert" data-testid="issues-error">
          {error}
        </p>
      )}

      <StateBlock loading={state.loading} error={state.error} onRetry={state.reload}>
        {state.data &&
          (state.data.length === 0 ? (
            <p className="ops-note" data-testid="issues-empty">
              Nothing reported{filter ? ` with status "${filter}"` : ""} yet. Operators can report an issue from any
              conversation.
            </p>
          ) : (
            <ul className="ops-integrations" data-testid="issues-list">
              {state.data.map((issue) => (
                // The id makes `…/pilot/issues#issue-<id>` land on this row, so a
                // link from the pilot report points at the issue itself.
                <li key={issue.id} id={`issue-${issue.id}`} className="ops-panel" data-testid={`issue-${issue.id}`}>
                  <div className="ops-plan-head">
                    <div>
                      <strong>{PILOT_ISSUE_CATEGORY_LABELS[issue.category]}</strong>
                      <p className="ops-note">
                        Reported {formatDateTime(issue.createdAt)}
                        {issue.reportedBy ? ` by ${issue.reportedBy}` : ""}
                        {issue.resolvedAt ? ` · closed ${formatDateTime(issue.resolvedAt)}${issue.resolvedBy ? ` by ${issue.resolvedBy}` : ""}` : ""}
                      </p>
                    </div>
                    <span className={`ops-pill ops-pill-${issue.status === "resolved" ? "enabled" : issue.status === "dismissed" ? "disabled" : "warning"}`}>
                      {issue.status}
                    </span>
                  </div>

                  {issue.note && <p>{issue.note}</p>}
                  {issue.resolutionNote && (
                    <p className="ops-note">
                      Resolution: {issue.resolutionNote}
                    </p>
                  )}
                  {issue.conversationId && (
                    <p>
                      <Link to={`/dashboard/${businessId}/conversations/${issue.conversationId}`}>
                        Open the conversation
                      </Link>
                    </p>
                  )}

                  {canTriage && PILOT_ISSUE_TRANSITIONS[issue.status].length > 0 && (
                    <div className="ops-actions">
                      <input
                        type="text"
                        placeholder="Note (optional)"
                        value={notes[issue.id] ?? ""}
                        onChange={(event) => setNotes({ ...notes, [issue.id]: event.target.value })}
                        aria-label={`Resolution note for ${PILOT_ISSUE_CATEGORY_LABELS[issue.category]}`}
                      />
                      {PILOT_ISSUE_STATUSES.filter((status) => PILOT_ISSUE_TRANSITIONS[issue.status].includes(status)).map((status) => (
                        <button
                          key={status}
                          type="button"
                          disabled={busy}
                          data-testid={`issue-${status}-${issue.id}`}
                          onClick={() => move(issue, status)}
                        >
                          {status === "open" ? "Reopen" : status}
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ))}
      </StateBlock>
    </section>
  );
}
