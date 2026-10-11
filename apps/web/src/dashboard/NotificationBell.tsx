import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { OpsNotification } from "@veyra/shared";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead
} from "./opsClient";
import { formatDateTime } from "./components";

/** How often the bell re-checks. No websockets here — polling is honest and simple. */
const POLL_MS = 30_000;

function linkFor(businessId: string, notification: OpsNotification): string | null {
  if (!notification.linkEntity || !notification.linkEntityId) return null;
  const segment =
    notification.linkEntity === "booking"
      ? "bookings"
      : notification.linkEntity === "escalation"
        ? "escalations"
        : "conversations";
  return `/dashboard/${businessId}/${segment}/${notification.linkEntityId}`;
}

export function NotificationBell() {
  const { businessId = "" } = useParams();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<OpsNotification[]>([]);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  async function refresh() {
    if (!businessId) return;
    try {
      const data = await listNotifications(businessId);
      setUnread(data.unreadCount);
      setItems(data.notifications);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load notifications");
    }
  }

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId]);

  // Close when clicking outside the panel.
  useEffect(() => {
    if (!open) return;
    function onClick(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  async function handleOpenItem(notification: OpsNotification) {
    if (!notification.read) {
      try {
        await markNotificationRead(businessId, notification.id);
        await refresh();
      } catch {
        // Failing to mark read shouldn't block navigation.
      }
    }
    setOpen(false);
  }

  return (
    <div className="ops-bell" ref={containerRef}>
      <button
        type="button"
        className="ops-bell-button"
        onClick={() => setOpen((value) => !value)}
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ""}`}
      >
        Notifications
        {unread > 0 && <span className="ops-bell-count">{unread}</span>}
      </button>

      {open && (
        <div className="ops-bell-panel">
          <div className="ops-bell-head">
            <strong>Notifications</strong>
            {unread > 0 && (
              <button
                type="button"
                className="ops-linkish"
                onClick={async () => {
                  await markAllNotificationsRead(businessId);
                  await refresh();
                }}
              >
                Mark all read
              </button>
            )}
          </div>

          {error && <p className="ops-state ops-state-error">{error}</p>}

          {!error && items.length === 0 && <p className="ops-state">Nothing yet.</p>}

          <ul className="ops-bell-list">
            {items.map((notification) => {
              const href = linkFor(businessId, notification);
              const content = (
                <>
                  <span className="ops-bell-subject">
                    {!notification.read && <span className="ops-bell-dot" aria-hidden="true" />}
                    {notification.subject}
                  </span>
                  <span className="ops-bell-body">{notification.body}</span>
                  <span className="ops-activity-time">{formatDateTime(notification.createdAt)}</span>
                </>
              );

              return (
                <li key={notification.id} className={notification.read ? "" : "ops-bell-unread"}>
                  {href ? (
                    <Link to={href} onClick={() => handleOpenItem(notification)}>
                      {content}
                    </Link>
                  ) : (
                    <button type="button" onClick={() => handleOpenItem(notification)}>
                      {content}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
