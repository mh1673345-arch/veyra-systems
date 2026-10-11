import { PLAN_ORDER, type PlanCode } from "@veyra/shared";

/**
 * The single price configuration.
 *
 * The plan catalog in @veyra/shared defines *what* each plan includes; this
 * file says what a plan costs and which provider price charges it. Price ids
 * and amounts come from the environment only — nothing here is a real price:
 *
 *   VEYRA_BILLING_<PLAN>_PRICE_ID   provider price id (e.g. price_123)
 *   VEYRA_BILLING_<PLAN>_AMOUNT     amount in minor units (e.g. 4900)
 *   VEYRA_BILLING_<PLAN>_CURRENCY   ISO code, default usd
 *   VEYRA_BILLING_<PLAN>_INTERVAL   month | year, default month
 *   VEYRA_BILLING_PRICES_FINAL      "true" once pricing is approved
 *   VEYRA_BILLING_TRIAL_DAYS        optional; no trial is offered unless set
 *
 * A plan with no price configured is not purchasable. Starter has no price by
 * default: it is the plan a business is on without paying.
 *
 * The development billing provider gets clearly-labelled example prices so the
 * flow can be exercised; they are never used by a real provider.
 */

export interface PlanPrice {
  plan: PlanCode;
  providerPriceId: string;
  currency: string;
  interval: "month" | "year";
  amountMinor: number;
  /** Pre-formatted for display, e.g. "$49.00". */
  displayAmount: string;
  /** False until someone has approved real pricing. */
  final: boolean;
}

const EXAMPLE_DEV_PRICES: Partial<Record<PlanCode, { amountMinor: number }>> = {
  PRO: { amountMinor: 4900 },
  MAX: { amountMinor: 14900 }
};

function format(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(
      amountMinor / 100
    );
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

export function configuredPrices(
  providerName: string | null,
  env: NodeJS.ProcessEnv = process.env
): PlanPrice[] {
  const final = env.VEYRA_BILLING_PRICES_FINAL === "true";
  const prices: PlanPrice[] = [];

  for (const plan of PLAN_ORDER) {
    const priceId = env[`VEYRA_BILLING_${plan}_PRICE_ID`];
    const amount = Number(env[`VEYRA_BILLING_${plan}_AMOUNT`]);
    const currency = (env[`VEYRA_BILLING_${plan}_CURRENCY`] ?? "usd").toLowerCase();
    const interval = env[`VEYRA_BILLING_${plan}_INTERVAL`] === "year" ? "year" : "month";

    if (priceId && Number.isInteger(amount) && amount > 0) {
      prices.push({
        plan,
        providerPriceId: priceId,
        currency,
        interval,
        amountMinor: amount,
        displayAmount: format(amount, currency),
        final
      });
      continue;
    }

    // Development provider only: example prices so checkout can be exercised.
    // Always marked non-final, and ignored by any real provider.
    const example = EXAMPLE_DEV_PRICES[plan];
    if (providerName === "fake" && example) {
      prices.push({
        plan,
        providerPriceId: `fake_price_${plan.toLowerCase()}`,
        currency: "usd",
        interval: "month",
        amountMinor: example.amountMinor,
        displayAmount: format(example.amountMinor, "usd"),
        final: false
      });
    }
  }

  return prices;
}

export function priceForPlan(plan: PlanCode, providerName: string | null): PlanPrice | null {
  return configuredPrices(providerName).find((price) => price.plan === plan) ?? null;
}

/** Which plan a provider price charges for — the only way a webhook decides a plan. */
export function planForPriceId(priceId: string, providerName: string | null): PlanCode | null {
  return configuredPrices(providerName).find((price) => price.providerPriceId === priceId)?.plan ?? null;
}

/** Starter is free unless someone configures a price for it. */
export function starterIsFree(providerName: string | null): boolean {
  return priceForPlan("STARTER", providerName) === null;
}

export function trialDays(env: NodeJS.ProcessEnv = process.env): number | null {
  const days = Number(env.VEYRA_BILLING_TRIAL_DAYS);
  return Number.isInteger(days) && days > 0 ? days : null;
}
