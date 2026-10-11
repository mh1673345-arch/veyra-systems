import { useParams, Link } from "react-router-dom";
import { getOverview, setup } from "./opsClient";
import { useAsync } from "./useAsync";
import { StateBlock, formatDateTime } from "./components";

export function OverviewPage() {
  const { businessId = "" } = useParams();
  const state = useAsync(() => getOverview(businessId), [businessId]);
  const reception = useAsync(() => setup.reception(businessId), [businessId]);

  return (
    <section>
      <header className="ops-page-head">
        <h1>Overview</h1>
      </header>

      {reception.data && reception.data.status !== "active" && (
        <div className="ops-banner" data-testid="reception-banner">
          {reception.data.status === "draft"
            ? "Reception isn't live yet — finish setup and go live when you're ready."
            : "Reception is paused. Callers are given your contact details instead."}{" "}
          <Link to={`/dashboard/${businessId}/setup/${reception.data.status === "draft" ? "" : "go_live"}`}>
            {reception.data.status === "draft" ? "Continue setup" : "Resume"}
          </Link>
        </div>
      )}

      <StateBlock loading={state.loading} error={state.error} onRetry={state.reload}>
        {state.data && (
          <>
            <div className="ops-stat-grid">
              <Stat label="Open work" value={state.data.openWork} />
              <Stat label="Unread notifications" value={state.data.unreadNotifications} />
              <Stat label="Conversations today" value={state.data.conversationsToday} />
              <Stat label="Conversations total" value={state.data.conversationsTotal} />
              <Stat label="Open booking requests" value={state.data.openBookings} />
              <Stat label="Open escalations" value={state.data.openEscalations} />
              <Stat label="Resolved bookings" value={state.data.resolvedBookings} />
              <Stat label="Resolved escalations" value={state.data.resolvedEscalations} />
            </div>

            {state.data.openWork > 0 && (
              <p className="ops-note">
                <Link to={`/dashboard/${businessId}/work-queue`}>Open the work queue</Link> to see
                what is still waiting on a person.
              </p>
            )}

            <h2>Recent activity</h2>
            {state.data.recentActivity.length === 0 ? (
              <p className="ops-state">No activity recorded yet.</p>
            ) : (
              <ul className="ops-activity">
                {state.data.recentActivity.map((item) => (
                  <li key={`${item.type}-${item.id}`}>
                    <span className="ops-activity-time">{formatDateTime(item.createdAt)}</span>
                    <span>
                      {item.conversationId ? (
                        <Link to={`/dashboard/${businessId}/conversations/${item.conversationId}`}>
                          {item.description}
                        </Link>
                      ) : (
                        item.description
                      )}
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

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="ops-stat">
      <span className="ops-stat-value">{value}</span>
      <span className="ops-stat-label">{label}</span>
    </div>
  );
}
