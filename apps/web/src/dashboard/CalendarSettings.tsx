import { useState } from "react";
import { type OpsCalendarOption, type OpsCalendarSettings, PLAN_CATALOG } from "@veyra/shared";
import {
  disconnectCalendar,
  getCalendarSettings,
  listCalendarOptions,
  selectCalendar,
  startCalendarConnection
} from "./opsClient";
import { StateBlock } from "./components";
import { useAsync } from "./useAsync";

/**
 * Calendar settings in Veyra Console.
 *
 * Shows what is actually true: the capability, the connection's health, which
 * calendar is selected and the business timezone. Tokens are never sent to the
 * browser, so there is nothing here to leak. Connection actions only appear for
 * operators the server says may use them — and the server re-checks anyway.
 */

const DAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function minutesToTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const suffix = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${String(mins).padStart(2, "0")} ${suffix}`;
}

function connectionLabel(settings: OpsCalendarSettings): {
  text: string;
  tone: "enabled" | "disabled" | "warning";
} {
  if (!settings.connection) return { text: "Not connected", tone: "disabled" };
  switch (settings.connection.status) {
    case "connected":
      return settings.connection.selectedCalendarId
        ? { text: "Connected", tone: "enabled" }
        : { text: "Connected — no calendar selected", tone: "warning" };
    case "needs_reauth":
      return { text: "Needs re-authentication", tone: "warning" };
    case "error":
      return { text: "Error", tone: "warning" };
    default:
      return { text: "Not connected", tone: "disabled" };
  }
}

export function CalendarSettings({ businessId }: { businessId: string }) {
  const state = useAsync(() => getCalendarSettings(businessId), [businessId]);
  const [settings, setSettings] = useState<OpsCalendarSettings | null>(null);
  const [options, setOptions] = useState<OpsCalendarOption[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upgradeNotice, setUpgradeNotice] = useState(false);

  const current = settings ?? state.data ?? null;

  async function run(action: () => Promise<OpsCalendarSettings | void>) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result) setSettings(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function connect() {
    await run(async () => {
      const { authorizationUrl } = await startCalendarConnection(businessId);
      // The consent screen is on the provider's domain; Veyra never sees the
      // account password, and the tokens come back to the server, not here.
      window.location.assign(authorizationUrl);
    });
  }

  async function loadOptions() {
    await run(async () => {
      const { calendars } = await listCalendarOptions(businessId);
      setOptions(calendars);
    });
  }

  return (
    <section className="ops-panel" data-testid="calendar-settings">
      <h2>Calendar</h2>

      <StateBlock loading={state.loading} error={state.error} onRetry={state.reload}>
        {current && (
          <>
            <table className="ops-table">
              <tbody>
                <tr>
                  <th scope="row">Calendar booking capability</th>
                  <td>
                    <span
                      className={`ops-pill ops-pill-${current.calendarBookingEnabled ? "enabled" : "disabled"}`}
                      data-testid="calendar-capability"
                    >
                      {current.calendarBookingEnabled ? "Enabled" : "Disabled"}
                    </span>
                  </td>
                </tr>
                <tr>
                  <th scope="row">Connection</th>
                  <td>
                    <span
                      className={`ops-pill ops-pill-${connectionLabel(current).tone}`}
                      data-testid="calendar-connection-status"
                    >
                      {connectionLabel(current).text}
                    </span>
                    {current.connection?.statusDetail && (
                      <span className="ops-note"> {current.connection.statusDetail}</span>
                    )}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Provider</th>
                  <td data-testid="calendar-provider">{current.connection?.provider ?? "—"}</td>
                </tr>
                <tr>
                  <th scope="row">Selected calendar</th>
                  <td data-testid="calendar-selected">
                    {current.connection?.selectedCalendarName ?? "None selected"}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Business timezone</th>
                  <td data-testid="calendar-timezone">{current.timezone}</td>
                </tr>
                <tr>
                  <th scope="row">Live booking</th>
                  <td data-testid="calendar-live">
                    {current.live ? "Yes — Veyra books real appointments" : "No — booking requests only"}
                  </td>
                </tr>
              </tbody>
            </table>

            {!current.live && (
              <p className="ops-note" data-testid="calendar-request-only-note">
                Veyra collects booking requests for staff to review. Live booking needs the
                calendar feature in your plan, the calendar capability switched on, and a healthy
                connection with a calendar selected.
              </p>
            )}

            <h3>Booking rules</h3>
            <ul className="ops-note" data-testid="calendar-rules">
              <li>Minimum notice: {current.bookingRules.minNoticeMinutes} minutes</li>
              <li>Booked up to {current.bookingRules.maxHorizonDays} days ahead</li>
              <li>
                Buffers: {current.bookingRules.bufferBeforeMinutes} min before,{" "}
                {current.bookingRules.bufferAfterMinutes} min after
              </li>
              <li>Slots offered every {current.bookingRules.slotIntervalMinutes} minutes</li>
              <li>
                Working hours:{" "}
                {current.bookingRules.hours.length === 0
                  ? "none configured"
                  : current.bookingRules.hours
                      .map(
                        (hour) =>
                          `${DAY_NAMES[hour.dayOfWeek]} ${minutesToTime(hour.opensMinute)}–${minutesToTime(hour.closesMinute)}`
                      )
                      .join(", ")}
              </li>
            </ul>

            <h3>Service durations</h3>
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Service</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {current.services.map((service) => (
                  <tr key={service.id}>
                    <td>{service.name}</td>
                    <td>
                      {service.durationMinutes
                        ? `${service.durationMinutes} minutes`
                        : "Not set — cannot be booked live"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {!current.entitled ? (
              // Not in the plan: shown as a locked feature rather than hidden.
              // The server enforces this regardless of what this page renders.
              <div className="ops-locked" data-testid="calendar-locked">
                <div className="ops-locked-title">
                  <span aria-hidden="true">🔒 </span>Google Calendar
                </div>
                <p className="ops-note">Live availability and automatic booking.</p>
                <p className="ops-note">
                  Available on {current.requiredPlan ? PLAN_CATALOG[current.requiredPlan].name : "a higher plan"}.
                  {current.connection &&
                    " Your existing connection is kept and works again as soon as the plan includes it."}
                </p>
                <div className="ops-actions">
                  <button type="button" onClick={() => setUpgradeNotice(true)} data-testid="calendar-upgrade">
                    Upgrade
                  </button>
                  {current.canManage && current.connection && (
                    <button
                      type="button"
                      onClick={() => run(() => disconnectCalendar(businessId).then(setSettings))}
                      disabled={busy}
                    >
                      Disconnect
                    </button>
                  )}
                </div>
                {upgradeNotice && (
                  <p className="ops-note" role="status" data-testid="calendar-upgrade-notice">
                    Plans are bought and changed in <a href="#plan">Plan &amp; billing</a> by the business
                    owner. Once the payment is confirmed, this connection works without reconnecting.
                  </p>
                )}
              </div>
            ) : current.canManage ? (
              <div className="ops-actions" data-testid="calendar-actions">
                <button type="button" onClick={connect} disabled={busy}>
                  {current.connection ? "Reconnect" : "Connect Google Calendar"}
                </button>
                {current.connection && (
                  <>
                    <button type="button" onClick={loadOptions} disabled={busy}>
                      Change selected calendar
                    </button>
                    <button
                      type="button"
                      onClick={() => run(() => disconnectCalendar(businessId).then(setSettings))}
                      disabled={busy}
                    >
                      Disconnect
                    </button>
                  </>
                )}
              </div>
            ) : (
              <p className="ops-note" data-testid="calendar-readonly-note">
                Only an owner or admin can change the calendar connection.
              </p>
            )}

            {options && (
              <ul className="ops-note" data-testid="calendar-options">
                {options.map((option) => (
                  <li key={option.id}>
                    {option.name}
                    {option.primary ? " (primary)" : ""}{" "}
                    <button
                      type="button"
                      disabled={busy || !option.writable}
                      onClick={() =>
                        run(async () => {
                          const updated = await selectCalendar(businessId, option.id);
                          setOptions(null);
                          return updated;
                        })
                      }
                    >
                      {option.writable ? "Use this calendar" : "Read-only"}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {error && (
              <p className="ops-error" role="alert" data-testid="calendar-error">
                {error}
              </p>
            )}
          </>
        )}
      </StateBlock>
    </section>
  );
}
