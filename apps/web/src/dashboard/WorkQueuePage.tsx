import { Link, useParams } from "react-router-dom";
import { listWorkQueue } from "./opsClient";
import { useAsync } from "./useAsync";
import { StateBlock, StatusPill, formatDateTime } from "./components";

function formatAge(hours: number): string {
  if (hours < 1) return "under an hour";
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function WorkQueuePage() {
  const { businessId = "" } = useParams();
  const state = useAsync(() => listWorkQueue(businessId), [businessId]);

  return (
    <section>
      <header className="ops-page-head">
        <h1>Work queue</h1>
      </header>

      <p className="ops-note">
        Everything still waiting on a person, oldest first. Items leave this list when they are
        confirmed, declined, resolved or closed.
      </p>

      <StateBlock
        loading={state.loading}
        error={state.error}
        empty={(state.data?.length ?? 0) === 0}
        emptyMessage="Nothing waiting. The queue is clear."
        onRetry={state.reload}
      >
        <table className="ops-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Customer</th>
              <th>Detail</th>
              <th>Waiting</th>
              <th>Raised</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {state.data?.map((item) => (
              <tr key={`${item.type}-${item.id}`}>
                <td>
                  <span className="ops-tag">{item.type}</span>
                </td>
                <td>{item.customer ?? "—"}</td>
                <td className="ops-cell-wrap">{item.summary}</td>
                <td>{formatAge(item.ageHours)}</td>
                <td>{formatDateTime(item.createdAt)}</td>
                <td>
                  <StatusPill status={item.status} />
                </td>
                <td>
                  <Link
                    to={`/dashboard/${businessId}/${
                      item.type === "booking" ? "bookings" : "escalations"
                    }/${item.id}`}
                  >
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </StateBlock>
    </section>
  );
}
