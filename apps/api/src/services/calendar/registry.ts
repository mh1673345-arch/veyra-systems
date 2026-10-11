import { currentEnvironment } from "../../config/database.js";
import { FakeCalendarProvider } from "./providers/fakeProvider.js";
import { GoogleCalendarProvider, googleOAuthConfig } from "./providers/googleProvider.js";
import { type CalendarProvider, type CalendarProviderName, CalendarProviderError } from "./types.js";

/**
 * Which provider implementation backs a stored connection.
 *
 * The fake provider is a real, registered provider — that is what lets
 * business-flow tests and the local demo run the genuine CalendarService code
 * path — but it is refused outside development and test, so a production
 * business can never be "connected" to an imaginary calendar.
 */

/** The single fake instance. Tests and the dev connect script configure this. */
export const fakeCalendarProvider = new FakeCalendarProvider();

export function calendarProviderFor(name: string): CalendarProvider {
  if (name === "fake") {
    if (currentEnvironment() === "production") {
      throw new CalendarProviderError("rejected", "The fake calendar provider is not available in production.");
    }
    return fakeCalendarProvider;
  }

  if (name === "google") {
    const config = googleOAuthConfig();
    if (!config) {
      throw new CalendarProviderError(
        "rejected",
        "Google Calendar is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI."
      );
    }
    return new GoogleCalendarProvider(config);
  }

  throw new CalendarProviderError("rejected", `Unknown calendar provider "${name}".`);
}

/** Providers an operator may connect in this environment. */
export function connectableProviders(env: NodeJS.ProcessEnv = process.env): CalendarProviderName[] {
  const providers: CalendarProviderName[] = [];
  if (googleOAuthConfig(env)) providers.push("google");
  if (currentEnvironment() !== "production") providers.push("fake");
  return providers;
}
