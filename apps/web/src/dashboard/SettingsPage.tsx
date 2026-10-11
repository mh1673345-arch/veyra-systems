import { useParams } from "react-router-dom";
import type { CapabilityName } from "@veyra/shared";
import { getCapabilities } from "./opsClient";
import { useAsync } from "./useAsync";
import { StateBlock } from "./components";
import { CalendarSettings } from "./CalendarSettings";
import { VoiceSettings } from "./voice/VoiceSettings";
import { MessagingSettings } from "./messaging/MessagingSettings";
import { SubscriptionSettings } from "./SubscriptionSettings";
import { useAuth } from "./AuthContext";

const CAPABILITY_LABELS: Record<CapabilityName, string> = {
  booking_requests: "Booking requests",
  calendar_booking: "Calendar booking",
  human_escalation: "Human escalation",
  whatsapp: "WhatsApp",
  sms: "SMS",
  email_notifications: "Email notifications"
};

const CAPABILITY_ORDER: CapabilityName[] = [
  "booking_requests",
  "calendar_booking",
  "human_escalation",
  "whatsapp",
  "sms",
  "email_notifications"
];

export function SettingsPage() {
  const { businessId = "" } = useParams();
  const state = useAsync(() => getCapabilities(businessId), [businessId]);
  const { can } = useAuth();

  return (
    <section>
      <header className="ops-page-head">
        <h1>Business Settings</h1>
      </header>

      <StateBlock loading={state.loading} error={state.error} onRetry={state.reload}>
        {state.data && (
          <>
            <p className="ops-note">
              Capabilities are read-only here. They are configured server-side and control what
              Veyra is allowed to offer callers — the dashboard cannot change them.
            </p>

            <table className="ops-table">
              <thead>
                <tr>
                  <th>Capability</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {CAPABILITY_ORDER.map((name) => {
                  const enabled = state.data!.capabilities[name];
                  return (
                    <tr key={name}>
                      <td>{CAPABILITY_LABELS[name]}</td>
                      <td>
                        <span
                          className={`ops-pill ops-pill-${enabled ? "enabled" : "disabled"}`}
                          data-testid={`capability-${name}`}
                        >
                          {enabled ? "Enabled" : "Disabled"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </StateBlock>

      {/* Plan details are for owners and admins; the server enforces this too. */}
      {can(businessId, "subscription:read") && <SubscriptionSettings businessId={businessId} />}

      <CalendarSettings businessId={businessId} />

      {/* Voice is shown to everyone who can see settings: locked plans see it
          as a Max feature rather than not knowing it exists. */}
      <VoiceSettings businessId={businessId} />
      <MessagingSettings businessId={businessId} />
    </section>
  );
}
