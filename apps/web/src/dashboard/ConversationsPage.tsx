import { Link, useParams } from "react-router-dom";
import { getConversation, listConversations } from "./opsClient";
import { useAsync } from "./useAsync";
import { StateBlock, StatusPill, formatDateTime } from "./components";
import { ConversationReview } from "./pilot/ConversationReview";
import { ContactCard } from "./contacts/ContactCard";
import { useAuth } from "./AuthContext";

import type { BookingConfirmationDto, ConversationChannel } from "@veyra/shared";

/**
 * Every conversation arrives on a channel, and an operator reading the list
 * needs to know which: the same question sounds different by text than it
 * does on the phone.
 */
/**
 * One short line about whether the customer was told, for the conversation
 * view. The booking page carries the detail; this only answers "did they
 * hear about it?".
 */
function confirmationIndicator(confirmation: BookingConfirmationDto | null): string {
  if (!confirmation) return "No confirmation sent";
  switch (confirmation.status) {
    case "delivered":
      return `Confirmation delivered via ${confirmation.channel}`;
    case "sent":
    case "accepted":
      return `Confirmation sent via ${confirmation.channel}`;
    case "queued":
      return `Confirmation pending via ${confirmation.channel}`;
    case "no_destination":
      return "No eligible confirmation destination";
    case "blocked":
      return "Confirmation blocked";
    case "failed":
      return `Confirmation failed via ${confirmation.channel}`;
    default:
      return "No confirmation needed";
  }
}

const CHANNEL_LABELS: Record<ConversationChannel, string> = {
  web: "Web",
  voice: "Voice",
  sms: "SMS",
  whatsapp: "WhatsApp"
};

export function ConversationsPage() {
  const { businessId = "" } = useParams();
  const state = useAsync(() => listConversations(businessId), [businessId]);

  return (
    <section>
      <header className="ops-page-head">
        <h1>Conversations</h1>
      </header>

      <StateBlock
        loading={state.loading}
        error={state.error}
        empty={(state.data?.length ?? 0) === 0}
        emptyMessage="No conversations yet."
        onRetry={state.reload}
      >
        <table className="ops-table">
          <thead>
            <tr>
              <th>Caller</th>
              <th>Channel</th>
              <th>Started</th>
              <th>Last message from caller</th>
              <th>Last intent</th>
              <th>Linked</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {state.data?.map((conversation) => (
              <tr key={conversation.id}>
                <td>{conversation.callerName ?? "—"}</td>
                <td>
                  <span className="ops-channel-badge" data-testid={`conversation-channel-${conversation.id}`}>
                    {CHANNEL_LABELS[conversation.channel]}
                  </span>
                </td>
                <td>{formatDateTime(conversation.createdAt)}</td>
                <td className="ops-cell-wrap">{conversation.lastCallerMessage ?? "—"}</td>
                <td>{conversation.lastIntent ?? "—"}</td>
                <td>
                  {conversation.bookingCount > 0 && (
                    <span className="ops-tag">{conversation.bookingCount} booking</span>
                  )}
                  {conversation.escalationCount > 0 && (
                    <span className="ops-tag">{conversation.escalationCount} escalation</span>
                  )}
                  {conversation.bookingCount === 0 && conversation.escalationCount === 0 && "—"}
                </td>
                <td>
                  <Link to={`/dashboard/${businessId}/conversations/${conversation.id}`}>Open</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </StateBlock>
    </section>
  );
}

export function ConversationDetailPage() {
  const { businessId = "", conversationId = "" } = useParams();
  const { can } = useAuth();
  const state = useAsync(
    () => getConversation(businessId, conversationId),
    [businessId, conversationId]
  );

  return (
    <section>
      <header className="ops-page-head">
        <h1>Conversation</h1>
        <Link to={`/dashboard/${businessId}/conversations`}>← All conversations</Link>
      </header>

      <StateBlock loading={state.loading} error={state.error} onRetry={state.reload}>
        {state.data && (
          <>
            <dl className="ops-detail">
              <dt>Caller</dt>
              <dd>{state.data.conversation.callerName ?? "—"}</dd>
              <dt>Channel</dt>
              <dd data-testid="conversation-detail-channel">{CHANNEL_LABELS[state.data.conversation.channel]}</dd>
              <dt>Started</dt>
              <dd>{formatDateTime(state.data.conversation.createdAt)}</dd>
              <dt>Messages</dt>
              <dd>{state.data.conversation.messageCount}</dd>
            </dl>

            {(state.data.bookings.length > 0 || state.data.escalations.length > 0) && (
              <>
                <h2>Linked records</h2>
                <ul className="ops-linked">
                  {state.data.bookings.map((booking) => (
                    <li key={booking.id}>
                      <Link to={`/dashboard/${businessId}/bookings/${booking.id}`}>
                        Booking request — {booking.requestedTime}
                      </Link>
                      <StatusPill status={booking.status} />
                      {/* A one-line indicator, not a second copy of the
                          booking detail: whether the customer was told. */}
                      <span className="ops-note" data-testid={`booking-confirmation-${booking.id}`}>
                        {" "}
                        {confirmationIndicator(booking.confirmation)}
                      </span>
                    </li>
                  ))}
                  {state.data.escalations.map((escalation) => (
                    <li key={escalation.id}>
                      <Link to={`/dashboard/${businessId}/escalations/${escalation.id}`}>
                        Escalation — {escalation.reason}
                      </Link>
                      <StatusPill status={escalation.status} />
                    </li>
                  ))}
                </ul>
              </>
            )}

            <h2>Transcript</h2>
            {state.data.messages.length === 0 ? (
              <p className="ops-state">No messages in this conversation.</p>
            ) : (
              <ol className="ops-transcript">
                {state.data.messages.map((message) => (
                  <li key={message.id} className={`ops-turn ops-turn-${message.sender}`}>
                    <div className="ops-turn-meta">
                      <strong>{message.sender === "caller" ? "Caller" : "Veyra"}</strong>
                      <span>{formatDateTime(message.createdAt)}</span>
                      {message.intent && <span className="ops-tag">{message.intent}</span>}
                      {message.action && message.action !== "none" && (
                        <span className="ops-tag">{message.action}</span>
                      )}
                    </div>
                    <p>{message.text}</p>
                  </li>
                ))}
              </ol>
            )}

            {/* Who the caller is, when Veyra has managed to establish it. */}
            {state.data.conversation.customerContactId && (
              <ContactCard
                businessId={businessId}
                contactId={state.data.conversation.customerContactId}
                conversationId={conversationId}
                canEdit={can(businessId, "operations:write")}
              />
            )}

            {/* Pilot review sits below the transcript, never inside it: the
                record of what the caller experienced stays untouched. */}
            {can(businessId, "pilot:read") && (
              <ConversationReview businessId={businessId} conversationId={conversationId} />
            )}
          </>
        )}
      </StateBlock>
    </section>
  );
}
