import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ENTITLEMENT_DEFINITIONS,
  VOICE_ROLLOUT_NOTE,
  type EntitlementGroup,
  type LimitValue,
  type OpsPlanPrice,
  type OpsSubscription,
  PLAN_CATALOG,
  PLAN_ORDER,
  type PlanCode
} from "@veyra/shared";
import {
  ApiError,
  cancelPlan,
  getSubscription,
  openBillingPortal,
  redirectTo,
  requestPlanChange,
  resumePlan,
  startCheckout
} from "./opsClient";
import { StateBlock, formatDateTime } from "./components";
import { useAsync } from "./useAsync";

/**
 * Plan & billing in Veyra Console.
 *
 * Everything shown comes from the API: the plan catalog the backend enforces,
 * the prices the server is configured with, and the billing actions the
 * server says it will accept right now. Buttons only appear for those actions.
 *
 * Nothing here changes a plan. Checkout and plan changes happen at the payment
 * provider; the plan changes once the provider's webhook confirms it, so after
 * any action this page waits and refreshes rather than assuming success.
 */

const STATUS_LABELS: Record<OpsSubscription["status"], string> = {
  trialing: "Trial",
  active: "Active",
  past_due: "Payment overdue",
  cancelled: "Cancelled",
  expired: "Expired",
  none: "No subscription"
};

const GROUP_LABELS: Record<EntitlementGroup, string> = {
  answer: "Answer",
  act: "Act",
  channels: "Channels",
  speak: "Speak"
};

const POLL_INTERVAL_MS = 2000;
const POLL_ATTEMPTS = 15;

export function formatLimit(limit: LimitValue): string {
  return limit.kind === "unlimited" ? "Unlimited" : String(limit.value);
}

export function planLabel(code: PlanCode): string {
  return `${PLAN_CATALOG[code].name} — ${PLAN_CATALOG[code].tagline}`;
}

function priceText(price: OpsPlanPrice | undefined): string {
  return price ? `${price.displayAmount}/${price.interval}` : "";
}

function dateOnly(value: string | null): string {
  if (!value) return "the end of the billing period";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

type Notice = { tone: "info" | "success" | "warning"; text: string } | null;

export function SubscriptionSettings({ businessId }: { businessId: string }) {
  const state = useAsync(() => getSubscription(businessId), [businessId]);
  // Silent refreshes while waiting for the provider, without a loading flash.
  const [fresh, setFresh] = useState<OpsSubscription | null>(null);
  const data = fresh ?? state.data;

  const [params, setParams] = useSearchParams();
  const [comparing, setComparing] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<{ kind: "cancel" } | { kind: "change"; plan: PlanCode } | null>(null);
  const polling = useRef<number | null>(null);

  useEffect(() => () => {
    if (polling.current !== null) window.clearTimeout(polling.current);
  }, []);

  /** Re-reads the subscription until `done` holds or we give up. */
  const waitFor = useCallback(
    (done: (s: OpsSubscription) => boolean, onDone: (s: OpsSubscription) => void, onTimeout: () => void) => {
      let attempts = 0;
      const tick = async () => {
        attempts += 1;
        try {
          const latest = await getSubscription(businessId);
          setFresh(latest);
          if (done(latest)) {
            onDone(latest);
            return;
          }
        } catch {
          // A failed refresh is retried like an unconfirmed one.
        }
        if (attempts >= POLL_ATTEMPTS) {
          onTimeout();
          return;
        }
        polling.current = window.setTimeout(tick, POLL_INTERVAL_MS);
      };
      polling.current = window.setTimeout(tick, 0);
    },
    [businessId]
  );

  // Coming back from the provider's checkout or portal.
  const handledReturn = useRef(false);
  useEffect(() => {
    const result = params.get("billing");
    if (!result || handledReturn.current) return;
    handledReturn.current = true;
    const next = new URLSearchParams(params);
    next.delete("billing");
    setParams(next, { replace: true });

    if (result === "cancelled") {
      setNotice({ tone: "info", text: "Checkout cancelled. Nothing was charged and your plan hasn't changed." });
    } else if (result === "success") {
      // The redirect proves nothing; the provider's webhook does.
      setNotice({ tone: "info", text: "Payment received. We're confirming your subscription." });
      waitFor(
        (latest) => latest.billing.pendingCheckout === null,
        (latest) =>
          setNotice({
            tone: "success",
            text: `Subscription confirmed. You're on ${latest.plan ? planLabel(latest.plan.code) : "your new plan"}.`
          }),
        () =>
          setNotice({
            tone: "warning",
            text: "We haven't had confirmation from the payment provider yet. Your plan will update as soon as it arrives — check back in a few minutes."
          })
      );
    } else if (result === "portal") {
      setNotice({ tone: "info", text: "Back from billing. Any changes appear here once the payment provider confirms them." });
      waitFor(() => false, () => undefined, () => undefined);
    }
  }, [params, setParams, waitFor]);

  async function act(run: () => Promise<{ message: string }>, done: (s: OpsSubscription) => boolean) {
    setBusy(true);
    setConfirming(null);
    try {
      const result = await run();
      setNotice({ tone: "info", text: result.message });
      waitFor(
        done,
        () => setNotice({ tone: "success", text: "Confirmed by the payment provider." }),
        () => setNotice({ tone: "info", text: `${result.message} This page updates once it's confirmed.` })
      );
    } catch (err) {
      setNotice({ tone: "warning", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  async function goTo(run: () => Promise<{ url: string }>) {
    setBusy(true);
    try {
      const { url } = await run();
      redirectTo(url);
    } catch (err) {
      setNotice({ tone: "warning", text: errorText(err) });
      setBusy(false);
    }
  }

  return (
    <section className="ops-panel" data-testid="subscription-settings" id="plan">
      <h2>Plan &amp; billing</h2>

      <StateBlock loading={state.loading && !data} error={data ? null : state.error} onRetry={state.reload}>
        {data && (
          <>
            {notice && (
              <p className={`ops-banner ops-banner-${notice.tone}`} role="status" data-testid="billing-notice">
                {notice.text}
              </p>
            )}

            <div className="ops-plan-head">
              <div>
                <div className="ops-plan-name" data-testid="subscription-plan">
                  {data.plan ? planLabel(data.plan.code) : "No plan"}
                </div>
                {data.plan && <p className="ops-note">{data.plan.description}</p>}
              </div>
              <span
                className={`ops-pill ops-pill-${data.degraded || data.billingAttention ? "warning" : "enabled"}`}
                data-testid="subscription-status"
              >
                {STATUS_LABELS[data.status]}
              </span>
            </div>

            <BillingBanners subscription={data} />

            <dl className="ops-detail">
              <dt>Started</dt>
              <dd>{formatDateTime(data.startsAt)}</dd>
              {data.billing.billingInterval && (
                <>
                  <dt>Billed</dt>
                  <dd data-testid="billing-interval">{data.billing.billingInterval === "year" ? "Yearly" : "Monthly"}</dd>
                </>
              )}
              {data.currentPeriodEnd && (
                <>
                  <dt>{data.billing.cancelAtPeriodEnd ? "Paid plan ends" : data.billing.hasPaidSubscription ? "Renews" : "Current period ends"}</dt>
                  <dd data-testid="billing-period-end">{dateOnly(data.currentPeriodEnd)}</dd>
                </>
              )}
              {data.trialEndsAt && (
                <>
                  <dt>Trial ends</dt>
                  <dd>{formatDateTime(data.trialEndsAt)}</dd>
                </>
              )}
            </dl>

            <h3>Usage</h3>
            <table className="ops-table" data-testid="subscription-usage">
              <tbody>
                {data.limits.map((limit) => (
                  <tr key={limit.key}>
                    <td>{limit.label}</td>
                    <td>
                      {limit.used === null ? "—" : limit.used} / {formatLimit(limit.limit)}
                      {limit.enforcement === "planned" && <span className="ops-note"> · not tracked yet</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3>Included</h3>
            <ul className="ops-feature-list" data-testid="subscription-included">
              {data.entitlements
                .filter((entry) => entry.included)
                .map((entry) => (
                  <li key={entry.key}>
                    {entry.label}
                    {!entry.implemented && <span className="ops-note"> · coming soon</span>}
                  </li>
                ))}
            </ul>

            <h3>Not included</h3>
            <ul className="ops-feature-list ops-feature-locked" data-testid="subscription-locked">
              {data.entitlements
                .filter((entry) => !entry.included)
                .map((entry) => (
                  <li key={entry.key}>
                    <span aria-hidden="true">🔒 </span>
                    {entry.label}
                    <span className="ops-note">
                      {" "}
                      ·{" "}
                      {!entry.requiredPlan
                        ? "Not on a plan yet"
                        : entry.implemented
                          ? `Available on ${PLAN_CATALOG[entry.requiredPlan].name}`
                          : entry.group === "speak" && entry.key.startsWith("voice")
                            ? // Built, but a phone line still has to be connected and
                              // proven before anyone should read this as working.
                              `Included with ${PLAN_CATALOG[entry.requiredPlan].name} — ${VOICE_ROLLOUT_NOTE}`
                            : `Included with ${PLAN_CATALOG[entry.requiredPlan].name} — Coming soon`}
                    </span>
                  </li>
                ))}
            </ul>

            <BillingActions
              subscription={data}
              busy={busy}
              comparing={comparing}
              confirming={confirming}
              onCompare={() => setComparing((open) => !open)}
              onConfirm={setConfirming}
              onCheckout={(plan) => goTo(() => startCheckout(businessId, plan))}
              onPortal={() => goTo(() => openBillingPortal(businessId))}
              onChange={(plan) =>
                act(
                  () => requestPlanChange(businessId, plan),
                  (latest) => latest.plan?.code === plan || latest.billing.scheduledPlan === plan
                )
              }
              onCancel={() => act(() => cancelPlan(businessId), (latest) => latest.billing.cancelAtPeriodEnd)}
              onResume={() =>
                act(
                  () => resumePlan(businessId),
                  (latest) => !latest.billing.cancelAtPeriodEnd && latest.billing.scheduledPlan === null
                )
              }
              onUnavailable={() =>
                setNotice({
                  tone: "info",
                  text: data.billing.available
                    ? "Only the business owner can buy or change the plan."
                    : "Online billing isn't set up on this server yet. For now, plan changes are arranged with the Veyra team."
                })
              }
            />

            {comparing && <PlanComparison subscription={data} />}
          </>
        )}
      </StateBlock>
    </section>
  );
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "BILLING_USE_PORTAL") return `${err.message} Use Manage billing.`;
    return err.message;
  }
  return "Something went wrong. Nothing was changed.";
}

function BillingBanners({ subscription }: { subscription: OpsSubscription }) {
  const { billing } = subscription;
  const planName = subscription.plan ? PLAN_CATALOG[subscription.plan.code].name : "Your plan";
  return (
    <>
      {billing.simulated && (
        <p className="ops-note" data-testid="billing-simulated">
          Development billing — no real payments are taken on this server.
        </p>
      )}
      {subscription.degraded && (
        <p className="ops-banner" data-testid="subscription-degraded">
          Paid features are paused. Veyra keeps answering callers and collecting booking requests so nobody is turned
          away.
        </p>
      )}
      {!subscription.degraded && subscription.billingAttention && (
        <p className="ops-banner" data-testid="subscription-attention">
          Your last payment didn't go through. Everything keeps working for now — update your payment method in
          Manage billing.
        </p>
      )}
      {billing.cancelAtPeriodEnd && (
        <p className="ops-banner" data-testid="billing-cancel-scheduled">
          {planName} ends on {dateOnly(billing.scheduledChangeAt ?? subscription.currentPeriodEnd)}.
          {billing.scheduledPlan ? ` After that you'll be on ${PLAN_CATALOG[billing.scheduledPlan].name}.` : ""} Your
          business data, services, bookings and team are kept.
        </p>
      )}
      {!billing.cancelAtPeriodEnd && billing.scheduledPlan && (
        <p className="ops-banner" data-testid="billing-change-scheduled">
          Changes to {PLAN_CATALOG[billing.scheduledPlan].name} on {dateOnly(billing.scheduledChangeAt)}. Until then
          you keep {planName}.
        </p>
      )}
      {billing.overLimit.map((over) => (
        <p className="ops-banner" key={over.key} data-testid="billing-over-limit">
          {over.label}: {over.used} of {over.allowed} on this plan. Nobody has been removed, but you can't add more
          until you're within the limit or upgrade.
        </p>
      ))}
    </>
  );
}

function BillingActions(props: {
  subscription: OpsSubscription;
  busy: boolean;
  comparing: boolean;
  confirming: { kind: "cancel" } | { kind: "change"; plan: PlanCode } | null;
  onCompare: () => void;
  onConfirm: (value: { kind: "cancel" } | { kind: "change"; plan: PlanCode } | null) => void;
  onCheckout: (plan: PlanCode) => void;
  onPortal: () => void;
  onChange: (plan: PlanCode) => void;
  onCancel: () => void;
  onResume: () => void;
  onUnavailable: () => void;
}) {
  const { subscription, busy, confirming } = props;
  const { billing } = subscription;
  const { actions } = billing;
  const current = subscription.plan?.code ?? null;
  const priceFor = (plan: PlanCode) => billing.prices.find((price) => price.plan === plan);
  const rank = (plan: PlanCode) => PLAN_ORDER.indexOf(plan);
  const periodEnd = dateOnly(subscription.currentPeriodEnd);
  const anyAction =
    actions.checkout.length > 0 || actions.changePlan.length > 0 || actions.portal || actions.cancel || actions.resume;

  return (
    <>
      <div className="ops-actions" data-testid="billing-actions">
        <button type="button" onClick={props.onCompare}>
          {props.comparing ? "Hide plan comparison" : "Compare plans"}
        </button>

        {actions.checkout.map((plan) => (
          <button
            type="button"
            key={plan}
            disabled={busy}
            onClick={() => props.onCheckout(plan)}
            data-testid={`billing-checkout-${plan}`}
          >
            Upgrade to {PLAN_CATALOG[plan].name}
            {priceFor(plan) ? ` — ${priceText(priceFor(plan))}` : ""}
          </button>
        ))}

        {actions.changePlan.map((plan) => (
          <button
            type="button"
            key={plan}
            disabled={busy}
            onClick={() => (current && rank(plan) > rank(current) ? props.onChange(plan) : props.onConfirm({ kind: "change", plan }))}
            data-testid={`billing-change-${plan}`}
          >
            {current && rank(plan) > rank(current) ? "Upgrade" : "Change"} to {PLAN_CATALOG[plan].name}
          </button>
        ))}

        {actions.resume && (
          <button type="button" disabled={busy} onClick={props.onResume} data-testid="billing-resume">
            Keep {current ? PLAN_CATALOG[current].name : "current plan"}
          </button>
        )}

        {actions.portal && (
          <button type="button" disabled={busy} onClick={props.onPortal} data-testid="billing-portal">
            Manage billing
          </button>
        )}

        {actions.cancel && (
          <button type="button" disabled={busy} onClick={() => props.onConfirm({ kind: "cancel" })} data-testid="billing-cancel">
            Cancel plan
          </button>
        )}

        {!anyAction && current !== "MAX" && (
          <button type="button" onClick={props.onUnavailable} data-testid="subscription-upgrade">
            Upgrade
          </button>
        )}
      </div>

      {confirming && (
        <div className="ops-banner" data-testid="billing-confirm">
          <p>
            {confirming.kind === "cancel"
              ? `Your paid plan stays active until ${periodEnd}. After that the business moves to Starter: calendar booking switches off, and every setting, booking and team member is kept.`
              : `You keep ${current ? PLAN_CATALOG[current].name : "your plan"} until ${periodEnd}, then move to ${PLAN_CATALOG[confirming.plan].name}. Nothing is deleted.`}
          </p>
          <div className="ops-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => (confirming.kind === "cancel" ? props.onCancel() : props.onChange(confirming.plan))}
              data-testid="billing-confirm-yes"
            >
              {confirming.kind === "cancel" ? "Cancel at period end" : `Change to ${PLAN_CATALOG[confirming.plan].name}`}
            </button>
            <button type="button" onClick={() => props.onConfirm(null)}>
              Never mind
            </button>
          </div>
        </div>
      )}

      {billing.pendingCheckout && (
        <p className="ops-note" data-testid="billing-pending-checkout">
          A checkout for {PLAN_CATALOG[billing.pendingCheckout.targetPlan].name} was started and hasn't been confirmed by
          the payment provider.
        </p>
      )}
      {billing.prices.some((price) => !price.final) && (
        <p className="ops-note" data-testid="billing-prices-provisional">
          Prices shown are examples and not final.
        </p>
      )}
    </>
  );
}

/**
 * Starter — Answer / Pro — Act / Max — Speak, from the plans the API returned,
 * with prices only when the server has them configured.
 */
export function PlanComparison({ subscription }: { subscription: OpsSubscription }) {
  const groups: EntitlementGroup[] = ["answer", "act", "channels", "speak"];
  const prices = subscription.billing.prices;

  return (
    <div className="ops-table-scroll" data-testid="plan-comparison">
      <table className="ops-table ops-plan-table">
        <thead>
          <tr>
            <th />
            {subscription.plans.map((plan) => (
              <th key={plan.code} data-current={plan.code === subscription.plan?.code || undefined}>
                <div>{plan.name}</div>
                <div className="ops-note">{plan.tagline}</div>
                {prices.length > 0 && (
                  <div className="ops-note" data-testid={`plan-price-${plan.code}`}>
                    {priceText(prices.find((price) => price.plan === plan.code)) || "No price set"}
                  </div>
                )}
                {plan.code === subscription.plan?.code && <div className="ops-note">Current plan</div>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <PlanGroupRows key={group} group={group} subscription={subscription} />
          ))}
          <tr>
            <th scope="row" colSpan={subscription.plans.length + 1}>
              Limits
            </th>
          </tr>
          {subscription.limits.map((limit) => (
            <tr key={limit.key}>
              <td>{limit.label}</td>
              {subscription.plans.map((plan) => (
                <td key={plan.code}>{formatLimit(plan.limits[limit.key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PlanGroupRows({ group, subscription }: { group: EntitlementGroup; subscription: OpsSubscription }) {
  const definitions = ENTITLEMENT_DEFINITIONS.filter((definition) => definition.group === group);
  return (
    <>
      <tr>
        <th scope="row" colSpan={subscription.plans.length + 1}>
          {GROUP_LABELS[group]}
        </th>
      </tr>
      {definitions.map((definition) => (
        <tr key={definition.key}>
          <td>
            {definition.label}
            {!definition.implemented && <span className="ops-note"> · coming soon</span>}
          </td>
          {subscription.plans.map((plan) => (
            <td key={plan.code}>{plan.entitlements.includes(definition.key) ? "✓" : "—"}</td>
          ))}
        </tr>
      ))}
    </>
  );
}
