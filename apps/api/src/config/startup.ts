import { currentEnvironment, describeDatabaseUrl } from "./database.js";
import { leaseConfig } from "../services/notifications/lease.js";
import { encryptionConfigured } from "../services/crypto/secretBox.js";
import { googleOAuthConfig } from "../services/calendar/providers/googleProvider.js";
import {
  type EmailProviderKind,
  resolveEmailProviderChoice
} from "../services/notifications/providers.js";

/**
 * Startup configuration validation.
 *
 * Anything required for safe operation fails loudly. Optional integrations are
 * reported as disabled or degraded rather than crashing the process — Reception
 * stays useful without Anthropic, and the dashboard stays useful without email.
 */

export class ConfigurationError extends Error {}

export interface ConfigReport {
  environment: string;
  /** Optional integrations and their real state. */
  anthropic: "configured" | "disabled";
  /** The provider that will actually be used, not a guess from NODE_ENV. */
  email: EmailProviderKind;
  warnings: string[];
}

export function validateStartupConfig(): ConfigReport {
  const environment = currentEnvironment();
  const warnings: string[] = [];
  const problems: string[] = [];

  if (!process.env.DATABASE_URL) {
    problems.push("DATABASE_URL is not set.");
  }

  try {
    leaseConfig();
  } catch (err) {
    problems.push(err instanceof Error ? err.message : "Invalid notification lease configuration.");
  }

  if (!process.env.VEYRA_API_KEY) {
    warnings.push(
      "VEYRA_API_KEY is not set — the public reception demo endpoints are unauthenticated."
    );
  }

  // Calendar OAuth tokens are only ever stored encrypted, so a server that can
  // accept a connection must have a key. Production always needs one.
  const googleConfigured = googleOAuthConfig() !== null;
  if (!encryptionConfigured()) {
    if (environment === "production" || googleConfigured) {
      problems.push(
        "VEYRA_ENCRYPTION_KEY is not set, so calendar tokens cannot be stored encrypted. " +
          "Generate one with `openssl rand -base64 32`."
      );
    } else {
      warnings.push(
        "VEYRA_ENCRYPTION_KEY is not set — calendar connections are unavailable until it is."
      );
    }
  }
  if (!googleConfigured) {
    warnings.push(
      "Google Calendar is not configured (GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI) — businesses cannot connect a calendar."
    );
  }

  if (environment === "production") {
    // Session cookies are Secure in production, so they simply will not be sent
    // over plain HTTP. An origin must be pinned because CORS runs with credentials.
    const origin = process.env.VEYRA_WEB_ORIGIN;
    if (!origin) {
      problems.push(
        "VEYRA_WEB_ORIGIN must be set in production: CORS runs with credentials and cannot use a wildcard origin."
      );
    } else if (!origin.split(",").every((entry) => entry.trim().startsWith("https://"))) {
      problems.push(
        "VEYRA_WEB_ORIGIN must use https:// in production — session cookies are Secure and will not be sent over http."
      );
    }

    if (!process.env.VEYRA_API_KEY) {
      problems.push("VEYRA_API_KEY must be set in production.");
    }

    const database = describeDatabaseUrl(process.env.DATABASE_URL ?? "");
    if (database.engine === "sqlite") {
      problems.push("A file-backed SQLite DATABASE_URL is not supported in production.");
    } else if (database.engine !== "postgresql" && process.env.DATABASE_URL) {
      problems.push("DATABASE_URL must be a PostgreSQL URL in production.");
    }
    if (database.role === "test") {
      problems.push("DATABASE_URL names a test database (…_test), which the suite resets destructively.");
    }
    if (database.role === "development") {
      problems.push("DATABASE_URL names a development database (…_dev); production needs its own database.");
    }
  }

  // The banner reports the provider that will really be used. Saying
  // "configured" because NODE_ENV is not production told an operator nothing
  // about whether a single email could leave the building.
  const emailChoice = resolveEmailProviderChoice();
  const email = emailChoice.kind;
  if (environment === "production" && (process.env.VEYRA_EMAIL_PROVIDER ?? "").trim().toLowerCase() === "console") {
    // Asking for the capture provider in production is a misconfiguration, not
    // merely an absence: refuse to boot rather than silently drop every email.
    problems.push(
      "VEYRA_EMAIL_PROVIDER=console captures mail instead of sending it and must not be used in production."
    );
  } else if (email === "unconfigured") {
    warnings.push(
      `Email notifications will be recorded as failed. ${emailChoice.reason ?? ""}`.trim()
    );
  } else if (email === "console") {
    warnings.push(
      "Email uses the development console provider — messages are captured in the log, not delivered."
    );
  }

  if (problems.length > 0) {
    throw new ConfigurationError(
      `Unsafe configuration for ${environment}:\n- ${problems.join("\n- ")}`
    );
  }

  const anthropic = process.env.ANTHROPIC_API_KEY ? "configured" : "disabled";
  if (anthropic === "disabled") {
    warnings.push(
      "ANTHROPIC_API_KEY is not set — Reception answers with the deterministic responder."
    );
  }

  return { environment, anthropic, email, warnings };
}
