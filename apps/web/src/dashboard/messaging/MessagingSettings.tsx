import { useState } from "react";
import type { ChannelHealth, MessagingChannelStatus, MessagingOverview } from "@veyra/shared";
import { getMessagingOverview, updateMessagingSettings } from "../opsClient";
import { StateBlock } from "../components";
import { useAsync } from "../useAsync";

/**
 * SMS and WhatsApp in Veyra Console.
 *
 * The job of this page is to be honest about which of four separate things
 * is missing — the entitlement, the business switch, a provider, or a sender
 * number — rather than showing one vague "not working".
 *
 * Two rules it never breaks: a development provider is never described as
 * live, and a phone number is never shown in full. The server sends the
 * number already masked, so there is nothing here to leak.
 */

const HEALTH_LABEL: Record<ChannelHealth, string> = {
  not_configured: "Not configured",
  configured: "Configured",
  healthy: "Healthy",
  degraded: "Degraded",
  unavailable: "Unavailable"
};

/** Only a proven-healthy channel gets the positive colour. */
const HEALTH_PILL: Record<ChannelHealth, string> = {
  not_configured: "muted",
  configured: "warning",
  healthy: "enabled",
  degraded: "warning",
  unavailable: "warning"
};

function ChannelCard({
  status,
  label,
  busy,
  canManage,
  onToggle
}: {
  status: MessagingChannelStatus;
  label: string;
  busy: boolean;
  canManage: boolean;
  onToggle: () => void;
}) {
  const testId = `messaging-${status.channel}`;

  return (
    <div className="ops-detail-block" data-testid={testId}>
      <div className="ops-plan-head">
        <div>
          <div className="ops-plan-name">{label}</div>
          <p className="ops-note" data-testid={`${testId}-detail`}>
            {status.detail}
          </p>
        </div>
        <span
          className={`ops-pill ops-pill-${HEALTH_PILL[status.health]}`}
          data-testid={`${testId}-health`}
        >
          {HEALTH_LABEL[status.health]}
        </span>
      </div>

      {status.warnings.map((warning) => (
        <p className="ops-note" key={warning} data-testid={`${testId}-warning`}>
          ⚠ {warning}
        </p>
      ))}

      {status.simulated && (
        <p className="ops-note" data-testid={`${testId}-simulated`}>
          Development provider — nothing is delivered to a real handset on this server.
        </p>
      )}

      <dl className="ops-detail">
        <dt>Plan</dt>
        <dd data-testid={`${testId}-entitled`}>
          {status.entitled ? "Included for this business" : `${label} — rollout / integration required`}
        </dd>
        <dt>Provider</dt>
        <dd data-testid={`${testId}-provider`}>{status.provider ?? "None configured"}</dd>
        <dt>Sender</dt>
        <dd data-testid={`${testId}-sender`}>{status.sender ?? "Not set"}</dd>
        <dt>Inbound</dt>
        <dd data-testid={`${testId}-inbound`}>
          {/* Outbound working says nothing about inbound: the two fail
              independently, so they are reported separately. */}
          {status.inbound.configured && status.inbound.routed ? "Configured" : "Not receiving"}
          <span className="ops-note"> · {status.inbound.detail}</span>
        </dd>
      </dl>

      <div className="ops-actions">
        <button
          type="button"
          disabled={busy || !canManage || !status.entitled}
          data-testid={`${testId}-toggle`}
          onClick={onToggle}
        >
          {status.enabled ? `Switch ${label} off` : `Switch ${label} on`}
        </button>
      </div>
    </div>
  );
}

export function MessagingSettings({ businessId }: { businessId: string }) {
  const state = useAsync(() => getMessagingOverview(businessId), [businessId]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const data: MessagingOverview | null = state.data ?? null;

  async function save(patch: Record<string, unknown>, message: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await updateMessagingSettings(businessId, patch);
      setNotice(message);
      state.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ops-panel" data-testid="messaging-settings" id="messaging">
      <h2>Messaging</h2>

      <StateBlock loading={state.loading && !data} error={state.error} onRetry={state.reload}>
        {data && (
          <>
            <p className="ops-note">
              SMS and WhatsApp are channels into the same Veyra receptionist — the same business information, the
              same booking rules, the same escalation.
            </p>

            <ChannelCard
              status={data.sms}
              label="SMS"
              busy={busy}
              canManage={data.canManage}
              onToggle={() =>
                save(
                  { smsEnabled: !data.sms.enabled },
                  data.sms.enabled ? "SMS switched off." : "SMS switched on."
                )
              }
            />

            <ChannelCard
              status={data.whatsapp}
              label="WhatsApp"
              busy={busy}
              canManage={data.canManage}
              onToggle={() =>
                save(
                  { whatsappEnabled: !data.whatsapp.enabled },
                  data.whatsapp.enabled ? "WhatsApp switched off." : "WhatsApp switched on."
                )
              }
            />

            <dl className="ops-detail">
              <dt>Messaging customers</dt>
              <dd data-testid="messaging-customer-enabled">
                {data.customerMessagingEnabled ? "On" : "Off — only your team is messaged"}
              </dd>
              <dt>Messaging your team</dt>
              <dd data-testid="messaging-operator-enabled">
                {data.operatorMessagingEnabled ? "On" : "Off"}
              </dd>
              <dt>Default country</dt>
              <dd data-testid="messaging-default-country">
                {data.defaultCountry ?? "Not set"}
                <span className="ops-note">
                  {" "}
                  · used to explain how to write a number, never to guess one
                </span>
              </dd>
              <dt>Messages sent</dt>
              <dd data-testid="messaging-usage">
                {/* Nothing sent yet is "Not available", not a measured zero. */}
                SMS: {data.usage.smsMessages ?? "Not available"} · WhatsApp:{" "}
                {data.usage.whatsappMessages ?? "Not available"}
              </dd>
            </dl>

            {data.canManage && (
              <div className="ops-actions">
                <button
                  type="button"
                  disabled={busy}
                  data-testid="messaging-customer-toggle"
                  onClick={() =>
                    save(
                      { customerMessagingEnabled: !data.customerMessagingEnabled },
                      data.customerMessagingEnabled
                        ? "Veyra will no longer message customers."
                        : "Veyra can message customers."
                    )
                  }
                >
                  {data.customerMessagingEnabled ? "Stop messaging customers" : "Allow messaging customers"}
                </button>
              </div>
            )}

            {notice && <p className="ops-note" data-testid="messaging-notice">{notice}</p>}
            {error && <p className="ops-error" data-testid="messaging-error">{error}</p>}
          </>
        )}
      </StateBlock>
    </section>
  );
}
