import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ConfirmationStatus, OpsBooking } from "@veyra/shared";
import { getBooking, listBookings, updateBookingStatus } from "./opsClient";
import { useAsync } from "./useAsync";
import { StateBlock, StatusPill, formatDateTime } from "./components";
import { useAuth } from "./AuthContext";

/**
 * What the customer was told, in words an operator can act on. Kept apart
 * from the booking status: a confirmed booking whose confirmation bounced is
 * still confirmed, and the operator needs to see both facts.
 */
const CONFIRMATION_LABELS: Record<ConfirmationStatus, string> = {
  not_required: "No confirmation needed",
  queued: "Queued",
  accepted: "Accepted by provider",
  sent: "Sent",
  delivered: "Delivered",
  failed: "Failed",
  blocked: "Blocked",
  no_destination: "No way to reach this customer"
};

export function BookingsPage() {
  const { businessId = "" } = useParams();
  const state = useAsync(() => listBookings(businessId), [businessId]);

  return (
    <section>
      <header className="ops-page-head">
        <h1>Bookings</h1>
      </header>

      <StateBlock
        loading={state.loading}
        error={state.error}
        empty={(state.data?.length ?? 0) === 0}
        emptyMessage="No booking requests yet."
        onRetry={state.reload}
      >
        <table className="ops-table">
          <thead>
            <tr>
              <th>Caller</th>
              <th>Service</th>
              <th>Requested time</th>
              <th>Submitted</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {state.data?.map((booking) => (
              <tr key={booking.id}>
                <td>{booking.callerName ?? "—"}</td>
                <td>{booking.serviceName ?? "—"}</td>
                <td>{booking.requestedTime}</td>
                <td>{formatDateTime(booking.submittedAt)}</td>
                <td>
                  <StatusPill status={booking.status} />
                </td>
                <td>
                  <Link to={`/dashboard/${businessId}/bookings/${booking.id}`}>Open</Link>
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
  reviewing: "Review request",
  confirmed: "Confirm request",
  declined: "Decline request",
  cancelled: "Cancel request",
  submitted: "Mark submitted"
};

export function BookingDetailPage() {
  const { businessId = "", bookingId = "" } = useParams();
  const state = useAsync(() => getBooking(businessId, bookingId), [businessId, bookingId]);
  const { can } = useAuth();
  const canWrite = can(businessId, "operations:write");
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function transition(booking: OpsBooking, status: string) {
    setPending(true);
    setActionError(null);
    try {
      await updateBookingStatus(businessId, booking.id, status);
      state.reload();
    } catch (err) {
      // The server is the authority; a rejected transition surfaces here.
      setActionError(err instanceof Error ? err.message : "Could not update the request");
    } finally {
      setPending(false);
    }
  }

  return (
    <section>
      <header className="ops-page-head">
        <h1>Booking request</h1>
        <Link to={`/dashboard/${businessId}/bookings`}>← All bookings</Link>
      </header>

      <StateBlock loading={state.loading} error={state.error} onRetry={state.reload}>
        {state.data && (
          <>
            <dl className="ops-detail">
              <dt>Status</dt>
              <dd>
                <StatusPill status={state.data.booking.status} />
              </dd>
              <dt>Business</dt>
              <dd>{state.data.businessName}</dd>
              <dt>Caller</dt>
              <dd>{state.data.booking.callerName ?? "—"}</dd>
              <dt>Service</dt>
              <dd>{state.data.booking.serviceName ?? "—"}</dd>
              <dt>Requested time</dt>
              <dd>{state.data.booking.requestedTime}</dd>
              <dt>Booking type</dt>
              <dd data-testid="booking-mode">
                {state.data.booking.mode === "calendar" ? "Live calendar booking" : "Booking request"}
              </dd>
              {state.data.booking.mode === "calendar" && (
                <>
                  <dt>Appointment</dt>
                  <dd data-testid="booking-appointment-time">
                    {/* Shown in the business timezone, never the viewer's browser zone. */}
                    {formatInZone(state.data.booking.startTime, state.data.booking.timezone)}
                    {state.data.booking.timezone ? ` (${state.data.booking.timezone})` : ""}
                  </dd>
                  <dt>Calendar event</dt>
                  <dd data-testid="booking-calendar-event">
                    {state.data.booking.externalEventId
                      ? `${state.data.booking.calendarProvider ?? "calendar"} · ${state.data.booking.externalEventId} (${state.data.booking.externalEventStatus ?? "unknown"})`
                      : "Not created yet — waiting for the caller to confirm"}
                  </dd>
                </>
              )}
              <dt>Customer told</dt>
              <dd data-testid="booking-confirmation">
                {/* Never upgraded on assumption: "accepted" stays "accepted"
                    until a provider receipt says delivered. */}
                {state.data.booking.confirmation
                  ? `${CONFIRMATION_LABELS[state.data.booking.confirmation.status]}${
                      state.data.booking.confirmation.channel
                        ? ` · ${state.data.booking.confirmation.channel}`
                        : ""
                    }${
                      state.data.booking.confirmation.recipient
                        ? ` · ${state.data.booking.confirmation.recipient}`
                        : ""
                    }`
                  : "Nothing sent"}
                {state.data.booking.confirmation?.reason && (
                  <span className="ops-note"> · {state.data.booking.confirmation.reason}</span>
                )}
                {state.data.booking.confirmation?.retrying && (
                  <span className="ops-note">
                    {" "}· retrying (attempt {state.data.booking.confirmation.attempts})
                  </span>
                )}
                {state.data.booking.confirmation?.deliveredAt && (
                  <span className="ops-note">
                    {" "}· delivered {formatDateTime(state.data.booking.confirmation.deliveredAt)}
                  </span>
                )}
              </dd>
              <dt>Notes</dt>
              <dd>{state.data.booking.notes ?? "—"}</dd>
              <dt>Submitted</dt>
              <dd>{formatDateTime(state.data.booking.submittedAt)}</dd>
              <dt>Reviewed</dt>
              <dd>{formatDateTime(state.data.booking.reviewedAt)}</dd>
              <dt>Resolved</dt>
              <dd>{formatDateTime(state.data.booking.resolvedAt)}</dd>
              <dt>Conversation</dt>
              <dd>
                <Link
                  to={`/dashboard/${businessId}/conversations/${state.data.booking.conversationId}`}
                >
                  Open originating conversation
                </Link>
              </dd>
            </dl>

            <h2>Actions</h2>
            {!canWrite ? (
              <p className="ops-state">Your role has read-only access to this request.</p>
            ) : state.data.booking.allowedTransitions.length === 0 ? (
              <p className="ops-state">
                This request is {state.data.booking.status}; no further changes are possible.
              </p>
            ) : (
              <div className="ops-actions">
                {state.data.booking.allowedTransitions.map((status) => (
                  <button
                    key={status}
                    type="button"
                    disabled={pending}
                    onClick={() => transition(state.data!.booking, status)}
                  >
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
                      {event.actorName ??
                        (event.actorType === "caller" ? "Caller (via Veyra)" : "Someone")}{" "}
                      {event.fromStatus
                        ? `changed ${event.fromStatus} → ${event.toStatus}`
                        : `created it as ${event.toStatus}`}
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

/** An instant rendered in the business's own timezone. */
function formatInZone(iso: string | null, timezone: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone ?? "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(iso));
}
