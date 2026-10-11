import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getEscalation, listEscalations, updateEscalationStatus } from "./opsClient";
import { useAsync } from "./useAsync";
import { StateBlock, StatusPill, formatDateTime } from "./components";
import { useAuth } from "./AuthContext";

export function EscalationsPage() {
  const { businessId = "" } = useParams();
  const state = useAsync(() => listEscalations(businessId), [businessId]);

  return (
    <section>
      <header className="ops-page-head">
        <h1>Escalations</h1>
      </header>

      <StateBlock
        loading={state.loading}
        error={state.error}
        empty={(state.data?.length ?? 0) === 0}
        emptyMessage="No escalations yet."
        onRetry={state.reload}
      >
        <table className="ops-table">
          <thead>
            <tr>
              <th>Caller</th>
              <th>Reason</th>
              <th>Requested</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {state.data?.map((escalation) => (
              <tr key={escalation.id}>
                <td>{escalation.callerName ?? "—"}</td>
                <td className="ops-cell-wrap">{escalation.reason}</td>
                <td>{formatDateTime(escalation.createdAt)}</td>
                <td>
                  <StatusPill status={escalation.status} />
                </td>
                <td>
                  <Link to={`/dashboard/${businessId}/escalations/${escalation.id}`}>Open</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </StateBlock>
    </section>
  );
}

const ACTION_LABELS: Record<string, string> = {
  assigned: "Assign to staff",
  resolved: "Mark resolved",
  closed: "Close"
};

export function EscalationDetailPage() {
  const { businessId = "", escalationId = "" } = useParams();
  const state = useAsync(
    () => getEscalation(businessId, escalationId),
    [businessId, escalationId]
  );
  const { can } = useAuth();
  const canWrite = can(businessId, "operations:write");
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function transition(status: string) {
    setPending(true);
    setActionError(null);
    try {
      await updateEscalationStatus(businessId, escalationId, status);
      state.reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not update the escalation");
    } finally {
      setPending(false);
    }
  }

  return (
    <section>
      <header className="ops-page-head">
        <h1>Escalation</h1>
        <Link to={`/dashboard/${businessId}/escalations`}>← All escalations</Link>
      </header>

      <StateBlock loading={state.loading} error={state.error} onRetry={state.reload}>
        {state.data && (
          <>
            <dl className="ops-detail">
              <dt>Status</dt>
              <dd>
                <StatusPill status={state.data.escalation.status} />
              </dd>
              <dt>Business</dt>
              <dd>{state.data.businessName}</dd>
              <dt>Caller</dt>
              <dd>{state.data.escalation.callerName ?? "—"}</dd>
              <dt>Reason</dt>
              <dd>{state.data.escalation.reason}</dd>
              <dt>Requested</dt>
              <dd>{formatDateTime(state.data.escalation.createdAt)}</dd>
              <dt>Assigned</dt>
              <dd>{formatDateTime(state.data.escalation.assignedAt)}</dd>
              <dt>Resolved</dt>
              <dd>{formatDateTime(state.data.escalation.resolvedAt)}</dd>
              <dt>Conversation</dt>
              <dd>
                <Link
                  to={`/dashboard/${businessId}/conversations/${state.data.escalation.conversationId}`}
                >
                  Open originating conversation
                </Link>
              </dd>
            </dl>

            <h2>Actions</h2>
            {!canWrite ? (
              <p className="ops-state">Your role has read-only access to this escalation.</p>
            ) : state.data.escalation.allowedTransitions.length === 0 ? (
              <p className="ops-state">
                This escalation is {state.data.escalation.status}; no further changes are possible.
              </p>
            ) : (
              <div className="ops-actions">
                {state.data.escalation.allowedTransitions.map((status) => (
                  <button key={status} type="button" disabled={pending} onClick={() => transition(status)}>
                    {ACTION_LABELS[status] ?? status}
                  </button>
                ))}
              </div>
            )}
            {actionError && <p className="ops-state ops-state-error">{actionError}</p>}

            <h2>History</h2>
            {state.data.history.length === 0 ? (
              <p className="ops-state">No status changes recorded yet.</p>
            ) : (
              <ul className="ops-activity">
                {state.data.history.map((event) => (
                  <li key={event.id}>
                    <span className="ops-activity-time">{formatDateTime(event.createdAt)}</span>
                    <span>
                      {event.actorName ?? "Someone"} changed {event.fromStatus} → {event.toStatus}
                    </span>
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
