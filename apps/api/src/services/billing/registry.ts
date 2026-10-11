import { currentEnvironment } from "../../config/database.js";
import { FakeBillingProvider } from "./providers/fakeBilling.js";
import { StripeBillingProvider, stripeConfig } from "./providers/stripeBilling.js";
import type { BillingProvider, BillingProviderName } from "./types.js";

/**
 * Which billing provider this deployment uses.
 *
 *   VEYRA_BILLING_PROVIDER=stripe  requires STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET
 *   VEYRA_BILLING_PROVIDER=fake    development/test only — refused in production
 *
 * Unset (or misconfigured) means no billing: the Console shows plans but cannot
 * sell them, and nothing pretends otherwise.
 */

/** The single development provider instance; tests and dev endpoints drive it. */
export const fakeBillingProvider = new FakeBillingProvider();

export function configuredProviderName(env: NodeJS.ProcessEnv = process.env): BillingProviderName | null {
  const name = env.VEYRA_BILLING_PROVIDER;
  if (name === "stripe" && stripeConfig(env)) return "stripe";
  if (name === "fake" && currentEnvironment(env.NODE_ENV) !== "production") return "fake";
  return null;
}

/** The active provider, or null when billing isn't configured. */
export function billingProvider(env: NodeJS.ProcessEnv = process.env): BillingProvider | null {
  switch (configuredProviderName(env)) {
    case "stripe":
      return new StripeBillingProvider(stripeConfig(env)!);
    case "fake":
      return fakeBillingProvider;
    default:
      return null;
  }
}

/** For webhooks, which name their provider in the URL. The fake is never served in production. */
export function billingProviderByName(name: string, env: NodeJS.ProcessEnv = process.env): BillingProvider | null {
  if (name === "fake") {
    return currentEnvironment(env.NODE_ENV) === "production" ? null : fakeBillingProvider;
  }
  if (name === "stripe") {
    const config = stripeConfig(env);
    return config ? new StripeBillingProvider(config) : null;
  }
  return null;
}
